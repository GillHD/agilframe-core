/** WebSocket signaling: welcome/presence, SDP/ICE relay, chat, relay messages. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { delay, openWs, startTestServer, waitForClose, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

async function roomWithTokens(names: string[], recordingRoom = false): Promise<{ roomId: string; tokens: string[] }> {
  const created = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: {
      name: 'WS room',
      ...(recordingRoom ? { configOverrides: { features: { recording: true }, session: { recording: { enabled: true } } } } : {}),
    },
  });
  const roomId = created.body.room.id;
  const tokens: string[] = [];
  for (const [index, name] of names.entries()) {
    const issued = await ts.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId, participant: { name, ...(recordingRoom && index === 0 ? { role: 'host' } : {}) } },
    });
    tokens.push(issued.body.token);
  }
  return { roomId, tokens };
}

test('two clients: welcome, peer-joined, SDP/ICE relay, chat, state/reaction/caption, ping, peer-left', async () => {
  const { roomId, tokens } = await roomWithTokens(['Alisa', 'Bob']);
  const alisa = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(tokens[0] as string)}`);
  const alisaWelcome = await alisa.waitFor((message) => message.type === 'welcome');
  assert.equal(alisaWelcome.room.id, roomId);
  assert.equal(alisaWelcome.self.name, 'Alisa');
  assert.ok(Array.isArray(alisaWelcome.self.permissions));
  assert.ok(Array.isArray(alisaWelcome.history));
  assert.ok(Array.isArray(alisaWelcome.iceServers));

  const bob = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(tokens[1] as string)}`);
  const bobWelcome = await bob.waitFor((message) => message.type === 'welcome');
  assert.equal(bobWelcome.self.name, 'Bob');
  assert.equal(bobWelcome.participants.length, 1);
  assert.equal(bobWelcome.participants[0].id, alisaWelcome.self.id);

  const joined = await alisa.waitFor((message) => message.type === 'peer-joined');
  assert.equal(joined.participant.id, bobWelcome.self.id);

  // SDP relay: the mesh initiator is the client with the smaller participant id.
  alisa.send({ type: 'sdp', to: bobWelcome.self.id, description: { type: 'offer', sdp: 'v=0\r\n' } });
  const sdp = await bob.waitFor((message) => message.type === 'sdp');
  assert.equal(sdp.from, alisaWelcome.self.id);
  assert.equal(sdp.description.type, 'offer');

  alisa.send({ type: 'ice', to: bobWelcome.self.id, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1234 typ host', sdpMid: '0' } });
  const ice = await bob.waitFor((message) => message.type === 'ice');
  assert.equal(ice.from, alisaWelcome.self.id);
  assert.ok(ice.candidate.candidate.includes('candidate'));

  const unknown = await (async () => {
    alisa.send({ type: 'sdp', to: 'ghost', description: { type: 'offer', sdp: 'x' } });
    return alisa.waitFor((message) => message.type === 'error' && message.code === 'unknown_peer');
  })();
  assert.equal(unknown.code, 'unknown_peer');

  alisa.send({ type: 'chat', id: 'chat-1', text: 'привет из теста' });
  const chatOnAlisa = await alisa.waitFor((message) => message.type === 'chat' && message.message.id === 'chat-1');
  const chatOnBob = await bob.waitFor((message) => message.type === 'chat' && message.message.id === 'chat-1');
  assert.equal(chatOnAlisa.message.text, 'привет из теста');
  assert.equal(chatOnBob.message.from.name, 'Alisa');

  bob.send({ type: 'history', limit: 10 });
  const history = await bob.waitFor((message) => message.type === 'chat-history');
  assert.ok(history.messages.some((message: { id: string }) => message.id === 'chat-1'));

  alisa.send({ type: 'state', state: { mic: 'off', handRaised: true } });
  const state = await bob.waitFor((message) => message.type === 'state' && message.participantId === alisaWelcome.self.id);
  assert.equal(state.state.mic, 'off');

  alisa.send({ type: 'reaction', emoji: '👍' });
  const reaction = await bob.waitFor((message) => message.type === 'reaction');
  assert.equal(reaction.emoji, '👍');

  alisa.send({ type: 'caption', text: 'тестовая фраза', isFinal: true, lang: 'ru' });
  const caption = await bob.waitFor((message) => message.type === 'caption');
  assert.equal(caption.text, 'тестовая фраза');

  alisa.send({ type: 'ping', ts: 42 });
  const pong = await alisa.waitFor((message) => message.type === 'pong');
  assert.equal(pong.ts, 42);

  const invalidReply = (async () => {
    alisa.send('{not json');
    return alisa.waitFor((message) => message.type === 'error' && message.code === 'bad_request');
  })();
  assert.equal((await invalidReply).code, 'bad_request');
  alisa.send({ type: 'ping', ts: 43 });
  assert.equal((await alisa.waitFor((message) => message.type === 'pong' && message.ts === 43)).ts, 43);

  const peerLeft = bob.waitFor((message) => message.type === 'peer-left' && message.participantId === alisaWelcome.self.id);
  await alisa.close();
  assert.equal((await peerLeft).participantId, alisaWelcome.self.id);
  await bob.close();
});

test('recording state is broadcast to the room and replayed to late joiners', async () => {
  const { roomId, tokens } = await roomWithTokens(['Recorder', 'Witness', 'Late'], true);
  const recorder = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(tokens[0] as string)}`);
  const recorderWelcome = await recorder.waitFor((message) => message.type === 'welcome');
  const witness = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(tokens[1] as string)}`);
  await witness.waitFor((message) => message.type === 'welcome');
  await recorder.waitFor((message) => message.type === 'peer-joined');

  const startedAt = Date.now();
  witness.send({ type: 'state', state: { recording: true, recordingStartedAt: startedAt } });
  const denied = await witness.waitFor((message) => message.type === 'error');
  assert.equal(denied.code, 'unauthorized');
  recorder.send({ type: 'state', state: { recording: true, recordingStartedAt: startedAt } });
  const startFrame = await witness.waitFor(
    (message) => message.type === 'state' && message.participantId === recorderWelcome.self.id && message.state.recording === true,
  );
  assert.equal(startFrame.state.recordingStartedAt, startedAt);

  // A participant joining while recording is already live must see it in welcome.
  const late = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(tokens[2] as string)}`);
  const lateWelcome = await late.waitFor((message) => message.type === 'welcome');
  const recorderParticipant = lateWelcome.participants.find(
    (participant: { id: string }) => participant.id === recorderWelcome.self.id,
  );
  assert.equal(recorderParticipant?.state.recording, true);
  assert.equal(recorderParticipant?.state.recordingStartedAt, startedAt);

  recorder.send({ type: 'state', state: { recording: false, recordingStartedAt: null } });
  const stopFrame = await witness.waitFor(
    (message) => message.type === 'state' && message.participantId === recorderWelcome.self.id && message.state.recording === false,
  );
  assert.equal(stopFrame.state.recordingStartedAt, null);
  await late.waitFor(
    (message) => message.type === 'state' && message.participantId === recorderWelcome.self.id && message.state.recording === false,
  );

  const moderatorToken = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Call moderator', role: 'moderator' } },
  });
  assert.equal(moderatorToken.status, 200);
  const moderator = await openWs(ts.wsUrl, ['agil-calls.v1', `agil-token.${moderatorToken.body.token}`]);
  const moderatorWelcome = await moderator.waitFor((message) => message.type === 'welcome');
  assert.ok(moderatorWelcome.self.permissions.includes('recording'));
  moderator.send({ type: 'state', state: { recording: true, recordingStartedAt: startedAt } });
  await witness.waitFor(
    (message) => message.type === 'state' && message.participantId === moderatorWelcome.self.id && message.state.recording === true,
  );

  await Promise.all([recorder.close(), witness.close(), late.close(), moderator.close()]);
  await delay(50);
});

test('join token is accepted from the WebSocket subprotocol, not the URL', async () => {
  const { roomId, tokens } = await roomWithTokens(['Subprotocol']);
  const token = tokens[0] as string;
  // The URL carries no token: browsers log it verbatim on a failed upgrade.
  const socket = await openWs(ts.wsUrl, ['agil-calls.v1', `agil-token.${encodeURIComponent(token)}`]);
  const welcome = await socket.waitFor((message) => message.type === 'welcome');
  assert.equal(welcome.room.id, roomId);
  assert.equal(welcome.self.name, 'Subprotocol');
  await socket.close();
});

test('anonymous WS join requires a room when allowed; invalid token is rejected', async () => {
  const rejected = await openWs(`${ts.wsUrl}?token=not-a-token`);
  const error = await rejected.waitFor((message) => message.type === 'error');
  assert.equal(error.code, 'unauthorized');
  await waitForClose(rejected);

  // A browser always sends Origin; the test server's AGIL_PUBLIC_ORIGIN is
  // http://127.0.0.1:1, so an anonymous join is allowed to proceed to the room
  // lookup (and fail there, as intended by this test).
  const anonymous = await openWs(`${ts.wsUrl}?room=missing-room&tenant=demo&name=Guest`, undefined, {
    origin: 'http://127.0.0.1:1',
  });
  const error2 = await anonymous.waitFor((message) => message.type === 'error');
  assert.equal(error2.code, 'unauthorized');
  await anonymous.close();
  await delay(50);
});

test('WebSocket Origin: token clients keep working, evil/null origins are rejected', async () => {
  const { roomId, tokens } = await roomWithTokens(['Origin SDK', 'Origin Browser']);
  const token = tokens[0] as string;
  const tokenUrl = `${ts.wsUrl}?token=${encodeURIComponent(token)}`;

  // Non-browser SDK: no Origin at all, valid token -> allowed.
  const sdk = await openWs(tokenUrl);
  await sdk.waitFor((message) => message.type === 'welcome');
  await sdk.close();

  // Browser on the public origin -> allowed.
  const browser = await openWs(tokenUrl, undefined, { origin: 'http://127.0.0.1:1' });
  await browser.waitFor((message) => message.type === 'welcome');
  await browser.close();

  // Foreign and opaque origins -> rejected with the standard error + close 1008.
  for (const origin of ['https://evil.example', 'null']) {
    const rejected = await openWs(tokenUrl, undefined, { origin });
    const error = await rejected.waitFor((message) => message.type === 'error');
    assert.equal(error.code, 'unauthorized', `origin ${origin}`);
    assert.equal(await waitForClose(rejected), 1008, `origin ${origin}`);
  }

  // Anonymous join without Origin is rejected even though anonymous joins are
  // otherwise enabled: only a browser page can prove its origin.
  const anonymous = await openWs(`${ts.wsUrl}?room=${encodeURIComponent(roomId)}&tenant=demo&name=NoOrigin`);
  const anonymousError = await anonymous.waitFor((message) => message.type === 'error');
  assert.equal(anonymousError.code, 'unauthorized');
  assert.match(String(anonymousError.message), /Origin/i);
  await waitForClose(anonymous);
});
