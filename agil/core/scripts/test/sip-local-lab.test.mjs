/**
 * Static + unit contract for the local SIP/PSTN lab (LiveKit SIP + Asterisk).
 *
 * The lab itself needs Docker Engine with host networking; this test is the CI
 * gate that the committed lab is complete and internally consistent even where
 * no Docker daemon exists: images pinned, ports/RTP ranges aligned, Asterisk
 * configs wired to the compose mounts, the dialplan/tones/AMI/trunk scripts
 * present, no secrets committed, and the runbook documents evidence + limits.
 *
 * It also exercises the WAV tone analyzer that the e2e uses for its media
 * proof, so a broken analyzer fails here instead of silently "passing" a
 * one-way RTP path.
 *
 * Run: node --test agil/core/scripts/test/sip-local-lab.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToneWav } from '../../deploy/sip/scripts/gen-tones.mjs';
import { analyzeTones, analyzeWav, hasAudio } from '../../deploy/sip/scripts/lib/audio.mjs';
import { parseDotEnv } from '../../deploy/sip/scripts/lib/env.mjs';
import { ensureOutboundTrunk } from '../../deploy/sip/scripts/lib/livekit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(relative) {
  const full = path.join(ROOT, relative);
  assert.ok(existsSync(full), `missing file: ${relative}`);
  return readFileSync(full, 'utf8');
}

const compose = read('agil/core/deploy/sip/docker-compose.yml');
const livekitYaml = read('agil/core/deploy/sip/livekit.yaml');
const envExample = read('agil/core/deploy/sip/.env.example');
const pjsip = read('agil/core/deploy/sip/asterisk/pjsip.conf');
const extensions = read('agil/core/deploy/sip/asterisk/extensions.conf');
const rtp = read('agil/core/deploy/sip/asterisk/rtp.conf');
const manager = read('agil/core/deploy/sip/asterisk/manager.conf');
const logger = read('agil/core/deploy/sip/asterisk/logger.conf');
const modules = read('agil/core/deploy/sip/asterisk/modules.conf');
const labUp = read('agil/core/deploy/sip/scripts/lab-up.sh');
const labDown = read('agil/core/deploy/sip/scripts/lab-down.sh');
const labInit = read('agil/core/deploy/sip/scripts/lab-init.mjs');
const e2e = read('agil/core/deploy/sip/scripts/e2e.mjs');
const genTones = read('agil/core/deploy/sip/scripts/gen-tones.mjs');
const amiLib = read('agil/core/deploy/sip/scripts/lib/ami.mjs');

test('secure SIP lab refuses to reuse a trunk without required media encryption', async (t) => {
  const config = { livekitUrl: 'http://127.0.0.1:1', apiKey: 'lab-key', apiSecret: 'lab-secret' };
  const spec = { name: 'lab-tls', address: '127.0.0.1:5061', transport: 'SIP_TRANSPORT_TLS', media_encryption: 'SIP_MEDIA_ENCRYPT_REQUIRE' };
  const trunk = { ...spec, sip_trunk_id: 'ST_test', media_encryption: 'SIP_MEDIA_ENCRYPT_ALLOW' };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ items: [trunk] }));
  await assert.rejects(ensureOutboundTrunk(config, spec), /does not require TLS and SRTP/);
  trunk.media_encryption = spec.media_encryption;
  assert.equal((await ensureOutboundTrunk(config, spec)).id, trunk.sip_trunk_id);
});
const livekitLib = read('agil/core/deploy/sip/scripts/lib/livekit.mjs');
const docs = read('agil/core/docs/sip-local-lab.md');
const sipDoc = read('agil/core/docs/sip.md');

test('compose: pinned images, host networking, one stack, healthchecks, log rotation', () => {
  for (const service of ['redis:', 'livekit:', 'sip:', 'asterisk:']) {
    assert.match(compose, new RegExp(`^  ${service}`, 'm'), `compose service ${service}`);
  }
  assert.match(compose, /^name: agil-sip-lab$/m);
  // Host networking is required by the SIP/RTP peers; all four services use it.
  assert.equal((compose.match(/network_mode:\s*host/g) ?? []).length, 4, 'every service uses host networking');
  for (const pin of [
    'livekit/livekit-server:v1.13.11',
    'livekit/sip:v1.24',
    'redis:7-alpine',
    'andrius/asterisk:20.7-cert12_debian-trixie',
  ]) {
    assert.ok(compose.includes(pin), `image pin ${pin}`);
  }
  // Keys from env, never in the YAML/committed config.
  assert.match(compose, /LIVEKIT_KEYS:\s*"\$\{LIVEKIT_API_KEY:\?/);
  assert.match(compose, /api_key:\s*'\$\{LIVEKIT_API_KEY:\?/);
  assert.match(compose, /api_secret:\s*'\$\{LIVEKIT_API_SECRET:\?/);
  // Readiness probes for the three long-running daemons.
  assert.match(compose, /redis-cli", "-p", "6385", "ping"/);
  assert.match(compose, /\/livekit-server", "--help"/);
  assert.match(compose, /asterisk -rx 'core show uptime'/);
  assert.match(compose, /max-size:\s*"10m"/);
  // No floating tags.
  for (const line of compose.split('\n')) {
    const match = /^\s+image:\s*(\S+)/.exec(line);
    if (!match) continue;
    assert.doesNotMatch(match[1], /:latest$/, `floating tag: ${line.trim()}`);
  }
});

test('compose: SIP worker config and Asterisk mounts line up with the lab files', () => {
  assert.match(compose, /SIP_CONFIG_BODY:/);
  assert.match(compose, /sip_port:\s*5070/);
  assert.match(compose, /health_port:\s*28083/);
  assert.match(labUp, /wait_for "livekit SIP worker" http_ready http:\/\/127\.0\.0\.1:28083\//);
  assert.match(labUp, /wait_for "livekit HTTP" http_ready http:\/\/127\.0\.0\.1:7880\//);
  assert.match(compose, /rtp_port:\s*10000-10100/);
  assert.match(compose, /ws_url:\s*'ws:\/\/127\.0\.0\.1:7880'/);
  assert.match(compose, /address:\s*'127\.0\.0\.1:6385'/);
  assert.match(compose, /use_external_ip:\s*false/);
  assert.match(compose, /media_nat_1_to_1_ip:\s*'127\.0\.0\.1'/);
  assert.match(compose, /PCMU:\s*true/);
  assert.match(compose, /PCMA:\s*true/);
  for (const file of ['pjsip.conf', 'extensions.conf', 'rtp.conf', 'manager.conf', 'logger.conf', 'modules.conf']) {
    assert.ok(existsSync(path.join(ROOT, 'agil/core/deploy/sip/asterisk', file)), `config exists: ${file}`);
    assert.ok(compose.includes(`./asterisk/${file}:/etc/asterisk/${file}:ro`), `compose mounts ${file}`);
  }
  // The image has no sound files; generated tones are mounted for Playback.
  assert.match(compose, /\.\/asterisk\/sounds:\/var\/lib\/asterisk\/sounds\/en:ro/);
  assert.match(compose, /\.\/recordings:\/var\/spool\/asterisk\/monitor/);
  assert.match(compose, /\.\/logs\/asterisk:\/var\/log\/asterisk/);
});

test('livekit.yaml: SFU ports outside the SIP RTP range, no inline keys', () => {
  assert.match(livekitYaml, /^port:\s*7880$/m);
  assert.match(livekitYaml, /tcp_port:\s*7881/);
  assert.match(livekitYaml, /port_range_start:\s*50100/);
  assert.match(livekitYaml, /port_range_end:\s*50200/);
  assert.match(livekitYaml, /address:\s*127\.0\.0\.1:6385/);
  assert.match(livekitYaml, /use_external_ip:\s*false/);
  assert.doesNotMatch(livekitYaml, /api_secret/i, 'keys live in env, not in livekit.yaml');
  assert.doesNotMatch(livekitYaml, /api_key/i);
});

test('pjsip: IP-identified LiveKit peer, G.711 only, local_net on the transport', () => {
  assert.match(pjsip, /\[agil-livekit\]/);
  assert.match(pjsip, /context=from-livekit/);
  assert.match(pjsip, /identify_by=ip/);
  assert.match(pjsip, /match=127\.0\.0\.1\/32/);
  assert.match(pjsip, /allow=ulaw,alaw/);
  assert.match(pjsip, /direct_media=no/);
  assert.match(pjsip, /rtp_symmetric=yes/);
  assert.match(pjsip, /\[agil-sip-out\]/);
  assert.match(pjsip, /contact=sip:127\.0\.0\.1:5070/);
  // Regression: Asterisk 20 rejects `local_net` in [global] (found by running
  // the lab); it must stay on the transport.
  const globalBlock = pjsip.slice(pjsip.indexOf('[global]'), pjsip.indexOf('[transport-udp]'));
  assert.doesNotMatch(globalBlock, /^local_net\s*=/m, 'local_net must not be in [global]');
  const transportBlock = pjsip.slice(pjsip.indexOf('[transport-udp]'), pjsip.indexOf('[agil-livekit]'));
  assert.match(transportBlock, /bind=0\.0\.0\.0:5060/);
  assert.match(transportBlock, /local_net=127\.0\.0\.0\/8/);
  // The lab peer must not use digest auth or registration.
  assert.doesNotMatch(pjsip, /^register\s*=>/m);
  assert.doesNotMatch(pjsip, /outbound_auth/);
});

test('asterisk media: RTP range 16000-16100, AMI loopback with the originate class', () => {
  assert.match(rtp, /rtpstart=16000/);
  assert.match(rtp, /rtpend=16100/);
  assert.match(rtp, /strictrtp=no/);
  assert.match(manager, /bindaddr\s*=\s*127\.0\.0\.1/);
  assert.match(manager, /^port\s*=\s*5038$/m);
  assert.match(manager, /^\[agil\]$/m);
  // Asterisk 20 gates `Action: Originate` behind the `originate` class; without
  // it the e2e inbound phase fails with "Permission denied" (found by running).
  for (const direction of ['read', 'write']) {
    const line = new RegExp(`^${direction}\\s*=\\s*(.+)$`, 'm').exec(manager)?.[1] ?? '';
    assert.match(line, /(^|,)call(,|$)/, `${direction} has call class`);
    assert.match(line, /(^|,)originate(,|$)/, `${direction} has originate class`);
  }
  assert.match(manager, /permit\s*=\s*127\.0\.0\.1\/255\.255\.255\.0/);
  assert.match(manager, /secret\s*=\s*agil-lab-ami/);
  assert.match(logger, /console\s*=>\s*notice,warning,error,verbose/);
  assert.match(logger, /full\s*=>\s*debug/);
  assert.match(modules, /autoload=yes/);
  assert.match(modules, /noload => chan_sip\.so/, 'legacy chan_sip must not fight PJSIP for 5060');
});

test('dialplan: two tone legs, one-argument MixMonitor options, DTMF log, inbound helper', () => {
  assert.match(extensions, /_\+15550100/);
  assert.match(extensions, /_\+15550101/);
  assert.match(extensions, /_\+15550102/);
  assert.match(extensions, /Playback\(agil-tone-a\)/);
  assert.match(extensions, /Playback\(agil-tone-b\)/);
  assert.match(extensions, /Playback\(agil-tone-beep\)/);
  // Regression: MixMonitor takes r(...)t(...) as ONE options argument; a comma
  // between r() and t() makes Asterisk execute t() as a shell command.
  assert.match(extensions, /MixMonitor\(\$\{REC\}\/a-mix-\$\{UNIQUEID\}\.wav,r\([^)]*\)t\([^)]*\)\)/);
  assert.match(extensions, /Read\(DTMF_DIGITS,,8,,1,12\)/);
  assert.match(extensions, /dtmf\.log/);
  assert.match(extensions, /\[lab-inbound\]/);
  assert.match(extensions, /Dial\(PJSIP\/600@agil-sip-out,40\)/);
  assert.match(extensions, /AGIL_LAB_RTP_A_UP/);
  assert.match(extensions, /AGIL_LAB_DTMF/);
});

test('scripts: tones, bring-up, trunks, AMI, twirp helpers and the e2e phases exist', () => {
  assert.match(genTones, /frequency: 440/);
  assert.match(genTones, /frequency: 880/);
  assert.match(genTones, /frequency: 1000/);
  assert.match(genTones, /asterisk', 'sounds'/);
  assert.match(labUp, /docker compose up -d/);
  assert.match(labUp, /gen-tones\.mjs/, 'lab-up generates the tone prompts');
  assert.match(labUp, /asterisk -rx 'core show uptime'/);
  assert.match(labDown, /docker compose down/);
  assert.match(labInit, /ensureOutboundTrunk/);
  assert.match(labInit, /createInboundTrunk/);
  assert.match(labInit, /createIndividualDispatchRule/);
  assert.match(labInit, /\.lab-trunks\.json/);
  assert.match(livekitLib, /sip: \{ admin: true \}/);
  assert.match(livekitLib, /roomAdmin: true/);
  assert.match(livekitLib, /ListParticipants/);
  assert.match(amiLib, /Action: \$\{name\}/);
  assert.match(amiLib, /Originate/);
  assert.match(amiLib, /Command/);
  for (const phase of [
    'RTP — bidirectional',
    'DTMF',
    'list + stop',
    'inbound —',
    'trunk-down',
    'E2EE',
  ]) {
    assert.ok(e2e.includes(phase), `e2e has phase: ${phase}`);
  }
  assert.match(e2e, /pjsip set logger on/);
  assert.match(e2e, /--service-down/);
  assert.match(e2e, /sip_failed/);
  assert.match(e2e, /isTone\(/);
  assert.match(e2e, /analyzeTones/);
  // No shell evaluation of .env and no committed secrets in the scripts.
  assert.doesNotMatch(e2e, /\beval\(/);
  assert.doesNotMatch(labUp, /^\s*\.\s+"?\$?\{?ENV/m);
});

test('env template: documented lab keys, no real secret material', () => {
  assert.match(envExample, /^LIVEKIT_API_KEY=/m);
  assert.match(envExample, /^LIVEKIT_API_SECRET=/m);
  assert.match(envExample, /not production secrets|NOT production secrets/i);
  for (const content of [compose, envExample, pjsip, manager, extensions, labUp, e2e, docs]) {
    assert.doesNotMatch(content, /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
    assert.doesNotMatch(content, /AKIA[0-9A-Z]{16}/, 'no AWS access key id literal');
  }
});

test('media proof: WAV analyzer detects the lab tones and silence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agil-sip-tones-'));
  try {
    const toneA = path.join(dir, 'a.wav');
    const toneB = path.join(dir, 'b.wav');
    const silent = path.join(dir, 'silence.wav');
    writeFileSync(toneA, buildToneWav({ frequency: 440, durationSec: 1 }));
    writeFileSync(toneB, buildToneWav({ frequency: 880, durationSec: 1 }));
    writeFileSync(silent, buildToneWav({ frequency: 440, durationSec: 1, amplitude: 0 }));

    const a = analyzeWav(toneA);
    assert.ok(Math.abs(a.durationSec - 1) < 0.01, 'duration parsed');
    assert.ok(a.rmsDbfs > -20, `tone is loud: ${a.rmsDbfs}`);
    assert.ok(a.activeSec > 0.9, `active time: ${a.activeSec}`);
    assert.equal(hasAudio(toneA), true);
    assert.equal(hasAudio(silent), false, 'silence is not audio');
    assert.equal(analyzeTones(toneA, [440, 880, 1000]).dominant, 440);
    assert.equal(analyzeTones(toneB, [440, 880, 1000]).dominant, 880);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dotenv parser: KEY=VALUE, quotes and comments (never evaluated)', () => {
  const parsed = parseDotEnv(
    ['# comment', 'LIVEKIT_API_KEY=devkey', 'LIVEKIT_API_SECRET="secret value"', '', "QUOTED='x'", 'bad line'].join(
      '\n',
    ),
  );
  assert.deepEqual(parsed, { LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret value', QUOTED: 'x' });
});

test('runbook: ports, commands, evidence, blocked items and real-trunk requirements', () => {
  for (const marker of [
    'sip-local-lab',
    'AGIL_SIP_URL',
    'docker compose up -d',
    'lab-init.mjs',
    'e2e.mjs',
    '10000-10100',
    '16000-16100',
    '5070',
    '5060',
    'DTMF',
    'RTP',
    'trunk-down',
    '502',
    '409',
    'Blocked',
    'real trunk',
    'WSL',
    'livekit/sip:v1.24',
    'andrius/asterisk:20.7-cert12_debian-trixie',
  ]) {
    assert.ok(docs.includes(marker), `sip-local-lab.md mentions ${marker}`);
  }
  assert.match(docs, /## 9\./);
  assert.match(docs, /## 10\./);
  assert.match(sipDoc, /sip-local-lab\.md/, 'sip.md links to the lab runbook');
});

test('lab configs contain no phone-like credentials or carrier account data', () => {
  for (const content of [compose, livekitYaml, pjsip, extensions, manager, envExample]) {
    assert.doesNotMatch(content, /@(?:gmail|yandex|mail)\./i, 'no email credentials');
    assert.doesNotMatch(content, /password\s*=\s*(?!agil-lab)[^\s#]+/i, 'no non-lab password');
  }
});
