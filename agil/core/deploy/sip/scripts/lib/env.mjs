/**
 * Local SIP lab — environment resolution.
 *
 * Reads `deploy/sip/.env` (the same file docker-compose.yml uses) without
 * evaluating it, then lets process.env win. Nothing here is a production
 * secret: the values are lab keys committed in `.env.example`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** `scripts/lib` -> the lab directory (`agil/core/deploy/sip`). */
export const LAB_DIR = path.resolve(SCRIPT_DIR, '..', '..');
export const REPO_ROOT = path.resolve(LAB_DIR, '..', '..', '..', '..');

/** Parses KEY=VALUE / KEY="VALUE" lines; comments and blank lines are skipped. */
export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadDotEnv(file = path.join(LAB_DIR, '.env')) {
  if (!existsSync(file)) return {};
  return parseDotEnv(readFileSync(file, 'utf8'));
}

function pick(env, names, fallback) {
  for (const name of names) {
    const fromProcess = process.env[name];
    if (typeof fromProcess === 'string' && fromProcess.trim()) return fromProcess.trim();
    const fromFile = env[name];
    if (typeof fromFile === 'string' && fromFile.trim()) return fromFile.trim();
  }
  return fallback;
}

/**
 * Everything the lab scripts need. `LIVEKIT_API_KEY`/`SECRET` are the same pair
 * the containers use; the app server must be started with `AGIL_SIP_*` pointing
 * at the same LiveKit (`AGIL_SIP_URL=http://127.0.0.1:7880`).
 */
export function resolveLabEnv() {
  const file = loadDotEnv();
  const apiKey = pick(file, ['LIVEKIT_API_KEY', 'AGIL_SIP_API_KEY'], '');
  const apiSecret = pick(file, ['LIVEKIT_API_SECRET', 'AGIL_SIP_API_SECRET'], '');
  const outboundTls = pick(file, ['LAB_SIP_OUTBOUND_TLS'], '0') === '1';
  return {
    livekitUrl: pick(file, ['LIVEKIT_URL', 'AGIL_SIP_URL'], 'http://127.0.0.1:7880').replace(/\/+$/, ''),
    apiKey,
    apiSecret,
    appUrl: pick(file, ['AGIL_APP_URL', 'AGIL_PUBLIC_ORIGIN'], 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    adminKey: pick(file, ['AGIL_ADMIN_KEY'], 'dev-key'),
    tenant: pick(file, ['AGIL_LAB_TENANT'], 'demo'),
    ami: {
      host: pick(file, ['ASTERISK_AMI_HOST'], '127.0.0.1'),
      port: Number(pick(file, ['ASTERISK_AMI_PORT'], '5038')),
      username: pick(file, ['ASTERISK_AMI_USER'], 'agil'),
      secret: pick(file, ['ASTERISK_AMI_SECRET'], 'agil-lab-ami'),
    },
    recordingsDir: pick(file, ['LAB_RECORDINGS_DIR'], path.join(LAB_DIR, 'recordings')),
    asteriskLog: pick(file, ['LAB_ASTERISK_LOG'], path.join(LAB_DIR, 'logs', 'asterisk', 'full')),
    outboundTrunk: {
      name: pick(file, ['LAB_OUTBOUND_TRUNK_NAME'], outboundTls ? 'agil-lab-outbound-tls' : 'agil-lab-outbound'),
      address: pick(file, ['LAB_OUTBOUND_TRUNK_ADDRESS'], outboundTls ? '127.0.0.1:5061' : '127.0.0.1:5060'),
      // The app sends this as From (`callerId`); keep it in the trunk numbers.
      numbers: [pick(file, ['LAB_CALLER_ID'], '+15550000000')],
      transport: outboundTls ? 'SIP_TRANSPORT_TLS' : 'SIP_TRANSPORT_UDP',
      ...(outboundTls ? { media_encryption: 'SIP_MEDIA_ENCRYPT_REQUIRE' } : {}),
    },
    inboundTrunk: {
      name: pick(file, ['LAB_INBOUND_TRUNK_NAME'], 'agil-lab-inbound'),
      requireSrtp: pick(file, ['LAB_SIP_INBOUND_TLS'], '0') === '1',
      // 600 is reserved for the e2e inbound test (it creates an ephemeral trunk
      // so the call can be dispatched into the app room). LiveKit rejects two
      // inbound trunks with the same number, hence 601/602 for manual tests.
      numbers: pick(file, ['LAB_INBOUND_NUMBERS'], '601,602')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      allowedAddresses: pick(file, ['LAB_INBOUND_ALLOWED'], '127.0.0.1/32')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    },
    numbers: {
      rtpA: pick(file, ['LAB_RTP_A_NUMBER'], '+15550100'),
      dtmf: pick(file, ['LAB_DTMF_NUMBER'], '+15550101'),
      rtpB: pick(file, ['LAB_RTP_B_NUMBER'], '+15550102'),
      appInbound: pick(file, ['LAB_APP_INBOUND'], '600'),
    },
  };
}

/** Throws a readable error when the LiveKit keys are missing. */
export function requireLiveKitKeys(config) {
  const missing = [];
  if (!config.apiKey) missing.push('LIVEKIT_API_KEY');
  if (!config.apiSecret) missing.push('LIVEKIT_API_SECRET');
  if (missing.length > 0) {
    throw new Error(
      `missing ${missing.join(', ')} — run "cp .env.example .env" in agil/core/deploy/sip and retry`,
    );
  }
  return config;
}
