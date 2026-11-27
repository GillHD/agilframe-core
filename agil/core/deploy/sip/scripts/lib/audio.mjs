/**
 * Local SIP lab — WAV analysis for the RTP proof.
 *
 * Asterisk's MixMonitor writes 8 kHz, 16-bit signed PCM, mono `.wav` files.
 * "The file exists and is non-zero" is not proof that media flowed: the RTP
 * path can be one-way, or the prompt can be missing. So the lab computes RMS /
 * peak / active-speaking time per file and asserts that both the received (rx)
 * and transmitted (tx) streams carried audio.
 *
 * File naming from asterisk/extensions.conf:
 *   a-rx/*, a-tx/*  leg A (plays demo-congrats)
 *   b-rx/*, b-tx/*  leg B (plays hello-world)
 *   in-rx/*, in-tx/* the manual inbound helper (extension 900)
 */
import { readFileSync, statSync } from 'node:fs';

const PCM_SILENCE_DBFS = -60;

/** Parses a RIFF/WAVE file header; returns format + `data` chunk bounds. */
export function parseWavHeader(buffer) {
  if (buffer.length < 44) throw new Error('WAV too short');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // Asterisk/MixMonitor writes a placeholder data size while recording is
      // in progress (0 or 0xFFFFFFFF); fall back to the bytes actually present.
      const available = buffer.length - body;
      data = { offset: body, size: size === 0 || size > available ? available : size };
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!format) throw new Error('WAV has no fmt chunk');
  if (!data) throw new Error('WAV has no data chunk');
  return { format, data };
}

function toDbfs(amplitude, fullScale) {
  if (amplitude <= 0) return -Infinity;
  return 20 * Math.log10(amplitude / fullScale);
}

/**
 * Measures one WAV file.
 * - `rmsDbfs` / `peakDbfs` are relative to full scale (0 dBFS).
 * - `activeSec` counts 20 ms windows above the silence threshold, i.e. time
 *   where actual audio was present (a prompt or a remote participant).
 */
export function analyzeWav(file) {
  const buffer = readFileSync(file);
  const { format, data } = parseWavHeader(buffer);
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error(
      `unsupported WAV format in ${file}: format=${format.audioFormat} bits=${format.bitsPerSample} (expected 16-bit PCM)`,
    );
  }
  const channels = Math.max(1, format.channels);
  const frameBytes = 2 * channels;
  const frames = Math.floor(data.size / frameBytes);
  const sampleRate = format.sampleRate;
  const threshold = 10 ** (PCM_SILENCE_DBFS / 20) * 32768;
  let sumSquares = 0;
  let peak = 0;
  let activeFrames = 0;
  const windowFrames = Math.max(1, Math.round(sampleRate * 0.02));
  let windowSquares = 0;
  let windowCount = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let value = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      value += buffer.readInt16LE(data.offset + frame * frameBytes + channel * 2);
    }
    value /= channels;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sumSquares += value * value;
    windowSquares += value * value;
    windowCount += 1;
    if (windowCount >= windowFrames) {
      const windowRms = Math.sqrt(windowSquares / windowCount);
      if (windowRms >= threshold) activeFrames += windowCount;
      windowSquares = 0;
      windowCount = 0;
    }
  }
  if (windowCount > 0) {
    const windowRms = Math.sqrt(windowSquares / windowCount);
    if (windowRms >= threshold) activeFrames += windowCount;
  }
  const rms = frames > 0 ? Math.sqrt(sumSquares / frames) : 0;
  return {
    file,
    bytes: statSync(file).size,
    sampleRate,
    channels,
    durationSec: sampleRate > 0 ? frames / sampleRate : 0,
    activeSec: sampleRate > 0 ? activeFrames / sampleRate : 0,
    rmsDbfs: toDbfs(rms, 32768),
    peakDbfs: toDbfs(peak, 32768),
    silent: toDbfs(rms, 32768) < PCM_SILENCE_DBFS,
  };
}

/** `true` when the file carries more than `minActiveSec` of non-silent audio. */
export function hasAudio(file, { minActiveSec = 0.4, minRmsDbfs = -45 } = {}) {
  try {
    const metrics = analyzeWav(file);
    return metrics.activeSec >= minActiveSec && metrics.rmsDbfs >= minRmsDbfs;
  } catch {
    return false;
  }
}

/** Goertzel power of one frequency over a PCM sample array. */
function goertzelPower(samples, sampleRate, frequency) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let previous = 0;
  let previous2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index] + coeff * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  return previous * previous + previous2 * previous2 - coeff * previous * previous2;
}

/**
 * Detects which of `candidates` dominates a recording. The lab prompts are pure
 * tones (440 Hz leg A, 880 Hz leg B, 1000 Hz beep), so this proves *which*
 * leg's audio crossed the SFU, not merely that some audio exists.
 */
export function analyzeTones(file, candidates = [440, 880, 1000]) {
  const buffer = readFileSync(file);
  const { format, data } = parseWavHeader(buffer);
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error(`unsupported WAV format in ${file} (expected 16-bit PCM)`);
  }
  const channels = Math.max(1, format.channels);
  const frames = Math.floor(data.size / (2 * channels));
  // 1 in 4 samples is plenty for a tone estimate and keeps this fast.
  const step = frames > 40000 ? 4 : 1;
  const samples = new Float64Array(Math.ceil(frames / step));
  let cursor = 0;
  for (let frame = 0; frame < frames; frame += step) {
    let value = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      value += buffer.readInt16LE(data.offset + (frame * channels + channel) * 2);
    }
    samples[cursor] = value / channels;
    cursor += 1;
  }
  const powers = {};
  for (const frequency of candidates) {
    powers[frequency] = goertzelPower(samples.subarray(0, cursor), format.sampleRate / step, frequency);
  }
  const best = candidates.reduce((top, frequency) => (powers[frequency] > powers[top] ? frequency : top), candidates[0]);
  return { file, dominant: best, powers, durationSec: frames / format.sampleRate };
}

/** True when the recording is dominated by `expectedHz` (within `toleranceHz`). */
export function isTone(file, expectedHz, toleranceHz = 25) {
  const candidates = [...new Set([440, 880, 1000, expectedHz])].sort((a, b) => a - b);
  return Math.abs(analyzeTones(file, candidates).dominant - expectedHz) <= toleranceHz;
}

/** Human-readable one-line summary used in the e2e log. */
export function describeWav(file) {
  const metrics = analyzeWav(file);
  const db = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : '-inf');
  const tone = analyzeTones(file, [440, 880, 1000]);
  return `${metrics.durationSec.toFixed(1)} s, active ${metrics.activeSec.toFixed(1)} s, rms ${db(metrics.rmsDbfs)}, peak ${db(metrics.peakDbfs)}, dominant ~${tone.dominant} Hz`;
}
