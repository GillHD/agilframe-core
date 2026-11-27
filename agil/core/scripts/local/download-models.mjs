#!/usr/bin/env node
/**
 * Downloads the *optional* local STT / machine-translation models used by
 * `STT_PROVIDER=local` and `TRANSLATE_PROVIDER=local`.
 *
 * Nothing here is bundled with AgilFrame and nothing is downloaded unless the
 * script is run explicitly. Weights are git-ignored (see `agil/core/models/`),
 * so a clean checkout stays small and CI never fetches a multi-GB model.
 *
 * Examples (from the repository root):
 *   node agil/core/scripts/local/download-models.mjs --asr small
 *   node agil/core/scripts/local/download-models.mjs --mt pair
 *   node agil/core/scripts/local/download-models.mjs --mt pair --check
 *
 * Approved upstream weights: Whisper (MIT), OPUS-MT ru-en (CC BY 4.0)
 * and en-ru (Apache-2.0). See docs/model-licenses.md.
 *
 * Requirements: Node.js >= 20 (global fetch). No npm dependencies.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_WHISPER_DIR = path.join(CORE_DIR, 'models', 'whisper');
const DEFAULT_TRANSLATE_DIR = path.join(CORE_DIR, 'models', 'translate');

/** Approximate download sizes, shown to the operator before a long download. */
const WHISPER_SIZES = {
  tiny: '~75 MB',
  base: '~142 MB',
  small: '~466 MB',
  medium: '~1.5 GB',
  'large-v3': '~3.1 GB',
};
const WHISPER_REPO = 'ggerganov/whisper.cpp';
const WHISPER_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const WHISPER_SHA256 = {
  tiny: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  base: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  small: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  medium: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
  'large-v3': '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
};
const OPUS_PAIRS = {
  'ru-en': {
    repo: 'Helsinki-NLP/opus-mt-ru-en',
    revision: 'fbd6dc73284f95536648512cc21d57f19191961a',
    sha256: '535450eb5613f3cc912f9ca3e54cfef6c14d201b319c24a88faf776a65538b5d',
    license: '[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)',
  },
  'en-ru': {
    repo: 'Helsinki-NLP/opus-mt-en-ru',
    revision: 'bb09c99d180016eac6819df3dae68edb1690fdee',
    sha256: 'd15fa58c6bc3efd3629c1b6b86d9aa6d15d2751a4620aa4cdd7eed7b5cbe583b',
    license: '[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)',
  },
};
const OPUS_FILES = [
  'config.json', 'generation_config.json', 'pytorch_model.bin',
  'source.spm', 'target.spm', 'tokenizer_config.json', 'vocab.json',
];

function usage() {
  return `Usage: node agil/core/scripts/local/download-models.mjs [options]

Options:
  --asr <size>       Download a whisper.cpp ggml model (${Object.keys(WHISPER_SIZES).join(', ')}).
  --mt pair         Download the pinned OPUS-MT ru-en and en-ru weights.
  --asr-dir <dir>    ASR output directory (default: ${DEFAULT_WHISPER_DIR}).
  --mt-dir <dir>     Translation output directory (default: ${DEFAULT_TRANSLATE_DIR}).
  --force            Re-download files that already exist.
  --check            Only verify what is already on disk; never downloads.
  -h, --help         Show this help.

Environment:
  HF_TOKEN           Optional token for gated/private HuggingFace repositories.

The script never runs a model and never touches the server; it only downloads
weights into git-ignored directories.`;
}

function parseArgs(argv) {
  const options = {
    asr: null,
    mt: null,
    asrDir: DEFAULT_WHISPER_DIR,
    mtDir: DEFAULT_TRANSLATE_DIR,
    force: false,
    check: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--asr': {
        const size = next();
        if (!(size in WHISPER_SIZES)) throw new Error(`unknown ASR size "${size}"; use ${Object.keys(WHISPER_SIZES).join(', ')}`);
        options.asr = size;
        break;
      }
      case '--mt': {
        const mode = next();
        if (mode === 'nllb') throw new Error('NLLB-200 (CC-BY-NC-4.0) is retired. Use --mt pair.');
        if (mode !== 'pair') throw new Error('--mt expects "pair"');
        options.mt = mode;
        break;
      }
      case '--asr-dir':
        options.asrDir = path.resolve(next());
        break;
      case '--mt-dir':
        options.mtDir = path.resolve(next());
        break;
      case '--force':
        options.force = true;
        break;
      case '--check':
        options.check = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option "${arg}"`);
    }
  }
  return options;
}

async function fileSize(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Streams one URL to `destination` through a `.part` file (atomic rename). */
async function download(url, destination, { force = false, token, sha256 } = {}) {
  const existing = await fileSize(destination);
  if (existing > 0 && !force) {
    if (sha256 && await fileSha256(destination) !== sha256) {
      throw new Error(`SHA-256 mismatch for ${destination}; use --force to download the approved file.`);
    }
    console.log(`  = ${path.basename(destination)} (${formatBytes(existing)}, already present)`);
    return { skipped: true, bytes: existing };
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  await rm(temporary, { force: true });
  const headers = { 'user-agent': 'agilframe-model-downloader' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} for ${url}${response.status === 401 || response.status === 403 ? ' (set HF_TOKEN if the repository is gated)' : ''}`);
  }
  const expected = Number(response.headers.get('content-length') ?? 0) || 0;
  console.log(`  ↓ ${path.basename(destination)}${expected > 0 ? ` (${formatBytes(expected)})` : ''}`);
  let received = 0;
  const hash = sha256 ? createHash('sha256') : undefined;
  const source = Readable.fromWeb(response.body);
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      hash?.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, createWriteStream(temporary));
    if (received === 0 || (expected > 0 && received !== expected)) {
      throw new Error(`incomplete download for ${url}: ${received}/${expected} bytes`);
    }
    if (hash && hash.digest('hex') !== sha256) throw new Error(`SHA-256 mismatch for ${url}`);
    await rename(temporary, destination);
    return { skipped: false, bytes: received };
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Downloads the whisper.cpp ggml model for `size`. */
async function downloadWhisper(size, directory, options) {
  const file = path.join(directory, `ggml-${size}.bin`);
  const url = `https://huggingface.co/${WHISPER_REPO}/resolve/main/ggml-${size}.bin`;
  console.log(`whisper.cpp ${size} (${WHISPER_SIZES[size]}) -> ${file}`);
  const result = await download(url, file, { ...options, sha256: WHISPER_SHA256[size] });
  return { file, result };
}

async function downloadPair(options) {
  const notices = ['# OPUS-MT model notices', ''];
  for (const [direction, model] of Object.entries(OPUS_PAIRS)) {
    const directory = path.join(options.mtDir, direction);
    const source = `https://huggingface.co/${model.repo}/tree/${model.revision}`;
    console.log(`${model.repo}@${model.revision} -> ${directory}`);
    for (const name of OPUS_FILES) {
      const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${name}`;
      await download(url, path.join(directory, name), {
        ...options,
        ...(name === 'pytorch_model.bin' ? { sha256: model.sha256 } : {}),
      });
    }
    notices.push(
      `- [${model.repo}](${source}) by Helsinki-NLP (University of Helsinki). Licence: ${model.license}.`,
      `  Upstream \`pytorch_model.bin\` SHA-256: \`${model.sha256}\`. Weights are unmodified.`,
    );
  }
  await writeFile(path.join(options.mtDir, 'MODEL-NOTICE.md'), notices.join('\n') + '\n', 'utf8');
  return { directory: options.mtDir };
}

function describeAsr(result) {
  return [
    '',
    'Configure the server:',
    '  STT_PROVIDER=local',
    '  STT_LOCAL_ENGINE=whisper-cpp',
    `  STT_LOCAL_MODEL_PATH=${result.file}`,
    '',
    'whisper.cpp also needs the `whisper-cli` binary and `ffmpeg` on PATH',
    '(browser chunks are webm/opus and must be converted to 16 kHz WAV).',
  ].join('\n');
}

function describeTranslatePair(result) {
  return [
    '',
    'Configure the server:',
    '  TRANSLATE_PROVIDER=local',
    '  TRANSLATE_LOCAL_ENGINE=opus-mt',
    `  TRANSLATE_LOCAL_MODEL_DIR=${result.directory}`,
    '',
    'Keep MODEL-NOTICE.md with the weights. RU→EN is CC BY 4.0; EN→RU is Apache-2.0.',
  ].join('\n');
}

async function check(options) {
  const checks = [];
  if (options.asr) {
    const file = path.join(options.asrDir, `ggml-${options.asr}.bin`);
    const ok = await fileSize(file) > 0 && await fileSha256(file) === WHISPER_SHA256[options.asr];
    checks.push({ label: `ASR ${options.asr}`, file, ok });
  }
  if (options.mt === 'pair') {
    for (const [direction, model] of Object.entries(OPUS_PAIRS)) {
      const directory = path.join(options.mtDir, direction);
      const sizes = await Promise.all(OPUS_FILES.map((name) => fileSize(path.join(directory, name))));
      const ok = sizes.every((size) => size > 0) &&
        await fileSha256(path.join(directory, 'pytorch_model.bin')) === model.sha256;
      checks.push({ label: `MT ${direction}`, file: directory, ok });
    }
  }
  if (checks.length === 0) console.log('Nothing to check: pass --asr <size> and/or --mt pair with --check.');
  for (const entry of checks) {
    console.log(`${entry.ok ? 'OK (SHA-256 verified)' : 'MISS (missing file or SHA-256 mismatch)'} ${entry.label}: ${entry.file}`);
  }
  return checks.every((entry) => entry.ok) ? 0 : 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.asr && !options.mt && !options.check)) {
    console.log(usage());
    return 0;
  }
  options.token = process.env.HF_TOKEN ?? '';
  if (options.check) return check(options);
  const summaries = [];
  if (options.asr) summaries.push(describeAsr(await downloadWhisper(options.asr, options.asrDir, options)));
  if (options.mt === 'pair') summaries.push(describeTranslatePair(await downloadPair(options)));
  console.log(summaries.join('\n'));
  console.log('\nModels are git-ignored; no weights are committed to the repository.');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`\nModel download failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
