#!/usr/bin/env node
/**
 * Local SIP lab — generate the audio prompts the Asterisk dialplan plays.
 *
 * The `andrius/asterisk` image ships **no** sound files (`/var/lib/asterisk/sounds`
 * is empty), so `Playback(hello-world)` fails and the RTP legs stay silent.
 * Instead of downloading core sounds, the lab generates deterministic PCM tones:
 *
 *   agil-tone-a.wav   440 Hz, 6 s   (RTP leg A)
 *   agil-tone-b.wav   880 Hz, 6 s   (RTP leg B)
 *   agil-tone-beep.wav 1000 Hz, 0.25 s (DTMF leg confirmation)
 *
 * Distinct frequencies make the media proof strong: leg A's *received* stream
 * must be dominated by 880 Hz (B's tone) and B's by 440 Hz (A's tone) — a
 * one-way or crossed RTP path fails the check, a non-silent-but-wrong stream
 * fails too.
 *
 * Files are generated (not committed) into asterisk/sounds, which
 * docker-compose.yml mounts at /var/lib/asterisk/sounds/en.
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAB_DIR } from './lib/env.mjs';

export const SOUNDS_DIR = path.join(LAB_DIR, 'asterisk', 'sounds');
export const TONES = {
  'agil-tone-a.wav': { frequency: 440, durationSec: 6 },
  'agil-tone-b.wav': { frequency: 880, durationSec: 6 },
  'agil-tone-beep.wav': { frequency: 1000, durationSec: 0.25 },
};

/** Builds an 8 kHz, mono, 16-bit PCM WAV with a short fade in/out. */
export function buildToneWav({ frequency, durationSec, sampleRate = 8000, amplitude = 0.28 }) {
  const frames = Math.round(sampleRate * durationSec);
  const info = Buffer.alloc(44);
  const dataBytes = frames * 2;
  info.write('RIFF', 0, 'ascii');
  info.writeUInt32LE(36 + dataBytes, 4);
  info.write('WAVE', 8, 'ascii');
  info.write('fmt ', 12, 'ascii');
  info.writeUInt32LE(16, 16); // fmt chunk size
  info.writeUInt16LE(1, 20); // PCM
  info.writeUInt16LE(1, 22); // mono
  info.writeUInt32LE(sampleRate, 24);
  info.writeUInt32LE(sampleRate * 2, 28); // byte rate
  info.writeUInt16LE(2, 32); // block align
  info.writeUInt16LE(16, 34); // bits per sample
  info.write('data', 36, 'ascii');
  info.writeUInt32LE(dataBytes, 40);

  const pcm = Buffer.alloc(dataBytes);
  const fadeFrames = Math.max(1, Math.round(sampleRate * 0.01));
  const peak = Math.round(32767 * amplitude);
  for (let frame = 0; frame < frames; frame += 1) {
    const fadeIn = Math.min(1, frame / fadeFrames);
    const fadeOut = Math.min(1, (frames - frame) / fadeFrames);
    const envelope = Math.min(fadeIn, fadeOut);
    const value = Math.round(peak * envelope * Math.sin((2 * Math.PI * frequency * frame) / sampleRate));
    pcm.writeInt16LE(value, frame * 2);
  }
  return Buffer.concat([info, pcm]);
}

/** Writes all prompts if missing (or `force`); returns the directory. */
export function ensureTones({ force = false } = {}) {
  mkdirSync(SOUNDS_DIR, { recursive: true });
  for (const [name, spec] of Object.entries(TONES)) {
    const file = path.join(SOUNDS_DIR, name);
    if (!force && existsSync(file) && statSync(file).size > 44) continue;
    writeFileSync(file, buildToneWav(spec));
  }
  return SOUNDS_DIR;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dir = ensureTones({ force: process.argv.includes('--force') });
  process.stdout.write(`SIP lab tones written to ${dir}\n`);
  for (const name of Object.keys(TONES)) {
    const file = path.join(dir, name);
    process.stdout.write(`  ${name} (${statSync(file).size} bytes)\n`);
  }
}
