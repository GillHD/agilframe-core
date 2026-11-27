import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openWs, startTestServer } from './helpers.js';
import { ConversationReview } from '../src/conversation-review.js';
import { createLogger } from '../src/logger.js';
import { Room } from '../src/rooms.js';

const admin = { 'x-api-key': 'dev-key' };
const otherTenant = { 'x-api-key': 'acme-key' };
const policy = { enabled: true, retentionMin: 5, rules: [
  { id: 'restricted-project', category: 'disclosure', severity: 'critical', phrase: 'проект Лира' },
  { id: 'contact-policy', category: 'ethics', severity: 'warn', phrase: 'сорвать встречу' },
] } as const;

test('corporate review requires current unanimous consent and isolates its confidential data', async (t) => {
  const core = await startTestServer();
  t.after(() => core.close());
  assert.equal((await core.api('PATCH', '/v1/tenants/demo/config', {
    headers: admin, body: { features: { captions: true }, session: { transcription: { saveTranscript: false } } },
  })).status, 200);
  const created = await core.api('POST', '/v1/admin/rooms', { headers: admin, body: { name: 'Corporate review fixture' } });
  assert.equal(created.status, 200);
  const roomId = created.body.room.id as string;
  const route = `/v1/admin/rooms/${roomId}/conversation-review`;
  const read = () => core.api('GET', route, { headers: admin });
  const configure = (body: unknown) => core.api('PUT', route, { headers: admin, body });
  assert.deepEqual((await read()).body, { policy: { enabled: false }, findings: [] });
  assert.equal((await core.api('GET', route, { headers: otherTenant })).status, 403);
  assert.equal((await core.api('PUT', route, { headers: otherTenant, body: policy })).status, 403);
  assert.equal((await configure({ ...policy, rules: [policy.rules[0], policy.rules[0]] })).status, 400);

  const connect = async (role: 'host' | 'guest', name: string) => {
    const issued = await core.api('POST', '/v1/tokens', {
      headers: admin, body: { tenantId: 'demo', roomId, participant: { name, role } },
    });
    assert.equal(issued.status, 200);
    const participantAuth = { authorization: `Bearer ${issued.body.token}` };
    assert.equal((await core.api('GET', route, { headers: participantAuth })).status, 401);
    assert.equal((await core.api('PUT', route, { headers: participantAuth, body: policy })).status, 401);
    const socket = await openWs(`${core.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
    await socket.waitFor((message) => message.type === 'welcome');
    return socket;
  };
  const host = await connect('host', 'Host');
  const guest = await connect('guest', 'Guest');
  const emit = t.mock.method(core.server.services.webhooks, 'emit');
  const caption = async (text: string, isFinal = true) => {
    host.send({ type: 'caption', text, isFinal });
    await guest.waitFor((message) => message.type === 'caption' && message.text === text);
  };
  const consent = async (socket: typeof host, revision: string, allowed: boolean) => {
    socket.send({ type: 'conversation-review.consent', revision, allowed });
    await socket.waitFor((message) => message.type === 'conversation-review' && message.revision === revision &&
      message.consent === (allowed ? 'allowed' : 'declined'));
  };
  await caption('проект Лира до включения');
  assert.equal((await configure(policy)).status, 200);
  const notice = await host.waitFor((message) => message.type === 'conversation-review' && message.consent === 'pending');
  assert.equal(notice.rules, undefined);
  await consent(host, notice.revision, true);
  await caption('проект Лира до согласия гостя');
  assert.deepEqual((await read()).body.findings, []);
  await consent(guest, notice.revision, true);
  await caption('субпроект Лира не совпадает');
  await caption('проект Лира промежуточная версия', false);
  assert.deepEqual((await read()).body.findings, []);
  await caption('Упомянут ПРОЕКТ  ЛИРА.');
  await caption('Попытка сорвать встречу.');
  await caption('проект Лира повторно');
  const findings = (await read()).body.findings;
  assert.deepEqual(findings.map(({ ruleId }: { ruleId: string }) => ruleId), ['restricted-project', 'contact-policy']);
  assert.deepEqual(Object.keys(findings[0]).sort(), ['at', 'category', 'ruleId', 'severity']);
  assert.equal(core.server.rooms.get(roomId)?.finalSegments().length, 0);
  assert.ok(!emit.mock.calls.some((call) => JSON.stringify(call.arguments).includes('restricted-project')));
  const audit = await core.api('GET', '/v1/admin/audit?limit=50', { headers: admin });
  assert.ok(!audit.text.includes('проект Лира'));
  guest.send({ type: 'analysis-request' });
  await guest.waitFor((message) => message.type === 'error' && message.code === 'unauthorized');

  await consent(guest, notice.revision, false);
  await caption('проект Лира после отзыва');
  assert.deepEqual((await read()).body.findings, []);
  assert.equal((await configure(policy)).status, 200);
  const renewed = await host.waitFor((message) => message.type === 'conversation-review' && message.revision !== notice.revision);
  host.send({ type: 'conversation-review.consent', revision: notice.revision, allowed: true });
  await consent(guest, renewed.revision, true);
  await caption('проект Лира после устаревшего согласия');
  assert.deepEqual((await read()).body.findings, []);
  await consent(host, renewed.revision, true);
  const late = await connect('guest', 'Late joiner');
  await late.waitFor((message) => message.type === 'conversation-review' && message.consent === 'pending');
  await caption('проект Лира до согласия нового участника');
  assert.deepEqual((await read()).body.findings, []);
  await consent(late, renewed.revision, true);
  await caption('проект Лира после согласия всех');
  assert.equal((await read()).body.findings.length, 1);
  await late.close();
  assert.equal((await core.api('PATCH', '/v1/tenants/demo/config', {
    headers: admin, body: { features: { captions: false } },
  })).status, 200);
  await host.waitFor((message) => message.type === 'conversation-review' && message.revision === null);
  assert.deepEqual((await read()).body, { policy: { enabled: false }, findings: [] });
  assert.equal((await configure(policy)).status, 409);
  assert.equal((await core.api('PATCH', '/v1/tenants/demo/config', {
    headers: admin, body: { features: { captions: true } },
  })).status, 200);
  assert.equal((await configure(policy)).status, 200);
  const beforeE2ee = host.messages.length;
  assert.equal((await core.api('PATCH', '/v1/tenants/demo/config', {
    headers: admin, body: { security: { e2ee: true } },
  })).status, 200);
  await host.waitFor((message) => message.type === 'conversation-review' && message.revision === null &&
    host.messages.indexOf(message) >= beforeE2ee);
  assert.deepEqual((await read()).body, { policy: { enabled: false }, findings: [] });
  assert.equal((await configure(policy)).status, 409);
  assert.equal((await core.api('POST', `/v1/admin/rooms/${roomId}/analysis/run`, { headers: admin })).status, 409);
  await host.close();
  await guest.close();
});

test('review resets consent on resume and exposes only expiring metadata through the archive API', async (t) => {
  const now = Date.UTC(2026, 10, 27);
  t.mock.timers.enable({ apis: ['Date'], now });
  const logs: string[] = [];
  const core = await startTestServer({ logger: createLogger({ sink: (line) => logs.push(line) }) });
  t.after(() => core.close());
  const emit = t.mock.method(core.server.services.webhooks, 'emit');
  assert.equal((await core.api('PATCH', '/v1/tenants/demo/config', {
    headers: admin, body: { features: { captions: true }, session: { transcription: { saveTranscript: false } } },
  })).status, 200);
  const created = await core.api('POST', '/v1/admin/rooms', { headers: admin, body: { name: 'Review archive fixture' } });
  assert.equal(created.status, 200);
  const roomId = created.body.room.id as string;
  const roomRoute = `/v1/admin/rooms/${roomId}`;
  const route = `${roomRoute}/conversation-review`;
  assert.equal((await core.api('PUT', route, { headers: admin, body: { ...policy, retentionMin: 1 } })).status, 200);

  const join = async (role: 'host' | 'guest') => {
    const issued = await core.api('POST', '/v1/tokens', {
      headers: admin, body: { tenantId: 'demo', roomId, participant: { name: role, role } },
    });
    assert.equal(issued.status, 200);
    const token = issued.body.token as string;
    const socket = await openWs(`${core.wsUrl}?resume=1`, ['agil-calls.v1', `agil-token.${encodeURIComponent(token)}`]);
    const welcome = await socket.waitFor((message) => message.type === 'welcome');
    return { token, socket, welcome };
  };
  const host = await join('host');
  const guest = await join('guest');
  const notice = await host.socket.waitFor((message) => message.type === 'conversation-review');
  const revision = notice.revision;
  const allow = async (socket: typeof host.socket) => {
    socket.send({ type: 'conversation-review.consent', revision, allowed: true });
    await socket.waitFor((message) => message.type === 'conversation-review' &&
      message.revision === revision && message.consent === 'allowed');
  };
  await allow(host.socket);
  await allow(guest.socket);
  const resumeToken = guest.welcome.resume?.token;
  assert.equal(typeof resumeToken, 'string');
  await guest.socket.close();
  await host.socket.waitFor((message) => message.type === 'presence' && message.presence === 'reconnecting');
  const resumed = await openWs(`${core.wsUrl}?resume=1`, [
    'agil-calls.v1', `agil-token.${encodeURIComponent(guest.token)}`, `agil-resume.${encodeURIComponent(resumeToken)}`,
  ]);
  const resumedWelcome = await resumed.waitFor((message) => message.type === 'welcome');
  assert.equal(resumedWelcome.resumed, true);
  assert.deepEqual(await resumed.waitFor((message) => message.type === 'conversation-review'),
    { type: 'conversation-review', revision, consent: 'pending' });

  const relayCaption = async (text: string) => {
    host.socket.send({ type: 'caption', text, isFinal: true });
    await resumed.waitFor((message) => message.type === 'caption' && message.text === text);
  };
  await relayCaption('проект Лира до повторного согласия');
  assert.deepEqual((await core.api('GET', route, { headers: admin })).body.findings, []);
  await allow(resumed);
  const canary = 'архивный текст QA B018';
  await relayCaption(`проект Лира ${canary}`);
  const active = await core.api('GET', route, { headers: admin });
  const expectedFinding = { ruleId: 'restricted-project', category: 'disclosure', severity: 'critical', at: now };
  assert.equal(active.headers.get('cache-control'), 'no-store');
  assert.deepEqual(active.body.findings, [expectedFinding]);
  assert.ok(!active.text.includes(canary));

  assert.equal((await core.api('DELETE', roomRoute, { headers: admin })).status, 200);
  const archived = await core.api('GET', route, { headers: admin });
  assert.equal(archived.status, 200);
  assert.equal(archived.headers.get('cache-control'), 'no-store');
  assert.deepEqual(archived.body, { policy: { enabled: false }, findings: [expectedFinding] });
  assert.equal((await core.api('GET', route, { headers: otherTenant })).status, 404);
  assert.equal((await core.api('GET', route, { headers: { authorization: `Bearer ${guest.token}` } })).status, 401);
  assert.equal((await core.api('PUT', route, { headers: admin, body: policy })).status, 404);
  t.mock.timers.setTime(now + 59_999);
  assert.equal((await core.api('GET', route, { headers: admin })).status, 200);
  t.mock.timers.setTime(now + 60_000);
  assert.equal((await core.api('GET', route, { headers: admin })).status, 404);
  const audit = await core.api('GET', '/v1/admin/audit?limit=50', { headers: admin });
  assert.equal(audit.status, 200);
  assert.ok(logs.length > 0);
  assert.ok(emit.mock.calls.length > 0);
  for (const contents of [audit.text, logs.join('\n'), JSON.stringify(emit.mock.calls.map((call) => call.arguments))]) {
    assert.ok(!contents.includes(canary));
    assert.ok(!contents.includes(expectedFinding.ruleId));
  }
});

test('review metadata expires from the closed room archive', () => {
  let now = 10_000;
  const review = new ConversationReview(() => now);
  const room = new Room({ name: 'TTL', tenantId: 'demo', maxParticipants: 2 }, { ttlSec: 0, now: () => now });
  const connection = { send() {}, close() {}, joinedAt: now };
  review.configure(room, { ...policy, retentionMin: 1, rules: [...policy.rules] });
  const status = review.status(room, connection)!;
  review.consent(room, connection, status.revision!, true);
  review.inspect(room, connection, 'проект Лира');
  review.closeRoom(room, true);
  assert.equal(review.archived('demo', room.id)?.findings.length, 1);
  assert.equal(review.archived('acme', room.id), undefined);
  now += 60_000;
  assert.equal(review.archived('demo', room.id), undefined);
  room.close();
});
