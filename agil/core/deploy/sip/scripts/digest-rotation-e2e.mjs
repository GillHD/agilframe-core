/** Isolated Asterisk and LiveKit SIP lab. Synthetic calls bind to the guest only. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildToneWav, TONES } from './gen-tones.mjs';
import { AmiClient } from './lib/ami.mjs';
import { analyzeTones, hasAudio, isTone } from './lib/audio.mjs';
import { LAB_DIR } from './lib/env.mjs';
import { createDirectDispatchRule, createInboundTrunk, createOutboundTrunk, isSipParticipant, listParticipants, listRooms, roomToken, twirp } from './lib/livekit.mjs';
import { filesWithPrefix, poll } from './lib/util.mjs';

assert.equal(process.platform, 'linux', 'Run inside a disposable Linux QA VM with local Docker');
const rotateWorker = process.argv.includes('--rotate-worker-key');
const run = promisify(execFile);
const prefix = process.env.AGIL_QA_SUDO_DOCKER === '1' ? ['sudo', '-n', 'docker'] : ['docker'];
const docker = (...arguments_) => run(prefix[0], [...prefix.slice(1), ...arguments_], { timeout: 110000 });
const { stdout: dockerEndpoint } = await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
assert.match(dockerEndpoint, /^unix:\/\/\//, 'This lab needs the VM-local Docker engine');
if (process.env.DOCKER_HOST) assert.match(process.env.DOCKER_HOST, /^unix:\/\/\//);
const directory = await mkdtemp(path.join(tmpdir(), 'agil-sip-digest-'));
const project = path.basename(directory).toLowerCase();
const compose = (...arguments_) => docker('compose', '--project-directory', directory, '-p', project, ...arguments_);
const mediaDir = path.join(directory, 'recordings');
const traceFile = path.join(directory, 'logs', 'asterisk', 'full');
const marker = randomBytes(4).toString('hex');
const credential = () => randomBytes(16).toString('hex');
const old = { outbound: credential(), inbound: credential() };
const next = { outbound: credential(), inbound: credential() };
const operator = { livekitUrl: 'http://127.0.0.1:27880', apiKey: `agil_digest_${marker}`, apiSecret: credential() + credential() };
const workerKey = (name) => ({ ...operator, apiKey: `agil_sip_${name}_${marker}`, apiSecret: credential() + credential() });
const oldWorker = workerKey('old');
const newWorker = workerKey('new');
const outboundUser = 'agil-digest-outbound';
const inboundUser = 'agil-digest-inbound';
const inboundNumber = '600';
const callerId = '+15550000000';
const outboundNumber = '+15550100';
const room = `sip-digest-${marker}`;
const port = {
  5060: 25060, 5070: 25070, 5038: 25038, 6385: 26385, 6789: 26789,
  7880: 27880, 7881: 27881, 28083: 28084, 10000: 26100, 10100: 26120,
  16000: 26200, 16100: 26220, 50100: 27000, 50200: 27020,
};
const ports = new RegExp(`(?<!\\d)(?:${Object.keys(port).join('|')})(?!\\d)`, 'g');
const files = ['docker-compose.yml', 'livekit.yaml', 'asterisk/pjsip.conf', 'asterisk/extensions.conf',
  'asterisk/logger.conf', 'asterisk/manager.conf', 'asterisk/modules.conf', 'asterisk/rtp.conf'];
let ami;
let stackConfigured = false;

function setWorker(worker) {
  return writeFile(path.join(directory, '.env'), [
    `LIVEKIT_API_KEY=${operator.apiKey}`, `LIVEKIT_API_SECRET=${operator.apiSecret}`,
    `QA_SIP_WORKER_KEY=${worker.apiKey}`, `QA_SIP_WORKER_SECRET=${worker.apiSecret}`, '',
  ].join('\n'), { mode: 0o600 });
}

function setSfuKeys(base, workers) {
  const keys = [operator, ...workers].map(({ apiKey, apiSecret }) => `  ${apiKey}: "${apiSecret}"`).join('\n');
  return writeFile(path.join(directory, 'livekit.yaml'), `${base}\nkeys:\n${keys}\n`);
}

const prepare = async () => {
  for (const subdirectory of ['asterisk/sounds', 'logs/asterisk', 'recordings']) {
    await mkdir(path.join(directory, subdirectory), { recursive: true });
  }
  const stock = Object.fromEntries(await Promise.all(files.map(async (filename) => [filename,
    (await readFile(path.join(LAB_DIR, filename), 'utf8')).replace(/\r\n/g, '\n').replace(ports, (value) => port[value]),
  ])));
  stock['livekit.yaml'] += '\nbind_addresses: ["127.0.0.1"]\n';
  stock['docker-compose.yml'] = stock['docker-compose.yml']
    .replace('["redis-server", "--port"', '["redis-server", "--bind", "127.0.0.1", "--port"');
  if (rotateWorker) {
    stock['docker-compose.yml'] = stock['docker-compose.yml']
      .replace(/^    environment:\n(?:      #[^\n]*\n)*      LIVEKIT_KEYS:[^\n]*\n/m, '')
      .replace(/(api_key: ')\$\{LIVEKIT_API_KEY[^}]*\}/, "$1${QA_SIP_WORKER_KEY:?set the synthetic SIP worker key}")
      .replace(/(api_secret: ')\$\{LIVEKIT_API_SECRET[^}]*\}/, "$1${QA_SIP_WORKER_SECRET:?set the synthetic SIP worker secret}");
  }
  stock['asterisk/extensions.conf'] += `
[lab-digest-media]
exten => s,1,Set(REC=/var/spool/asterisk/monitor)
 same => n,MixMonitor(\${REC}/digest-in-mix-\${UNIQUEID}.wav,r(\${REC}/digest-in-rx-\${UNIQUEID}.wav))
 same => n,Wait(1)
 same => n,Playback(agil-tone-b)
 same => n,Wait(4)
 same => n,StopMixMonitor()
 same => n,Hangup()
`;
  for (const [filename, contents] of Object.entries(stock)) {
    if (filename !== 'asterisk/pjsip.conf') await writeFile(path.join(directory, filename), contents);
  }
  if (rotateWorker) await setSfuKeys(stock['livekit.yaml'], [oldWorker]);
  await setWorker(oldWorker);
  for (const [name, spec] of Object.entries(TONES)) await writeFile(path.join(directory, 'asterisk/sounds', name), buildToneWav(spec));
  return { pjsip: stock['asterisk/pjsip.conf'], sfu: stock['livekit.yaml'] };
};

function pjsipFor(base, current) {
  const endpoint = base.match(/\[agil-sip-out\]\s*([\s\S]+?)\[agil-sip-out-aor\]/)[1];
  return base.replace('bind=0.0.0.0:', 'bind=127.0.0.1:')
    .replace('identify_by=ip', 'identify_by=ip\nauth=agil-digest-provider')
    .replace('[agil-sip-out]\n', '[agil-sip-out]\noutbound_auth=agil-digest-current\n') + `
[agil-sip-stale]
outbound_auth=agil-digest-stale
${endpoint}
[agil-digest-provider]
type=auth
auth_type=userpass
username=${outboundUser}
password=${current.outbound}
realm=agil-digest-provider

[agil-digest-current]
type=auth
auth_type=userpass
username=${inboundUser}
password=${current.inbound}

[agil-digest-stale]
type=auth
auth_type=userpass
username=${inboundUser}
password=${old.inbound}
`;
}

async function startAmi() {
  ami = await new AmiClient({ port: port[5038] }).connect();
  await ami.command('pjsip set logger on');
}

const traceOffset = async () => (await stat(traceFile)).size;
async function checkTrace(offset, realm, accepted) {
  return poll(async () => {
    const text = (await readFile(traceFile)).subarray(offset).toString();
    const packets = text.split(/<--- [^\r\n]+ --->\r?\n/).slice(1);
    const callId = (packet) => packet.match(/^Call-ID:\s*(\S+)/mi)?.[1];
    const sequence = (packet) => packet.match(/^CSeq:\s*(\d+) INVITE\r?$/mi)?.[1];
    const headerForRealm = (packet, pattern) => packet.split(/\r?\n/)
      .some((line) => pattern.test(line) && line.includes(`realm="${realm}"`));
    for (const request of packets.filter((packet) => packet.startsWith('INVITE ')
      && headerForRealm(packet, /^(?:Proxy-)?Authorization:\s*Digest/i))) {
      const id = callId(request);
      const seq = sequence(request);
      if (!id || !seq) continue;
      const dialog = packets.filter((packet) => callId(packet) === id);
      if (!dialog.some((packet) => headerForRealm(packet, /^(?:WWW|Proxy)-Authenticate:\s*Digest/i))) continue;
      const statuses = dialog.filter((packet) => sequence(packet) === seq)
        .map((packet) => Number(packet.match(/^SIP\/2\.0 (\d+) /)?.[1])).filter((status) => status >= 200);
      if (accepted && statuses.includes(200)) return 200;
      if (!accepted && statuses.every((status) => status !== 200)) {
        const rejected = statuses.find((status) => [401, 403, 407].includes(status));
        if (rejected) return rejected;
      }
    }
    return false;
  }, { label: `${realm} Digest exchange` });
}

function dial(trunk, identity) {
  return twirp(operator, 'livekit.SIP', 'CreateSIPParticipant', {
    sip_trunk_id: trunk, sip_call_to: outboundNumber, sip_number: callerId,
    room_name: room, participant_identity: identity, ringing_timeout: rotateWorker ? '35s' : '8s', wait_until_answered: true,
  }, roomToken(operator, room, 30, { sipCall: true }));
}

const originate = (peer) => ami.originate({
  channel: `PJSIP/${inboundNumber}@${peer}`, context: 'lab-digest-media', extension: 's', priority: 1,
  timeout: rotateWorker ? 35000 : 10000,
});
async function participants() {
  try {
    return (await listParticipants(operator, room)).filter(isSipParticipant);
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function proveRtp(generation, trunk, { final = false } = {}) {
  const offset = await traceOffset();
  const previous = new Set([...filesWithPrefix(mediaDir, 'a-rx-'), ...filesWithPrefix(mediaDir, 'digest-in-rx-')]);
  if (rotateWorker) {
    await Promise.all([dial(trunk, `${generation}-rtp-a`), originate('agil-sip-out')]);
  } else {
    await dial(trunk, `${generation}-rtp-a`);
    await originate('agil-sip-out');
  }
  await poll(async () => (await participants()).length === 2, { label: `${generation} two active SIP participants` });
  const tone = (prefix, hz) => poll(() => filesWithPrefix(mediaDir, prefix)
    .find((file) => !previous.has(file) && hasAudio(file) && isTone(file, hz, 30)), { label: `${generation} received ${hz} Hz` });
  const [a, b] = await Promise.all([tone('a-rx-', 880), tone('digest-in-rx-', 440)]);
  await checkTrace(offset, 'agil-digest-provider', true);
  await checkTrace(offset, 'agil-digest-inbound', true);
  console.log(`PASS ${generation} secrets authenticated both SIP directions; received ${analyzeTones(a).dominant}/${analyzeTones(b).dominant} Hz over RTP`);
  if (final) return;
  if (rotateWorker) {
    const asterisk = (text) => compose('exec', '-T', 'asterisk', 'asterisk', '-rx', text);
    const { stdout } = await asterisk('core show channels concise');
    for (const row of stdout.trim().split(/\r?\n/).filter((line) => line.includes('!'))) {
      const channel = row.split('!', 1)[0];
      assert.match(channel, /^PJSIP\/agil-(?:livekit|sip-out)-[0-9a-f]+$/i, 'The isolated lab channel must be a fixture SIP leg');
      await asterisk(`channel request hangup ${channel}`);
    }
    await poll(async () => {
      const { stdout } = await asterisk('core show channels count');
      return /^0 active channels?\b/m.test(stdout);
    }, { label: `${generation} Asterisk channels closed` });
  }
  await poll(async () => (await participants()).length === 0, { label: `${generation} call ended` });
}

async function proveWorkerRotation(sfu, trunk) {
  const containerId = async (service) => (await compose('ps', '-q', service)).stdout.trim();
  const recreate = (service) => compose('up', '-d', '--pull', 'never', '--no-deps', '--force-recreate', service);
  const redis = await containerId('redis');
  const worker = await containerId('sip');
  assert.ok(redis && worker);
  async function assertWorkerKey(id, credential) {
    const { stdout } = await docker('inspect', '--format', '{{json .Config.Env}}', id);
    const prefix = 'SIP_CONFIG_BODY=';
    const settings = JSON.parse(stdout).find((line) => line.startsWith(prefix))?.slice(prefix.length).split('\n');
    assert.ok(settings?.includes(`api_key: '${credential.apiKey}'`) && settings.includes(`api_secret: '${credential.apiSecret}'`),
      'The running SIP worker must have its assigned API key and secret');
  }
  await assertWorkerKey(worker, oldWorker);
  await listRooms(oldWorker);
  await assert.rejects(listRooms(newWorker), (error) => error.status === 401);
  await proveRtp('initial-worker', trunk);

  await setSfuKeys(sfu, [oldWorker, newWorker]);
  await recreate('livekit');
  await poll(() => listRooms(operator), { label: 'LiveKit with both worker API keys' });
  await listRooms(oldWorker);
  await listRooms(newWorker);
  await setWorker(newWorker);
  await recreate('sip');
  await poll(async () => (await fetch('http://127.0.0.1:28084/', { signal: AbortSignal.timeout(1000) })).ok,
    { label: 'SIP worker with new API key', timeoutMs: 65000 });
  const updatedWorker = await containerId('sip');
  assert.ok(updatedWorker && updatedWorker !== worker);
  await assertWorkerKey(updatedWorker, newWorker);
  console.log('PASS SFU accepted both worker API keys and the replacement SIP worker loaded the new pair');

  await setSfuKeys(sfu, [newWorker]);
  await recreate('livekit');
  await poll(() => listRooms(operator), { label: 'LiveKit with the old worker API key revoked' });
  await assert.rejects(listRooms(oldWorker), (error) => error.status === 401);
  await listRooms(newWorker);
  assert.equal(await containerId('redis'), redis);
  assert.equal(await containerId('sip'), updatedWorker);
  await assertWorkerKey(updatedWorker, newWorker);
  console.log('PASS SFU returned HTTP 401 for the old worker API key and accepted the new key');
  await proveRtp('rotated-worker', trunk, { final: true });
}

try {
  const base = await prepare();
  const pjsip = path.join(directory, 'asterisk/pjsip.conf');
  await writeFile(pjsip, pjsipFor(base.pjsip, old), { mode: 0o600 });
  stackConfigured = true;
  await compose('up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '75');
  await startAmi();
  const outbound = (name, current) => createOutboundTrunk(operator, {
    name, address: `127.0.0.1:${port[5060]}`, numbers: [callerId], transport: 'SIP_TRANSPORT_UDP',
    auth_username: outboundUser, auth_password: current.outbound,
  });
  const oldTrunk = await outbound('digest-old', old);
  const inbound = await createInboundTrunk(operator, {
    name: 'digest-inbound', numbers: [inboundNumber], allowed_addresses: ['127.0.0.1/32'],
    auth_username: inboundUser, auth_password: old.inbound, auth_realm: 'agil-digest-inbound',
  });
  await createDirectDispatchRule(operator, { name: 'digest-room', trunkIds: [inbound], numbers: [inboundNumber], roomName: room });
  if (rotateWorker) {
    await proveWorkerRotation(base.sfu, oldTrunk);
  } else {
    await proveRtp('old', oldTrunk);

    await twirp(operator, 'livekit.SIP', 'UpdateSIPInboundTrunk', { sip_trunk_id: inbound, update: { auth_password: next.inbound } });
    const newTrunk = await outbound('digest-new', next);
    ami.close();
    ami = undefined;
    await writeFile(pjsip, pjsipFor(base.pjsip, next), { mode: 0o600 });
    await compose('up', '-d', '--pull', 'never', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '50', 'asterisk');
    await startAmi();

    let offset = await traceOffset();
    await assert.rejects(dial(oldTrunk, 'revoked-outbound'), (error) => Boolean(error.status));
    const outboundReject = await checkTrace(offset, 'agil-digest-provider', false);
    assert.equal((await participants()).length, 0);
    console.log(`PASS synthetic provider refused authenticated outbound INVITE with SIP ${outboundReject}`);

    offset = await traceOffset();
    await assert.rejects(originate('agil-sip-stale'), /AMI Originate failed/);
    const inboundReject = await checkTrace(offset, 'agil-digest-inbound', false);
    assert.equal((await participants()).length, 0);
    console.log(`PASS LiveKit SIP refused authenticated inbound INVITE with SIP ${inboundReject}`);

    await proveRtp('new', newTrunk);
  }
} catch (error) {
  if (stackConfigured && rotateWorker) {
    const logs = await compose('logs', '--tail', '12', 'livekit').catch(() => undefined);
    if (logs) console.error([operator, oldWorker, newWorker].reduce(
      (value, entry) => value.replaceAll(entry.apiSecret, '[redacted]'),
      logs.stdout.split('\n').map((line) => line.split('\t').slice(0, 5).join('\t')).join('\n'),
    ));
  }
  throw error;
} finally {
  ami?.close();
  try {
    if (stackConfigured) await compose('down', '--volumes', '--timeout', '8');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
