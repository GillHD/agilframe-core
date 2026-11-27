/** Breakout rooms: start/list/close/return, WS assignments, TTL, validation, audit. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

async function setupRoom(
  count: number,
  name = 'Breakout main',
): Promise<{
  roomId: string;
  tokens: string[];
  clients: Awaited<ReturnType<typeof openWs>>[];
  ids: string[];
}> {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name, maxParticipants: 10 } });
  const roomId = created.body.room.id;
  const tokens: string[] = [];
  const clients = [];
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const role = index === 0 ? 'host' : 'guest';
    const issued = await ts.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId, participant: { name: `P${index}`, role } },
    });
    tokens.push(issued.body.token);
    const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
    const welcome = await client.waitFor((message) => message.type === 'welcome');
    ids.push(welcome.self.id);
    clients.push(client);
  }
  return { roomId, tokens, clients, ids };
}

test('breakout random: start, assignments, WS, child rooms, list, close, main token stays valid', async () => {
  const { roomId, tokens, clients, ids } = await setupRoom(4);
  const host = clients[0]!;

  const started = host.waitFor((message) => message.type === 'breakout.started');
  const hostAssigned = host.waitFor((message) => message.type === 'breakout.assigned');
  const guestAssigned = clients[1]!.waitFor((message) => message.type === 'breakout.assigned');
  const response = await ts.api('POST', `/v1/rooms/${roomId}/breakouts/start`, {
    headers: { authorization: `Bearer ${tokens[0]}` },
    body: { mode: 'random', count: 2 },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const plan = response.body;
  assert.equal(plan.status, 'active');
  assert.equal(plan.mode, 'random');
  assert.equal(plan.rooms.length, 2);
  assert.equal(Object.keys(plan.assignments).length, 4);
  assert.deepEqual(plan.rooms.map((room: { name: string }) => room.name), ['Подкомната 1', 'Подкомната 2']);
  const startedEvent = await started;
  assert.equal(startedEvent.plan.id, plan.id);
  const hostAssignment = await hostAssigned;
  assert.ok(hostAssignment.assignment.token);
  assert.ok(hostAssignment.assignment.joinUrl.includes(hostAssignment.assignment.roomId));
  const guestAssignment = await guestAssigned;
  assert.equal(guestAssignment.assignment.planId, plan.id);

  // Child rooms exist in the store and are hidden from the admin rooms list.
  const listed = await ts.api('GET', '/v1/admin/rooms', { headers: ADMIN });
  const listedIds = listed.body.rooms.map((entry: { room: { id: string } }) => entry.room.id);
  for (const info of plan.rooms) {
    assert.equal((await ts.api('GET', `/v1/rooms/${info.roomId}`, { headers: ADMIN })).status, 200);
    assert.ok(!listedIds.includes(info.roomId), 'child breakout rooms are hidden from the main rooms list');
  }

  // Queue/list permissions + admin.
  assert.equal((await ts.api('GET', `/v1/rooms/${roomId}/breakouts`, { headers: { authorization: `Bearer ${tokens[1]}` } })).status, 403);
  const listedPlan = await ts.api('GET', `/v1/rooms/${roomId}/breakouts`, { headers: ADMIN });
  assert.equal(listedPlan.status, 200);
  assert.equal(listedPlan.body.plan.id, plan.id);
  assert.equal((await ts.api('POST', `/v1/rooms/${roomId}/breakouts/start`, { headers: ADMIN, body: { mode: 'random', count: 2 } })).status, 409);

  // Close: plan closed, child rooms removed, broadcast, main token still works.
  const closedEvent = host.waitFor((message) => message.type === 'breakout.closed');
  const closed = await ts.api('POST', `/v1/rooms/${roomId}/breakouts/close`, {
    headers: { authorization: `Bearer ${tokens[0]}` },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'closed');
  assert.equal(typeof closed.body.closedAt, 'number');
  await closedEvent;
  for (const info of plan.rooms) {
    assert.equal((await ts.api('GET', `/v1/rooms/${info.roomId}`, { headers: ADMIN })).status, 404, 'child room closed');
  }
  const mainJoin = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    headers: { authorization: `Bearer ${tokens[0]}` },
    body: { name: 'Returning host' },
  });
  assert.equal(mainJoin.status, 200, 'the main-room token stays valid');
  assert.equal((await ts.api('GET', `/v1/rooms/${roomId}/breakouts`, { headers: ADMIN })).body.plan.status, 'closed');

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const types = audit.body.entries.map((entry: { type: string }) => entry.type);
  assert.ok(types.includes('breakout.started'));
  assert.ok(types.includes('breakout.closed'));

  for (const client of clients) await client.close();
  void ids;
});

test('breakout manual: assignments by participantIds, return endpoint, allowReturn=false', async () => {
  const { roomId, tokens, clients, ids } = await setupRoom(3, 'Breakout manual');
  const assignedA = clients[0]!.waitFor((message) => message.type === 'breakout.assigned');
  const manual = await ts.api('POST', `/v1/rooms/${roomId}/breakouts/start`, {
    headers: { authorization: `Bearer ${tokens[0]}` },
    body: {
      mode: 'manual',
      rooms: [
        { name: 'Дизайн', participantIds: [ids[0], ids[1]] },
        { name: 'Разработка', participantIds: [ids[2]] },
      ],
      allowReturn: true,
    },
  });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.rooms[0].name, 'Дизайн');
  assert.equal(manual.body.rooms[0].participantIds.length, 2);
  assert.equal(manual.body.rooms[1].participantIds[0], ids[2]);
  await assignedA;

  const returned = await ts.api('POST', `/v1/rooms/${roomId}/breakouts/return`, {
    headers: { authorization: `Bearer ${tokens[1]}` },
  });
  assert.equal(returned.status, 200);
  assert.equal(returned.body.returnToRoomId, roomId);
  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(
    audit.body.entries.some(
      (entry: { details?: { kind?: string } }) => entry.details?.kind === 'breakout.returned',
    ),
  );

  // Unknown/duplicate participant ids are rejected.
  const invalid = await ts.api('POST', `/v1/rooms/${roomId}/breakouts/close`, { headers: ADMIN });
  assert.equal(invalid.status, 200);
  const unknown = await ts.api('POST', `/v1/rooms/${roomId}/breakouts/start`, {
    headers: ADMIN,
    body: { mode: 'manual', rooms: [{ participantIds: ['ghost'] }, { participantIds: [] }] },
  });
  assert.equal(unknown.status, 400);

  const noReturn = await ts.api('POST', `/v1/rooms/${roomId}/breakouts/start`, {
    headers: ADMIN,
    body: { mode: 'random', count: 2, allowReturn: false },
  });
  assert.equal(noReturn.status, 200);
  const denied = await ts.api('POST', `/v1/rooms/${roomId}/breakouts/return`, {
    headers: { authorization: `Bearer ${tokens[1]}` },
  });
  assert.equal(denied.status, 403);
  for (const client of clients) await client.close();
});

test('breakout validation, not enough participants, TTL lazy close, 400 limits', async () => {
  const solo = await setupRoom(1, 'Solo breakout');
  const notEnough = await ts.api('POST', `/v1/rooms/${solo.roomId}/breakouts/start`, { headers: ADMIN, body: { mode: 'random', count: 2 } });
  assert.equal(notEnough.status, 409);
  assert.equal(notEnough.body.error.code, 'not_enough_participants');
  await solo.clients[0]!.close();

  const room = await setupRoom(2, 'Breakout limits');
  const tooMany = await ts.api('POST', `/v1/rooms/${room.roomId}/breakouts/start`, { headers: ADMIN, body: { mode: 'random', count: 21 } });
  assert.equal(tooMany.status, 400);
  const oneRoom = await ts.api('POST', `/v1/rooms/${room.roomId}/breakouts/start`, { headers: ADMIN, body: { mode: 'random', count: 1 } });
  assert.equal(oneRoom.status, 400);
  const badManual = await ts.api('POST', `/v1/rooms/${room.roomId}/breakouts/start`, { headers: ADMIN, body: { mode: 'manual', rooms: [{ participantIds: [] }] } });
  assert.equal(badManual.status, 400);

  const started = await ts.api('POST', `/v1/rooms/${room.roomId}/breakouts/start`, {
    headers: ADMIN,
    body: { mode: 'random', count: 2, durationMin: 1 },
  });
  assert.equal(started.status, 200);
  assert.ok(started.body.endsAt > Date.now());
  // Simulate the clock passing: lazy close on the next GET must close the plan.
  const liveRoom = ts.server.rooms.get(room.roomId)!;
  liveRoom.breakoutPlan!.endsAt = Date.now() - 1;
  const after = await ts.api('GET', `/v1/rooms/${room.roomId}/breakouts`, { headers: ADMIN });
  assert.equal(after.body.plan.status, 'closed');
  const audit = await ts.api('GET', '/v1/admin/audit?limit=200', { headers: ADMIN });
  const closedEntries = audit.body.entries.filter((entry: { type: string }) => entry.type === 'breakout.closed');
  assert.ok(closedEntries.length >= 1);
  for (const client of room.clients) await client.close();
});
