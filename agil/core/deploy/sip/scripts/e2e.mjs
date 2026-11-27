#!/usr/bin/env node
/**
 * AgilFrame — local SIP/PSTN lab end-to-end checks.
 *
 *   node agil/core/deploy/sip/scripts/e2e.mjs [--only=rtp,dtmf,inbound,trunkdown,e2ee,managed]
 *                                            [--keep] [--service-down]
 *
 * Prerequisites (see agil/core/docs/sip-local-lab.md):
 *   - docker compose up -d   (agil/core/deploy/sip, host networking)
 *   - node scripts/lab-init.mjs
 *   - AgilFrame server running with AGIL_SIP_ENABLED=1,
 *     AGIL_SIP_URL=http://127.0.0.1:7880 and the same LiveKit keys
 *
 * What is proven here (no carrier, no DID, no paid PSTN):
 *   1. RTP bidirectional — the app dials two Asterisk extensions into one
 *      LiveKit room; each side records rx/tx and both rx files must contain the
 *      other side's prompt (audio crossed the SFU in both directions).
 *   2. DTMF — the app passes `dtmf` to CreateSIPParticipant, Asterisk `Read`
 *      collects the digits and writes recordings/dtmf.log.
 *   3. list/stop — the app lists SIP participants, hangs up each one over
 *      RoomService.RemoveParticipant, and the LiveKit room drains.
 *   4. inbound (dial-out to the app) — Asterisk originates an INVITE into the
 *      LiveKit SIP inbound trunk; the dispatch rule puts it in the app room and
 *      the app-created leg records the inbound audio.
 *   5. trunk-down — an unknown `trunkId` (and optionally a stopped SIP
 *      container with --service-down) turns into `502 sip_failed` without
 *      leaking the number/URL.
 *   6. E2EE — enabling tenant E2EE makes dial-in `409 e2ee_incompatible`.
 *   7. Managed node — reported module availability gates new calls while
 *      existing SIP participants can still be listed and removed in LiveKit.
 *
 * The script only talks HTTP/AMI/Twirp to a running stack; it never starts or
 * stops containers itself except for the opt-in --service-down check.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { analyzeWav, analyzeTones, describeWav, hasAudio, isTone } from './lib/audio.mjs';
import { connectAmi } from './lib/ami.mjs';
import { LAB_DIR, resolveLabEnv, requireLiveKitKeys } from './lib/env.mjs';
import { ensureTones } from './gen-tones.mjs';
import {
  createDirectDispatchRule,
  createInboundTrunk,
  deleteDispatchRule,
  deleteTrunk,
  ensureOutboundTrunk,
  isSipParticipant,
  listParticipants,
  probe,
} from './lib/livekit.mjs';
import { check, filesWithPrefix, httpJson, poll, sleep } from './lib/util.mjs';

const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');
const SERVICE_DOWN = args.has('--service-down');
const ONLY = [...args].find((value) => value.startsWith('--only='))?.split('=')[1] ?? '';
const selected = new Set(ONLY ? ONLY.split(',').map((value) => value.trim()).filter(Boolean) : ['rtp', 'dtmf', 'stop', 'inbound', 'trunkdown', 'e2ee', 'managed']);
const COLORS = process.stdout.isTTY;
const green = (text) => (COLORS ? `\x1b[32m${text}\x1b[0m` : text);
const red = (text) => (COLORS ? `\x1b[31m${text}\x1b[0m` : text);
const yellow = (text) => (COLORS ? `\x1b[33m${text}\x1b[0m` : text);
const dim = (text) => (COLORS ? `\x1b[2m${text}\x1b[0m` : text);

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? green('✔') : red('✖')} ${name}${detail ? dim(` — ${detail}`) : ''}\n`);
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true, detail: reason });
  process.stdout.write(`  ${yellow('•')} ${name}${reason ? dim(` — ${reason}`) : ''}\n`);
}
function section(title) {
  process.stdout.write(`\n${title}\n`);
}

/* --------------------------- app HTTP client ----------------------------- */

function createApp(config) {
  const base = config.appUrl;
  const adminHeaders = { 'x-api-key': config.adminKey };
  const api = (method, urlPath, { body, token, admin = false, headers = {} } = {}) =>
    httpJson(`${base}${urlPath}`, {
      method,
      headers: { ...(admin ? adminHeaders : token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body }),
    });
  return {
    api,
    health: () => api('GET', '/v1/health'),
    status: () => api('GET', '/v1/admin/sip/status', { admin: true }),
    test: (body) => api('POST', '/v1/admin/sip/test', { admin: true, body }),
    getConfig: () => api('GET', `/v1/tenants/${config.tenant}/config`, { admin: true }),
    patchConfig: (body) => api('PATCH', `/v1/tenants/${config.tenant}/config`, { admin: true, body }),
    createRoom: (name) => api('POST', '/v1/admin/rooms', { admin: true, body: { name } }),
    dial: (room, body) => api('POST', `/v1/rooms/${room.id}/sip/dial-in`, { token: room.token, body }),
    list: (room) => api('GET', `/v1/rooms/${room.id}/sip`, { token: room.token }),
    stop: (room, participantId) =>
      api('POST', `/v1/rooms/${room.id}/sip/${encodeURIComponent(participantId)}/stop`, { token: room.token }),
    audit: (type, limit = 50) => api('GET', `/v1/admin/audit?type=${encodeURIComponent(type)}&limit=${limit}`, { admin: true }),
  };
}

/* --------------------------- recording helpers --------------------------- */

function snapshotRecordings(dir) {
  return new Set(filesWithPrefix(dir, ''));
}

/** Waits for a new file with `prefix` that carries real audio, returns its path. */
async function waitRecording(dir, prefix, before, { timeoutMs = 30000, label, minActiveSec = 0.4 } = {}) {
  return poll(
    () => {
      const fresh = filesWithPrefix(dir, prefix).find((file) => !before.has(file));
      if (!fresh) return null;
      return hasAudio(fresh, { minActiveSec }) ? fresh : null;
    },
    { timeoutMs, intervalMs: 300, label: label ?? `recording ${prefix}*.wav with audio` },
  );
}

/** Waits for `count` SIP participants in the app room list. */
async function waitParticipants(app, room, count, label) {
  return poll(
    async () => {
      const response = await app.list(room);
      if (response.status !== 200) return null;
      const participants = response.body?.participants ?? [];
      return participants.length >= count ? participants : null;
    },
    { timeoutMs: 30000, label: label ?? `${count} SIP participant(s)` },
  );
}
function recordingMetrics(file) {
  try {
    return analyzeWav(file);
  } catch (error) {
    return { error: error.message };
  }
}

/* ------------------------------ log helpers ------------------------------ */

function logSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Bytes appended to the Asterisk `full` log since `offset`. */
function readLogSince(file, offset) {
  if (!existsSync(file)) return '';
  const buffer = readFileSync(file);
  return buffer.subarray(Math.min(offset, buffer.length)).toString('utf8');
}

/**
 * Asterisk buffers `logger.conf` file writes, so a marker can land a few
 * seconds after the call ends. Poll the appended bytes instead of reading once.
 */
async function waitForLogSince(file, offset, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let marker = readLogSince(file, offset);
  while (!predicate(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    marker = readLogSince(file, offset);
  }
  return marker;
}

/* ------------------------------- phases ---------------------------------- */

async function phasePreflight(config, app, ctx) {
  section('0. Preflight');
  const health = await app.health();
  record('app /v1/health', health.status === 200, `HTTP ${health.status}`);
  if (health.status !== 200) throw new Error(`app is not reachable at ${config.appUrl} — start it first (see docs)`);

  const status = await app.status();
  check(status.status === 200, `GET /v1/admin/sip/status → HTTP ${status.status}`);
  record('gateway configured in the app', status.body.configured === true, JSON.stringify(status.body));
  if (!status.body.configured) {
    throw new Error(
      'AGIL_SIP_URL / AGIL_SIP_API_KEY / AGIL_SIP_API_SECRET are not set on the app; ' +
        `restart it with AGIL_SIP_ENABLED=1 AGIL_SIP_URL=${config.livekitUrl} and the LiveKit keys`,
    );
  }

  const rooms = await probe(config);
  record('LiveKit Twirp reachable by the lab operator', true, `${rooms} room(s)`);

  if (!existsSync(config.recordingsDir)) {
    throw new Error(`recordings dir ${config.recordingsDir} does not exist — is the stack up (docker compose up -d)?`);
  }
  record('recordings directory', true, config.recordingsDir);

  // The Asterisk image ships no prompts; generate the lab tones before dialing.
  const soundsDir = ensureTones();
  record('tone prompts for the Asterisk dialplan', true, soundsDir);
}

async function ensureTrunks(config, app) {
  section('1. Trunks and tenant config');
  const outbound = await ensureOutboundTrunk(config, config.outboundTrunk);
  record(outbound.created ? 'outbound trunk created' : 'outbound trunk reused', true, outbound.id);
  const current = await app.getConfig();
  check(current.status === 200, `GET tenant config → HTTP ${current.status}`);
  const saved = {
    sipDialIn: current.body.config?.features?.sipDialIn,
    e2ee: current.body.config?.security?.e2ee,
    sip: { ...current.body.config?.scale?.sip, nodeId: current.body.config?.scale?.sip?.nodeId ?? '' },
  };
  const patched = await app.patchConfig({
    features: { sipDialIn: true },
    security: { e2ee: false },
    scale: {
      sip: {
        nodeId: '',
        enabled: true,
        provider: 'livekit-sip',
        trunkId: outbound.id,
        dialInNumbers: [config.numbers.rtpA, config.numbers.dtmf, config.numbers.rtpB],
        callerId: config.outboundTrunk.numbers[0],
        maxConcurrent: 4,
        maxCallDurationSec: 120,
      },
    },
  });
  check(patched.status === 200, `PATCH tenant config → HTTP ${patched.status}: ${patched.text.slice(0, 300)}`);
  const status = await app.status();
  record('tenant SIP config applied', status.body.enabled === true && status.body.trunkConfigured === true, JSON.stringify(status.body));
  const mock = await app.test({ mode: 'mock' });
  record('admin mock test', mock.status === 200 && mock.body.ok === true, mock.body?.detail ?? `HTTP ${mock.status}`);
  // Live test is a read-only probe but (by design) requires a configured trunk,
  // so it runs after the tenant config above.
  const live = await app.test({ mode: 'live' });
  record('admin live test (RoomService.ListRooms)', live.status === 200 && live.body.ok === true, live.body?.detail ?? `HTTP ${live.status}`);
  return { outboundTrunkId: outbound.id, saved };
}

async function createRoom(config, app, name) {
  const created = await app.createRoom(name);
  check(created.status === 200, `POST /v1/admin/rooms → HTTP ${created.status}: ${created.text.slice(0, 300)}`);
  const room = { id: created.body.room.id, token: created.body.token, name: created.body.room.name };
  room.sfuName = `${config.tenant}__${room.id}`;
  return room;
}

async function phaseRtp(config, app, room, ctx) {
  if (!selected.has('rtp')) return;
  section('2. RTP — bidirectional audio between two Asterisk legs in one LiveKit room');
  const before = snapshotRecordings(config.recordingsDir);
  const logFile = ctx.logFile;
  const logOffset = logSize(logFile);

  const dialA = await app.dial(room, { number: config.numbers.rtpA, name: 'SIP leg A' });
  check(dialA.status === 200, `dial-in leg A (${config.numbers.rtpA}) → HTTP ${dialA.status}: ${dialA.text.slice(0, 300)}`);
  record('dial-in leg A (app → Asterisk, demo-congrats)', true, dialA.body.identity);
  const dialB = await app.dial(room, { number: config.numbers.rtpB, name: 'SIP leg B' });
  check(dialB.status === 200, `dial-in leg B (${config.numbers.rtpB}) → HTTP ${dialB.status}: ${dialB.text.slice(0, 300)}`);
  record('dial-in leg B (app → Asterisk, hello-world)', true, dialB.body.identity);

  const listed = await waitParticipants(app, room, 2, 'both SIP legs listed by the app');
  record('app lists both SIP participants', listed.length === 2, listed.map((entry) => `${entry.identity}:${entry.status}`).join(', '));

  const livekitParticipants = await poll(
    async () => {
      const raw = await listParticipants(config, room.sfuName);
      const sip = raw.filter(isSipParticipant);
      return sip.length >= 2 ? sip : null;
    },
    { timeoutMs: 15000, label: 'two SIP participants in the LiveKit room' },
  );
  record('LiveKit room has two SIP participants', livekitParticipants.length === 2, livekitParticipants.map((entry) => entry.identity).join(', '));

  // Recordings: a-rx/a-tx may take a few seconds (leg A waits 3 s before the
  // prompt; B waits 1 s), so wait with a generous timeout.
  const aTx = await waitRecording(config.recordingsDir, 'a-tx-', before, { timeoutMs: 25000 });
  record('leg A transmitted audio (tx recording has audio)', true, describeWav(aTx));
  const bTx = await waitRecording(config.recordingsDir, 'b-tx-', before, { timeoutMs: 20000 });
  record('leg B transmitted audio (tx recording has audio)', true, describeWav(bTx));

  const aRx = await waitRecording(config.recordingsDir, 'a-rx-', before, { timeoutMs: 25000, label: 'leg A received leg B audio' });
  record('leg A received leg B audio through the room (rx)', true, describeWav(aRx));
  const bRx = await waitRecording(config.recordingsDir, 'b-rx-', before, { timeoutMs: 25000, label: 'leg B received leg A audio' });
  record('leg B received leg A audio through the room (rx)', true, describeWav(bRx));

  // Distinct tone frequencies prove *which* leg crossed the SFU: A sends
  // 440 Hz and must receive 880 Hz (B), B sends 880 Hz and must receive 440 Hz.
  for (const [label, file, expected] of [
    ['leg A tx is A tone', aTx, 440],
    ['leg B rx is A tone', bRx, 440],
    ['leg B tx is B tone', bTx, 880],
    ['leg A rx is B tone', aRx, 880],
  ]) {
    const analysis = analyzeTones(file, [440, 880, 1000]);
    record(
      `tone check: ${label} (~${expected} Hz)`,
      isTone(file, expected, 30),
      `dominant ~${analysis.dominant} Hz, ${analysis.durationSec.toFixed(1)} s`,
    );
  }

  const aMix = filesWithPrefix(config.recordingsDir, 'a-mix-')[0];
  const bMix = filesWithPrefix(config.recordingsDir, 'b-mix-')[0];
  for (const [label, file] of [['a-mix', aMix], ['b-mix', bMix]]) {
    if (!file) throw new Error(`missing ${label} recording in ${config.recordingsDir}`);
    const metrics = recordingMetrics(file);
    record(`${label} recording is valid WAV`, !metrics.error, metrics.error ?? describeWav(file));
  }

  // Optional Asterisk-side proof (channel state), best effort.
  if (ctx.ami) {
    const upChannels = new Set(
      ctx.ami.events
        .filter((event) => event.Event === 'Newstate' && String(event.ChannelState) === '6')
        .map((event) => event.Channel)
        .filter((channel) => String(channel).startsWith('PJSIP/')),
    );
    record('Asterisk channels reached Up (INVITE answered)', upChannels.size >= 2, [...upChannels].join(', '));
  }

  // Asterisk file logging is buffered; the markers are checked after the
  // stop phase so waiting for them cannot outlive the 10 s dialplan.
  if (ctx.ami || config.outboundTrunk.transport === 'SIP_TRANSPORT_TLS') ctx.rtpLogCheck = { file: logFile, offset: logOffset };
  return { dialA: dialA.body.identity, dialB: dialB.body.identity };
}

async function phaseRtpLog(config, ctx) {
  if (!ctx.rtpLogCheck) return;
  section('2b. Asterisk-side RTP proof');
  const marker = await waitForLogSince(ctx.rtpLogCheck.file, ctx.rtpLogCheck.offset, (text) =>
    /AGIL_LAB_RTP_A_UP/.test(text) && /AGIL_LAB_RTP_B_UP/.test(text), 15000);
  record(
    'Asterisk dialplan markers AGIL_LAB_RTP_A/B_UP',
    /AGIL_LAB_RTP_A_UP/.test(marker) && /AGIL_LAB_RTP_B_UP/.test(marker),
    'from logs/asterisk/full',
  );
  if (/INVITE sip:\+15550100@/.test(marker)) record('SIP trace: LiveKit INVITE to +15550100', true, 'logs/asterisk/full');
  else skip('SIP trace lines in Asterisk log', 'pjsip logger output was not in the log (signalling proven by Up channels + recordings)');
  if (config.outboundTrunk.transport === 'SIP_TRANSPORT_TLS') {
    record('SIP trace confirms TLS signalling and an SRTP offer', /SIP request .* from TLS:/i.test(marker) &&
      /^m=audio \d+ RTP\/SAVP(?:F)?\b/m.test(marker), 'from the Asterisk SIP trace');
  }
}

async function phaseStop(config, app, room, identities) {
  if (!selected.has('stop')) return;
  section('3. list + stop — hang up both legs over RoomService.RemoveParticipant');
  const first = await app.stop(room, identities.dialA);
  check(first.status === 200, `stop leg A → HTTP ${first.status}: ${first.text.slice(0, 300)}`);
  record('stop leg A accepted', first.body?.stopped === true, JSON.stringify(first.body));
  const afterFirst = await poll(async () => {
    const response = await app.list(room);
    const participants = response.body?.participants ?? [];
    return participants.length === 1 && participants[0].identity === identities.dialB ? participants : null;
  }, { timeoutMs: 15000, label: 'leg A removed from the app list' });
  record('app list drops leg A (leg B still present)', afterFirst.length === 1, afterFirst[0]?.identity);

  const second = await app.stop(room, identities.dialB);
  check(second.status === 200, `stop leg B → HTTP ${second.status}: ${second.text.slice(0, 300)}`);
  const afterSecond = await poll(async () => {
    const response = await app.list(room);
    return (response.body?.participants ?? []).length === 0 ? true : null;
  }, { timeoutMs: 15000, label: 'room SIP list empty' });
  record('app list is empty after stopping both legs', afterSecond === true);

  const gone = await poll(async () => {
    const raw = await listParticipants(config, room.sfuName);
    return raw.filter(isSipParticipant).length === 0 ? true : null;
  }, { timeoutMs: 15000, label: 'LiveKit room has no SIP participants' });
  record('LiveKit room drains (BYE → participant removed)', gone === true);

  await sleep(500);
  const aMix = filesWithPrefix(config.recordingsDir, 'a-mix-')[0];
  const duration = aMix ? analyzeWav(aMix).durationSec : 0;
  // The legs are hung up while the 6 s prompt is still playing, so anything
  // above ~3 s means the recording spanned the call (not a 0-byte stub).
  record('leg A recording captured the call after hangup', duration > 3, `${duration.toFixed(1)} s`);

  const started = await app.audit('sip.dialin.started');
  const stopped = await app.audit('sip.dialin.stopped');
  const startedForRoom = (started.body?.entries ?? []).filter((entry) => entry.roomId === room.id);
  const stoppedForRoom = (stopped.body?.entries ?? []).filter((entry) => entry.roomId === room.id);
  record('audit sip.dialin.started entries', startedForRoom.length >= 2, `${startedForRoom.length}`);
  record('audit sip.dialin.stopped entries', stoppedForRoom.length >= 2, `${stoppedForRoom.length}`);
  const auditText = JSON.stringify([...startedForRoom, ...stoppedForRoom]);
  record(
    'audit never contains the raw numbers',
    ![config.numbers.rtpA, config.numbers.rtpB].some((number) => auditText.includes(number)),
    'masked only',
  );
}

async function phaseDtmf(config, app, room, ctx) {
  if (!selected.has('dtmf')) return;
  section('4. DTMF — app `dtmf` → LiveKit → Asterisk Read → recordings/dtmf.log');
  const before = snapshotRecordings(config.recordingsDir);
  const dtmfLog = path.join(config.recordingsDir, 'dtmf.log');
  const beforeLog = existsSync(dtmfLog) ? readFileSync(dtmfLog).length : 0;

  // 'w' = 0.5 s pause: gives the RTP path time to come up before digits start.
  const dial = await app.dial(room, { number: config.numbers.dtmf, dtmf: 'w123#', name: 'SIP DTMF' });
  check(dial.status === 200, `dial-in DTMF leg → HTTP ${dial.status}: ${dial.text.slice(0, 300)}`);
  record('dial-in DTMF leg accepted', true, dial.body.identity);

  const line = await poll(
    () => {
      if (!existsSync(dtmfLog)) return null;
      const text = readFileSync(dtmfLog).subarray(beforeLog).toString('utf8');
      const match = /DTMF=([^\s]*)\s+STATUS=(\S+)/.exec(text);
      return match ? { digits: match[1], status: match[2], text } : null;
    },
    { timeoutMs: 30000, intervalMs: 300, label: 'DTMF digits in recordings/dtmf.log' },
  );
  record('Asterisk received DTMF digits', line.digits.includes('123'), `DTMF=${line.digits} STATUS=${line.status}`);
  // Asterisk reports READSTATUS=OK (SUCCESS was the pre-20 spelling).
  record('Asterisk Read completed successfully', /^(OK|SUCCESS)$/.test(line.status), line.status);

  const recording = filesWithPrefix(config.recordingsDir, 'dtmf-').find((file) => !before.has(file));
  if (recording) record('DTMF leg recording exists', true, describeWav(recording));
  else skip('DTMF leg recording', 'file not found yet (the call may still be closing)');

  const stop = await app.stop(room, dial.body.identity);
  record('stop DTMF leg (or already hung up)', stop.status === 200 || stop.status === 404, `HTTP ${stop.status}`);
}

async function phaseInbound(config, app, room, ctx) {
  if (!selected.has('inbound')) return;
  section('5. inbound — Asterisk dials the LiveKit SIP inbound trunk into the app room');
  const suffix = Date.now().toString(36);
  const trunkName = `${config.inboundTrunk.name}-e2e-${suffix}`;
  const ruleName = `${config.inboundTrunk.name}-e2e-${suffix}`;
  let trunkId = null;
  let ruleId = null;
  const before = snapshotRecordings(config.recordingsDir);
  try {
    trunkId = await createInboundTrunk(config, {
      name: trunkName,
      numbers: [config.numbers.appInbound],
      allowed_addresses: config.inboundTrunk.allowedAddresses,
      hide_phone_number: true,
      ...(config.inboundTrunk.requireSrtp ? { media_encryption: 'SIP_MEDIA_ENCRYPT_REQUIRE' } : {}),
    });
    record('inbound trunk created for the app room', true, trunkId);
    ruleId = await createDirectDispatchRule(config, {
      name: ruleName,
      trunkIds: [trunkId],
      numbers: [config.numbers.appInbound],
      roomName: room.sfuName,
    });
    record('direct dispatch rule → app room', true, `${ruleId} → ${room.sfuName}`);

    const dial = await app.dial(room, { number: config.numbers.rtpA, name: 'SIP inbound listener' });
    check(dial.status === 200, `dial-in room listener → HTTP ${dial.status}: ${dial.text.slice(0, 300)}`);
    await waitParticipants(app, room, 1, 'room listener joined');
    record('room listener (app outbound leg) is up', true, dial.body.identity);

    if (!ctx.ami) {
      check(!config.inboundTrunk.requireSrtp, 'AMI is required to exercise the secure inbound trunk');
      skip('inbound originate (AMI)', 'AMI is not available');
      return;
    }
    const logOffset = logSize(ctx.logFile);
    const originated = await ctx.ami.originate({
      channel: `PJSIP/${config.numbers.appInbound}@agil-sip-out`,
      application: 'Playback',
      // 880 Hz "phone" tone: the listener below plays 440 Hz, so the received
      // frequency proves the inbound direction specifically.
      data: 'agil-tone-b',
      timeout: 25000,
    });
    record('Asterisk originated INVITE to the LiveKit inbound trunk (answered)', true, `${originated.channel} (${originated.uniqueid})`);

    const both = await waitParticipants(app, room, 2, 'inbound caller appears next to the room listener');
    record('app lists the inbound caller as a SIP participant', both.length === 2, both.map((entry) => entry.identity).join(', '));

    const rx = await waitRecording(config.recordingsDir, 'a-rx-', before, {
      timeoutMs: 25000,
      label: 'room listener receiving inbound audio (880 Hz tone)',
    });
    record('inbound audio reached the room listener (RTP Asterisk → LiveKit SIP → room)', true, describeWav(rx));
    const analysis = analyzeTones(rx, [440, 880, 1000]);
    record('inbound tone check: listener receives ~880 Hz', isTone(rx, 880, 30), `dominant ~${analysis.dominant} Hz`);

    const inboundIdentity = both.find((entry) => entry.identity !== dial.body.identity)?.identity;
    check(Boolean(inboundIdentity), 'inbound participant identity is listed');
    const stop = await app.stop(room, inboundIdentity);
    check(stop.status === 200, `stop inbound caller → HTTP ${stop.status}: ${stop.text.slice(0, 300)}`);
    record('stop inbound caller (no phone number in the URL)', true, inboundIdentity);
    await poll(async () => {
      const response = await app.list(room);
      return (response.body?.participants ?? []).length === 1 ? true : null;
    }, { timeoutMs: 15000, label: 'inbound participant removed' });
    record('inbound caller removed, listener still present', true);
    await app.stop(room, dial.body.identity);

    const number = config.numbers.appInbound;
    if (config.inboundTrunk.requireSrtp) {
      const hasSecureInvite = (trace) => trace.split(/\r?\n(?=\[\d{4}-\d{2}-\d{2} )/).some((message) =>
        /Transmitting SIP request .* to TLS:/i.test(message) &&
        (message.includes(`INVITE sip:${number}@`) || message.includes(`INVITE sips:${number}@`)) &&
        /^m=audio \d+ RTP\/SAVP(?:F)?\b/m.test(message));
      const trace = await waitForLogSince(ctx.logFile, logOffset, hasSecureInvite, 10000);
      record('inbound INVITE used TLS and offered SRTP', hasSecureInvite(trace), 'from the Asterisk SIP trace');
    } else {
      const trace = readLogSince(ctx.logFile, logOffset);
      if (trace.includes(`INVITE sip:${number}@`)) record('SIP trace: Asterisk inbound INVITE', true, 'logs/asterisk/full');
      else skip('SIP trace lines for the inbound INVITE', 'pjsip logger output was not in the log');
    }
  } finally {
    if (ruleId) {
      try {
        await deleteDispatchRule(config, ruleId);
      } catch (error) {
        record('cleanup dispatch rule', false, error.message);
      }
    }
    if (trunkId) {
      try {
        await deleteTrunk(config, trunkId);
      } catch (error) {
        record('cleanup inbound trunk', false, error.message);
      }
    }
  }
}

async function phaseTrunkDown(config, app, room, trunks) {
  if (!selected.has('trunkdown')) return;
  section('6. trunk-down — unknown trunk and (optionally) a stopped SIP container');
  const bogus = 'ST_agil_lab_missing';
  try {
    const patched = await app.patchConfig({ scale: { sip: { trunkId: bogus } } });
    check(patched.status === 200, `PATCH trunkId=${bogus} → HTTP ${patched.status}`);
    const failed = await app.dial(room, { number: config.numbers.rtpA });
    record('dial-in with an unknown trunk → 502 sip_failed', failed.status === 502 && failed.body?.error?.code === 'sip_failed', `HTTP ${failed.status} ${failed.body?.error?.code ?? ''}`);
    record('502 does not echo the number or the gateway URL', !failed.text.includes(config.numbers.rtpA) && !failed.text.includes(config.livekitUrl), 'scrubbed');
    const audit = await app.audit('sip.dialin.failed');
    record('audit sip.dialin.failed entry', (audit.body?.entries ?? []).some((entry) => entry.roomId === room.id), 'action=start');
  } finally {
    const restore = await app.patchConfig({ scale: { sip: { trunkId: trunks.outboundTrunkId } } });
    check(restore.status === 200, 'restore trunkId');
  }

  if (!SERVICE_DOWN) {
    skip('gateway down (SIP container stopped)', 'pass --service-down with LAB_DOCKER=1 (needs the docker CLI next to the lab)');
    return;
  }
  if (process.env.LAB_DOCKER !== '1') {
    skip('gateway down (SIP container stopped)', 'set LAB_DOCKER=1 to allow the script to stop/start the sip container');
    return;
  }
  const compose = (argsList) => spawnSync('docker', ['compose', ...argsList], { cwd: LAB_DIR, encoding: 'utf8' });
  record('stop the sip container', compose(['stop', 'sip']).status === 0, 'docker compose stop sip');
  await sleep(1500);
  const down = await app.dial(room, { number: config.numbers.rtpA });
  record('dial-in with the SIP worker down → 502 sip_failed', down.status === 502 && down.body?.error?.code === 'sip_failed', `HTTP ${down.status}`);
  record('start the sip container', compose(['start', 'sip']).status === 0, 'docker compose start sip');
  await poll(async () => {
    const test = await app.test({ mode: 'live' });
    return test.status === 200 && test.body.ok === true ? true : null;
  }, { timeoutMs: 60000, intervalMs: 1000, label: 'gateway back up' });
  record('gateway reachable again after restart', true);
}

async function phaseE2ee(config, app, room) {
  if (!selected.has('e2ee')) return;
  section('7. E2EE — PSTN cannot be bridged into an encrypted room');
  const patched = await app.patchConfig({ security: { e2ee: true } });
  check(patched.status === 200, `PATCH e2ee=true → HTTP ${patched.status}`);
  const dial = await app.dial(room, { number: config.numbers.rtpA });
  record('dial-in with E2EE enabled → 409 e2ee_incompatible', dial.status === 409 && dial.body?.error?.code === 'e2ee_incompatible', `HTTP ${dial.status} ${dial.body?.error?.code ?? ''}`);
  const restore = await app.patchConfig({ security: { e2ee: false } });
  check(restore.status === 200, 'restore e2ee=false');
}

async function phaseManagedNode(config, app, room, created) {
  if (!selected.has('managed')) return;
  section('8. Managed SIP node availability');
  const nodeId = `sip-lab-${randomUUID()}`;
  const issued = await app.api('POST', '/v1/admin/cluster/tokens', { admin: true, body: { kind: 'node', role: 'all' } });
  check(issued.status === 201, `issue enrollment token → HTTP ${issued.status}`);
  const registered = await app.api('POST', '/v1/nodes/register', { body: { token: issued.body.token, nodeId, role: 'all' } });
  check(registered.status === 201, `enroll SIP lab node → HTTP ${registered.status}`);
  created.managedNodeId = nodeId;
  const heartbeat = async (status) => {
    const response = await app.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
      headers: { 'x-node-token': registered.body.nodeKey },
      body: { modules: [{ id: 'sip', image: 'agil/node-sip:0.1.0', status, health: status === 'running' ? 'healthy' : 'unhealthy' }] },
    });
    check(response.status === 200, `SIP lab heartbeat (${status}) → HTTP ${response.status}`);
  };
  const binding = await app.patchConfig({ scale: { sip: { nodeId } } });
  check(binding.status === 200, `bind SIP lab node → HTTP ${binding.status}`);
  const dial = () => app.dial(room, { number: config.numbers.rtpA, name: 'Managed SIP lab' });
  await heartbeat('running');
  const first = await dial();
  check(first.status === 200, `dial with healthy node → HTTP ${first.status}`);
  const participants = await listParticipants(config, room.sfuName);
  record('healthy node admits a real SIP participant', participants.some((participant) =>
    isSipParticipant(participant) && participant.identity === first.body.identity));

  await heartbeat('stopped');
  const blocked = await dial();
  record('stopped node rejects new requests', blocked.status === 503 && blocked.body?.error?.code === 'sip_node_unavailable', `HTTP ${blocked.status}`);
  const listed = await app.list(room);
  record('existing SIP participant is still listed', listed.status === 200 &&
    listed.body?.participants?.length === 1 && listed.body.participants[0].identity === first.body.identity);
  const stopped = await app.stop(room, first.body.identity);
  record('existing SIP participant can still be stopped', stopped.status === 200 && stopped.body?.stopped === true);
  await poll(async () => (await listParticipants(config, room.sfuName)).every((participant) => !isSipParticipant(participant)),
    { timeoutMs: 10000, label: 'SIP participant removed from LiveKit' });

  await heartbeat('running');
  const resumed = await dial();
  check(resumed.status === 200, `dial after node recovery → HTTP ${resumed.status}`);
  record('new call succeeds after node recovery', true);
  const cleaned = await app.stop(room, resumed.body.identity);
  check(cleaned.status === 200 && cleaned.body?.stopped === true, `stop recovery call → HTTP ${cleaned.status}`);
}

/* -------------------------------- main ----------------------------------- */

async function main() {
  const config = requireLiveKitKeys(resolveLabEnv());
  const app = createApp(config);
  const ctx = {
    ami: null,
    logFile: config.asteriskLog,
  };
  const created = { rooms: [], inboundTrunkId: null, managedNodeId: null };
  let trunks = null;
  let room = null;

  /** Phase runner: a failing phase is reported and does not abort later ones. */
  const runPhase = async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      record(`${name} phase`, false, error.message);
      return null;
    }
  };

  process.stdout.write('AgilFrame — local SIP/PSTN lab checks\n');
  process.stdout.write(dim(`  app=${config.appUrl}  livekit=${config.livekitUrl}  tenant=${config.tenant}\n`));
  process.stdout.write(dim(`  recordings=${config.recordingsDir}\n`));

  try {
    await phasePreflight(config, app, ctx);

    try {
      ctx.ami = await connectAmi(config.ami);
      record('Asterisk AMI login', true, `${config.ami.host}:${config.ami.port}`);
      await ctx.ami.command('pjsip set logger on');
    } catch (error) {
      ctx.ami = null;
      skip('Asterisk AMI login', error.message);
    }

    trunks = await ensureTrunks(config, app);
    room = await createRoom(config, app, `SIP lab ${new Date().toISOString()}`);
    created.rooms.push(room);
    record('app room created', true, `${room.id} → LiveKit ${room.sfuName}`);

    const identities = await runPhase('RTP', () => phaseRtp(config, app, room, ctx));
    if (identities) await runPhase('list/stop', () => phaseStop(config, app, room, identities));
    await runPhase('RTP log proof', () => phaseRtpLog(config, ctx));
    await runPhase('DTMF', () => phaseDtmf(config, app, room, ctx));
    await runPhase('inbound', () => phaseInbound(config, app, room, ctx));
    await runPhase('trunk-down', () => phaseTrunkDown(config, app, room, trunks));
    await runPhase('E2EE', () => phaseE2ee(config, app, room));
    await runPhase('managed SIP node', () => phaseManagedNode(config, app, room, created));

    if (ctx.ami) await ctx.ami.command('pjsip set logger off');
  } finally {
    if (room) {
      try {
        const listed = await app.list(room);
        for (const participant of listed.body?.participants ?? []) {
          await app.stop(room, participant.identity).catch(() => undefined);
        }
      } catch {
        /* best effort */
      }
    }
    if (trunks?.saved) {
      try {
        const restore = await app.patchConfig({
          features: { sipDialIn: trunks.saved.sipDialIn },
          security: { e2ee: trunks.saved.e2ee },
          scale: { sip: trunks.saved.sip },
        });
        const restoredNodeId = restore.body?.config?.scale?.sip?.nodeId ?? '';
        record('restore the previous tenant SIP config', restore.status === 200 && restoredNodeId === trunks.saved.sip.nodeId, `HTTP ${restore.status}`);
      } catch (error) {
        record('restore the previous tenant SIP config', false, error.message);
      }
    }
    if (created.managedNodeId) {
      await runPhase('remove the lab node', async () => {
        const removed = await app.api('DELETE', `/v1/admin/nodes/${created.managedNodeId}`, { admin: true });
        record('remove the lab node', removed.status === 200 && removed.body?.deleted === true, `HTTP ${removed.status}`);
      });
    }
    if (ctx.ami) ctx.ami.close();
  }

  section('Summary');
  const failed = results.filter((entry) => !entry.ok);
  const skippedCount = results.filter((entry) => entry.skipped).length;
  process.stdout.write(`  ${results.length - failed.length - skippedCount} passed, ${failed.length} failed, ${skippedCount} skipped\n`);
  if (!KEEP) process.stdout.write(dim(`  recordings kept in ${config.recordingsDir} (delete with scripts/lab-down.sh --clean)\n`));
  if (failed.length > 0) {
    for (const entry of failed) process.stdout.write(`  ${red('FAIL')} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`\nlab e2e aborted: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
