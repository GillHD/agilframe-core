/** Wave-1 P1 server features: waiting-room lobby, calendar ICS, custom domain. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const ACME = { 'x-api-key': 'acme-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

async function createRoom(name = 'Lobby room'): Promise<{ roomId: string; hostToken: string }> {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name, maxParticipants: 10 } });
  assert.equal(created.status, 200);
  const roomId = created.body.room.id;
  const host = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Host', role: 'host' } },
  });
  return { roomId, hostToken: host.body.token };
}

test('waiting room: pending 202, host queue, admit, poll token once, audit + WS events', async () => {
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { security: { waitingRoom: true } } });
  const { roomId, hostToken } = await createRoom();
  const host = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(hostToken)}`);
  const welcome = await host.waitFor((message) => message.type === 'welcome');
  assert.equal(welcome.self.role, 'host');
  // Host gets the current queue on welcome (empty here).
  const queue = await host.waitFor((message) => message.type === 'lobby.queue');
  assert.deepEqual(queue.requests, []);

  const pendingEvent = host.waitFor((message) => message.type === 'lobby.pending');
  const join = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Гость', locale: 'ru' } });
  assert.equal(join.status, 202, JSON.stringify(join.body));
  assert.equal(join.body.pending, true);
  assert.equal(join.body.status, 'pending');
  assert.equal(typeof join.body.requestId, 'string');
  assert.equal(join.body.token, undefined, 'no token while pending');
  const event = await pendingEvent;
  assert.equal(event.request.name, 'Гость');

  // Guest cannot read the queue; admin key can.
  const guestToken = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Guest', role: 'guest' } },
  });
  assert.equal((await ts.api('GET', `/v1/rooms/${roomId}/lobby`, { headers: { authorization: `Bearer ${guestToken.body.token}` } })).status, 403);
  const queueRes = await ts.api('GET', `/v1/rooms/${roomId}/lobby`, { headers: ADMIN });
  assert.equal(queueRes.status, 200);
  assert.equal(queueRes.body.requests.length, 1);
  assert.equal(queueRes.body.requests[0].status, 'pending');
  assert.equal(typeof queueRes.body.requests[0].expiresAt, 'number');

  const admittedEvent = host.waitFor((message) => message.type === 'lobby.admitted');
  const admitted = await ts.api('POST', `/v1/rooms/${roomId}/lobby/${join.body.requestId}/admit`, { headers: ADMIN });
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
  assert.equal(typeof admitted.body.token, 'string');
  assert.equal(admitted.body.participant.name, 'Гость');
  const admittedWs = await admittedEvent;
  assert.equal(admittedWs.participant.name, 'Гость');

  // The guest polls: token is returned exactly once.
  const poll1 = await ts.api('GET', `/v1/rooms/${roomId}/lobby/${join.body.requestId}`);
  assert.equal(poll1.status, 200);
  assert.equal(poll1.body.status, 'admitted');
  assert.equal(typeof poll1.body.token, 'string');
  const poll2 = await ts.api('GET', `/v1/rooms/${roomId}/lobby/${join.body.requestId}`);
  assert.equal(poll2.body.status, 'admitted');
  assert.equal(poll2.body.token, undefined, 'token is delivered only once');

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const types = audit.body.entries.map((entry: { type: string }) => entry.type);
  assert.ok(types.includes('lobby.pending'));
  assert.ok(types.includes('lobby.admitted'));
  await host.close();
});

test('waiting room: reject, kick from queue and audit; waitingRoom=false unchanged', async () => {
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { security: { waitingRoom: true } } });
  const { roomId, hostToken } = await createRoom('Reject room');
  const host = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(hostToken)}`);
  await host.waitFor((message) => message.type === 'welcome');

  const pending1 = host.waitFor((message) => message.type === 'lobby.pending');
  const join1 = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Reject me' } });
  await pending1;
  const rejectedEvent = host.waitFor((message) => message.type === 'lobby.rejected');
  const rejected = await ts.api('POST', `/v1/rooms/${roomId}/lobby/${join1.body.requestId}/reject`, {
    headers: ADMIN,
    body: { reason: 'busy' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');
  const rejectedWs = await rejectedEvent;
  assert.equal(rejectedWs.reason, 'busy');
  const poll = await ts.api('GET', `/v1/rooms/${roomId}/lobby/${join1.body.requestId}`);
  assert.equal(poll.body.status, 'rejected');
  assert.equal(poll.body.reason, 'busy');

  const pending2 = host.waitFor((message) => message.type === 'lobby.pending');
  const join2 = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Kick me' } });
  await pending2;
  const kicked = await ts.api('DELETE', `/v1/rooms/${roomId}/lobby/${join2.body.requestId}`, { headers: ADMIN });
  assert.equal(kicked.status, 200);
  assert.equal((await ts.api('GET', `/v1/rooms/${roomId}/lobby/${join2.body.requestId}`)).body.reason, 'kicked');
  await host.close();

  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { security: { waitingRoom: false } } });
  const open = await createRoom('Open room');
  const direct = await ts.api('POST', `/v1/rooms/${open.roomId}/join`, { body: { name: 'Direct' } });
  assert.equal(direct.status, 200, 'waitingRoom=false keeps the old behaviour');
  assert.equal(typeof direct.body.token, 'string');
});

test('waiting room: TTL expiry and queue limit', async () => {
  const ttl = await startTestServer({ lobbyTtlSec: 1, lobbyMax: 1 });
  try {
    await ttl.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { security: { waitingRoom: true } } });
    const created = await ttl.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'TTL room' } });
    const roomId = created.body.room.id;
    const first = await ttl.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'One' } });
    assert.equal(first.status, 202);
    const full = await ttl.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Two' } });
    assert.equal(full.status, 409);
    assert.equal(full.body.error.code, 'lobby_full');

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const host = await ttl.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId, participant: { name: 'Host', role: 'host' } },
    });
    const queue = await ttl.api('GET', `/v1/rooms/${roomId}/lobby`, { headers: ADMIN });
    assert.deepEqual(queue.body.requests, [], 'expired request is not listed');
    const poll = await ttl.api('GET', `/v1/rooms/${roomId}/lobby/${first.body.requestId}`);
    assert.equal(poll.body.status, 'expired');
    assert.equal(typeof host.body.token, 'string');
  } finally {
    await ttl.close();
  }
});

test('calendar.ics: valid VCALENDAR/VEVENT, UTC dates, download header, 404', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Планёрка, команда №1' } });
  const roomId = created.body.room.id;
  const start = '2026-12-01T10:00:00.000Z';
  const ics = await ts.api('GET', `/v1/rooms/${roomId}/calendar.ics?start=${encodeURIComponent(start)}&durationMin=45`);
  assert.equal(ics.status, 200);
  assert.ok(ics.headers.get('content-type')?.includes('text/calendar'));
  assert.ok(ics.text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.text.includes('VERSION:2.0'));
  assert.ok(ics.text.includes('BEGIN:VEVENT'));
  assert.ok(ics.text.includes('DTSTART:20261201T100000Z'));
  assert.ok(ics.text.includes('DTEND:20261201T104500Z'));
  assert.ok(ics.text.includes(`UID:${roomId}@`));
  assert.ok(ics.text.includes('SUMMARY:Планёрка\\, команда №1'));
  assert.ok(ics.text.includes('URL:'));
  assert.ok(ics.text.includes('END:VCALENDAR'));

  const download = await ts.api('GET', `/v1/rooms/${roomId}/calendar.ics?download=1`);
  assert.equal(download.status, 200);
  assert.ok(download.headers.get('content-disposition')?.includes('attachment'));
  assert.equal((await ts.api('GET', '/v1/rooms/nope/calendar.ics')).status, 404);
  assert.equal((await ts.api('GET', `/v1/rooms/${roomId}/calendar.ics?start=not-a-date`)).status, 400);
});

test('custom domain: format validation, tenant isolation, audit, reset', async () => {
  const initial = await ts.api('GET', '/v1/admin/domain', { headers: ADMIN });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.domain, '');
  assert.equal(initial.body.verified, false);
  assert.equal(initial.body.dnsInstructions.type, 'CNAME');
  // No domain configured yet: the instruction must not invent a host (`calls.${host}`).
  assert.equal(initial.body.dnsInstructions.name, '');
  assert.equal(initial.body.dnsInstructions.value, 'calls.example.com');
  assert.ok(initial.body.docsHint.length > 0);

  for (const invalid of ['https://meet.example.com', 'meet example.com', 'localhost', '192.168.1.1', 'meet.example.com/path', '*.example.com']) {
    const response = await ts.api('PUT', '/v1/admin/domain', { headers: ADMIN, body: { domain: invalid } });
    assert.equal(response.status, 400, `expected 400 for ${invalid}`);
  }

  const set = await ts.api('PUT', '/v1/admin/domain', { headers: ADMIN, body: { domain: 'Meet.Example.COM.' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.domain, 'meet.example.com');
  assert.equal(set.body.verified, false);
  assert.equal(set.body.dnsInstructions.name, 'meet.example.com');
  const config = await ts.api('GET', '/v1/tenants/demo/config');
  assert.equal(config.body.config.branding.customDomain, 'meet.example.com');

  // Tenant isolation: acme has its own domain field.
  const acmeSet = await ts.api('PUT', '/v1/admin/domain', { headers: ACME, body: { domain: 'acme.example.com' } });
  assert.equal(acmeSet.status, 200);
  const acmeConfig = await ts.api('GET', '/v1/tenants/acme/config');
  assert.equal(acmeConfig.body.config.branding.customDomain, 'acme.example.com');
  assert.equal((await ts.api('GET', '/v1/tenants/demo/config')).body.config.branding.customDomain, 'meet.example.com');

  const audit = await ts.api('GET', '/v1/admin/audit?limit=50', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { type: string }) => entry.type === 'domain.updated'));

  const removed = await ts.api('DELETE', '/v1/admin/domain', { headers: ADMIN });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.domain, '');
  assert.equal((await ts.api('GET', '/v1/tenants/demo/config')).body.config.branding.customDomain, '');
  assert.equal((await ts.api('GET', '/v1/admin/domain', { headers: ADMIN })).body.domain, '');
});
