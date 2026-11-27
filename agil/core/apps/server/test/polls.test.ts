/** Polls & Q&A: create/list/vote/close, personalization, WS broadcasts, audit. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;
let roomId: string;
let hostToken: string;
let guest1: string;
let guest2: string;

before(async () => {
  ts = await startTestServer();
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Polls room', maxParticipants: 10 } });
  roomId = created.body.room.id;
  const token = async (name: string, role: 'host' | 'guest'): Promise<string> =>
    (
      await ts.api('POST', '/v1/tokens', {
        headers: ADMIN,
        body: { tenantId: 'demo', roomId, participant: { name, role } },
      })
    ).body.token;
  hostToken = await token('Host', 'host');
  guest1 = await token('Guest 1', 'guest');
  guest2 = await token('Guest 2', 'guest');
});

after(async () => {
  await ts.close();
});

async function createPoll(body: Record<string, unknown>, token = hostToken): Promise<{ status: number; body: any }> {
  return ts.api('POST', `/v1/rooms/${roomId}/polls`, {
    headers: { authorization: `Bearer ${token}` },
    body,
  });
}

test('polls: host creates, WS broadcast, guest denied, validation', async () => {
  const host = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(hostToken)}`);
  await host.waitFor((message) => message.type === 'welcome');

  const createdEvent = host.waitFor((message) => message.type === 'poll.updated' && message.reason === 'created');
  const created = await createPoll({
    question: 'Куда идём на обед?',
    options: [{ text: 'Пицца' }, { text: 'Суши' }, { text: 'Салат' }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.status, 'open');
  assert.equal(created.body.options.length, 3);
  assert.equal(created.body.totalVotes, 0);
  assert.equal(created.body.kind, 'poll');
  const wsEvent = await createdEvent;
  assert.equal(wsEvent.poll.id, created.body.id);

  const guestDenied = await createPoll({ question: 'Вопрос?', options: [{ text: 'A' }, { text: 'B' }] }, guest1);
  assert.equal(guestDenied.status, 403);
  const noAuth = await ts.api('POST', `/v1/rooms/${roomId}/polls`, { body: { question: 'Вопрос?', options: [{ text: 'A' }, { text: 'B' }] } });
  assert.equal(noAuth.status, 401);

  assert.equal((await createPoll({ question: 'ab', options: [{ text: 'A' }, { text: 'B' }] })).status, 400);
  assert.equal((await createPoll({ question: 'Valid question', options: [{ text: 'A' }] })).status, 400);
  assert.equal(
    (await createPoll({ question: 'Valid question', options: Array.from({ length: 11 }, (_, index) => ({ text: `O${index}` })) })).status,
    400,
  );

  // Admin key may create/list too.
  const byAdmin = await ts.api('POST', `/v1/rooms/${roomId}/polls`, {
    headers: ADMIN,
    body: { question: 'Admin poll question', options: [{ text: 'A' }, { text: 'B' }] },
  });
  assert.equal(byAdmin.status, 200);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { type: string }) => entry.type === 'poll.created'));
  await host.close();
});

test('polls: voting, personalization, repeat/multiple/invalid options, results', async () => {
  const created = await createPoll({
    question: 'Выберите вариант',
    options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
  });
  const [a, b] = created.body.options.map((option: { id: string }) => option.id);

  assert.equal((await ts.api('GET', `/v1/rooms/${roomId}/polls`)).status, 401);
  const guestList = await ts.api('GET', `/v1/rooms/${roomId}/polls`, { headers: { authorization: `Bearer ${guest1}` } });
  assert.equal(guestList.status, 200);
  const listed = guestList.body.polls.find((poll: { id: string }) => poll.id === created.body.id);
  assert.equal(listed.voted, false);
  assert.equal(listed.options[0].selected, false);

  const vote = await ts.api('POST', `/v1/rooms/${roomId}/polls/${created.body.id}/vote`, {
    headers: { authorization: `Bearer ${guest1}` },
    body: { optionIds: [a] },
  });
  assert.equal(vote.status, 200, JSON.stringify(vote.body));
  assert.equal(vote.body.accepted, true);
  assert.equal(vote.body.poll.voted, true);
  assert.equal(vote.body.poll.totalVotes, 1);
  assert.equal(vote.body.poll.options.find((option: { id: string }) => option.id === a).selected, true);

  const repeated = await ts.api('POST', `/v1/rooms/${roomId}/polls/${created.body.id}/vote`, {
    headers: { authorization: `Bearer ${guest1}` },
    body: { optionIds: [b] },
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.accepted, false);
  assert.equal(repeated.body.reason, 'already_voted');

  const voteGuest2 = await ts.api('POST', `/v1/rooms/${roomId}/polls/${created.body.id}/vote`, {
    headers: { authorization: `Bearer ${guest2}` },
    body: { optionIds: [b] },
  });
  assert.equal(voteGuest2.body.accepted, true);
  const results = voteGuest2.body.poll;
  assert.equal(results.totalVotes, 2);
  const optionA = results.options.find((option: { id: string }) => option.id === a);
  const optionB = results.options.find((option: { id: string }) => option.id === b);
  assert.equal(optionA.votes, 1);
  assert.equal(optionB.votes, 1);
  assert.equal(optionA.share, 0.5);
  assert.equal(optionB.share, 0.5);

  const singleChoice = await createPoll({ question: 'Один вариант', options: [{ text: 'A' }, { text: 'B' }] });
  const invalid = await ts.api('POST', `/v1/rooms/${roomId}/polls/${singleChoice.body.id}/vote`, {
    headers: { authorization: `Bearer ${guest1}` },
    body: { optionIds: ['not-an-option'] },
  });
  assert.equal(invalid.body.accepted, false);
  assert.equal(invalid.body.reason, 'invalid_option');
  const twoInSingle = await ts.api('POST', `/v1/rooms/${roomId}/polls/${singleChoice.body.id}/vote`, {
    headers: { authorization: `Bearer ${guest1}` },
    body: { optionIds: singleChoice.body.options.map((option: { id: string }) => option.id) },
  });
  assert.equal(twoInSingle.body.accepted, false);
  assert.equal(twoInSingle.body.reason, 'single_choice_only');

  const multiple = await createPoll({
    question: 'Выберите несколько',
    options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
    multiple: true,
  });
  const multiVote = await ts.api('POST', `/v1/rooms/${roomId}/polls/${multiple.body.id}/vote`, {
    headers: { authorization: `Bearer ${guest1}` },
    body: { optionIds: multiple.body.options.slice(0, 2).map((option: { id: string }) => option.id) },
  });
  assert.equal(multiVote.body.accepted, true);
  assert.equal(multiVote.body.poll.options.filter((option: { selected?: boolean }) => option.selected).length, 2);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { type: string }) => entry.type === 'poll.voted'));

  // Foreign-room token cannot vote here.
  const otherRoom = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Other polls' } });
  const foreign = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId: otherRoom.body.room.id, participant: { name: 'Other', role: 'guest' } },
  });
  const foreignVote = await ts.api('POST', `/v1/rooms/${roomId}/polls/${created.body.id}/vote`, {
    headers: { authorization: `Bearer ${foreign.body.token}` },
    body: { optionIds: [a] },
  });
  assert.equal(foreignVote.status, 403);
});

test('polls: close, voting after close, 404, audit and WS', async () => {
  const host = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(hostToken)}`);
  await host.waitFor((message) => message.type === 'welcome');
  const created = await createPoll({ question: 'Закрыть меня', options: [{ text: 'A' }, { text: 'B' }] });
  const closeEvent = host.waitFor((message) => message.type === 'poll.updated' && message.reason === 'closed');
  const closed = await ts.api('POST', `/v1/rooms/${roomId}/polls/${created.body.id}/close`, {
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'closed');
  assert.equal(typeof closed.body.closedAt, 'number');
  const wsClosed = await closeEvent;
  assert.equal(wsClosed.poll.status, 'closed');

  const deniedClose = await ts.api('POST', `/v1/rooms/${roomId}/polls/${created.body.id}/close`, {
    headers: { authorization: `Bearer ${guest1}` },
  });
  assert.equal(deniedClose.status, 403);
  const voteAfterClose = await ts.api('POST', `/v1/rooms/${roomId}/polls/${created.body.id}/vote`, {
    headers: { authorization: `Bearer ${guest2}` },
    body: { optionIds: [created.body.options[0].id] },
  });
  assert.equal(voteAfterClose.status, 409);
  assert.equal(voteAfterClose.body.error.code, 'poll_closed');
  assert.equal(
    (await ts.api('POST', `/v1/rooms/${roomId}/polls/${created.body.id}/vote`, {
      headers: { authorization: `Bearer ${guest2}` },
      body: { optionIds: [] },
    })).status,
    400,
  );
  assert.equal(
    (await ts.api('POST', `/v1/rooms/${roomId}/polls/nope/close`, { headers: ADMIN })).status,
    404,
  );
  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { type: string }) => entry.type === 'poll.closed'));
  await host.close();
});

test('polls: per-room limit is enforced', async () => {
  const room = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Limit polls' } });
  const limitRoomId = room.body.room.id;
  const token = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId: limitRoomId, participant: { name: 'Host', role: 'host' } },
  });
  for (let index = 0; index < 50; index += 1) {
    const response = await ts.api('POST', `/v1/rooms/${limitRoomId}/polls`, {
      headers: { authorization: `Bearer ${token.body.token}` },
      body: { question: `Poll number ${index + 1}`, options: [{ text: 'A' }, { text: 'B' }] },
    });
    assert.equal(response.status, 200, `create ${index + 1}: ${JSON.stringify(response.body)}`);
  }
  const overLimit = await ts.api('POST', `/v1/rooms/${limitRoomId}/polls`, {
    headers: { authorization: `Bearer ${token.body.token}` },
    body: { question: 'Over the limit', options: [{ text: 'A' }, { text: 'B' }] },
  });
  assert.equal(overLimit.status, 409);
  assert.equal(overLimit.body.error.code, 'poll_limit');
});
