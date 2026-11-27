/** TURN/ICE: UDP+TCP fallback in /v1/ice & welcome, real UDP/TCP reachability probe. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, type Server } from 'node:net';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };

test('automatic TURN publishes only a verified enrolled endpoint and follows feature changes', async (t) => {
  const id = 'automatic-turn';
  const key = 'qa-automatic-turn-signing-key-with-32-plus-bytes';
  const endpoint = { ip: '192.0.2.25', port: 3478, tlsPort: 5349, tlsHostname: 'turn.qa.test', credentialMode: 'rest' };
  const stun = { urls: 'stun:stun.qa.test:3478' };
  const urls = ['turn:192.0.2.25:3478', 'turn:192.0.2.25:3478?transport=tcp', 'turns:turn.qa.test:5349?transport=tcp'];
  const core = await startTestServer({ iceServers: [stun], coturnAutoSecrets: { demo: { [id]: key } } });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const connect = async (headers = ADMIN) => {
    const room = await core.api('POST', '/v1/rooms', { headers, body: { name: 'Automatic TURN' } });
    assert.equal(room.status, 200, room.text);
    return openWs(`${core.wsUrl}?token=${encodeURIComponent(room.body.token)}`);
  };
  try {
    const token = await core.api('POST', '/v1/admin/cluster/tokens', { headers: ADMIN, body: { kind: 'node', role: 'all', features: ['sfu', 'turn'] } });
    assert.equal(token.status, 201, token.text);
    const registered = await core.api('POST', '/v1/nodes/register', { body: { token: token.body.token, nodeId: id, role: 'all', features: ['sfu', 'turn'] } });
    assert.equal(registered.status, 201, registered.text);
    const nodeKey = registered.body.nodeKey;
    const proof = createHmac('sha256', key).update(JSON.stringify([
      'agil-turn-auto-v1', id, nodeKey, endpoint.ip, endpoint.port, endpoint.tlsPort, endpoint.tlsHostname,
    ])).digest('hex');
    const heartbeat = async (fields: Record<string, unknown> = {}) => {
      const response = await core.api('POST', `/v1/nodes/${id}/heartbeat`, {
        headers: { 'x-node-token': nodeKey }, body: { turnReady: true, turnEndpoint: endpoint, ...fields },
      });
      assert.equal(response.status, 200, response.text);
      assert.ok(!response.text.includes(proof) && !response.text.includes(key));
      return response.body.node;
    };
    const scale = async (headers = ADMIN) => {
      const response = await core.api('GET', '/v1/admin/scale', { headers });
      assert.equal(response.status, 200, response.text);
      assert.ok(!response.text.includes(proof) && !response.text.includes(key));
      assert.deepEqual(response.body.config.turn, []);
      return response.body.turn[0];
    };
    assert.equal((await heartbeat()).automaticTurnVerified, undefined);
    assert.equal((await scale()).nodeState, 'turn_endpoint_missing');
    assert.equal((await heartbeat({ turnEndpointProof: proof, turnEndpoint: { ...endpoint, port: 3479 } })).automaticTurnVerified, undefined);
    const client = await connect();
    try {
      const refresh = async () => {
        now += 15_001;
        client.send({ type: 'ping', ts: now, refreshIce: true });
        return (await client.waitFor((message) => message.type === 'pong' && message.ts === now)).iceServers;
      };
      assert.deepEqual((await client.waitFor((message) => message.type === 'welcome')).iceServers, [stun]);
      assert.equal((await heartbeat({ turnEndpointProof: proof })).automaticTurnVerified, true);
      const status = await scale();
      assert.deepEqual(status.urls, urls);
      assert.equal(status.automatic, true);
      assert.equal(status.nodeAvailable, true);
      assert.equal(await scale({ 'x-api-key': 'acme-key' }), undefined);
      const applied = await refresh();
      assert.deepEqual(applied[1].urls, urls);
      assert.equal(applied[1].credential, createHmac('sha1', key).update(applied[1].username).digest('base64'));
      const change = async (features: string[]) => {
        const response = await core.api('PATCH', `/v1/admin/nodes/${id}`, { headers: ADMIN, body: { features } });
        assert.equal(response.status, 200, response.text);
      };
      await change(['sfu']);
      assert.deepEqual(await refresh(), [stun]);
      await change(['sfu', 'turn']);
      assert.deepEqual(await refresh(), [stun]);
      await heartbeat({ turnEndpointProof: proof });
      assert.deepEqual((await refresh())[1].urls, urls);
    } finally {
      await client.close();
    }
  } finally {
    t.mock.restoreAll();
    await core.close();
  }
});

function stunResponse(request: Buffer): Buffer {
  const response = Buffer.alloc(20);
  response.writeUInt16BE(0x0101, 0); // Binding Success
  response.writeUInt16BE(0, 2);
  response.writeUInt32BE(0x2112a442, 4);
  request.copy(response, 8, 8, 20);
  return response;
}

async function startUdpStun(): Promise<{ port: number; close: () => Promise<void> }> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
  socket.on('message', (message, remote) => {
    socket.send(stunResponse(message), remote.port, remote.address);
  });
  return {
    port: socket.address().port,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

async function startTcpTurn(): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  const server = createServer((connection) => {
    connection.on('error', () => {});
    connection.write(stunResponse(Buffer.alloc(20)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function closedTcpPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('GET /v1/ice strips TURN and credentials while a room welcome advertises UDP and TCP TURN', async () => {
  const udp = await startUdpStun();
  try {
    const ts = await startTestServer({
      iceServers: [
        { urls: ['stun:127.0.0.1:3478', `turn:127.0.0.1:${udp.port}`], username: 'agil', credential: 'secret' },
        { urls: 'turns:turn.example:5349', username: 'tls-user', credential: 'tls-secret' },
        { urls: ['stun:stun.example:3478', 'stuns:stun.example:5349'] },
      ],
    });
    try {
      const ice = await ts.api('GET', '/v1/ice');
      assert.equal(ice.status, 200);
      assert.deepEqual(ice.body, { iceServers: [
        { urls: 'stun:127.0.0.1:3478' },
        { urls: ['stun:stun.example:3478', 'stuns:stun.example:5349'] },
      ] });

      const created = await ts.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'ICE fallback' } });
      const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(created.body.token)}`);
      const welcome = await client.waitFor((message) => message.type === 'welcome');
      const welcomeUrls = (welcome.iceServers as Array<{ urls: string | string[] }>).flatMap((server) =>
        Array.isArray(server.urls) ? server.urls : [server.urls],
      );
      assert.ok(welcomeUrls.some((url) => /transport=tcp/.test(url)), 'welcome advertises TCP fallback');
      assert.ok(welcomeUrls.includes(`turn:127.0.0.1:${udp.port}`), 'welcome includes the original TURN URL');
      assert.ok(welcomeUrls.includes('turns:turn.example:5349'), 'welcome preserves TLS TURN');
      assert.ok((welcome.iceServers as Array<{ credential?: string }>).some((entry) => entry.credential === 'secret'));
      await client.close();
    } finally {
      await ts.close();
    }
  } finally {
    await udp.close();
  }

  // Opt-out still works.
  const noFallback = await startTestServer({
    iceTcpFallback: false,
    iceServers: [{ urls: 'turn:127.0.0.1:3478', username: 'u', credential: 'c' }],
  });
  try {
    assert.deepEqual((await noFallback.api('GET', '/v1/ice')).body.iceServers, []);
    const created = await noFallback.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'No fallback' } });
    const client = await openWs(`${noFallback.wsUrl}?token=${encodeURIComponent(created.body.token)}`);
    const welcome = await client.waitFor((message) => message.type === 'welcome');
    assert.deepEqual(welcome.iceServers, [{ urls: 'turn:127.0.0.1:3478', username: 'u', credential: 'c' }]);
    await client.close();
  } finally {
    await noFallback.close();
  }
});

test('coturn mode issues expiring room ICE credentials and skips relays without a key for the tenant', async () => {
  const key = 'qa-coturn-signing-key-only-used-by-this-test';
  const core = await startTestServer({
    coturnRestSecrets: { demo: { regional: key } },
    coturnRestTtlSec: 600,
    iceServers: [
      { urls: 'stun:stun.example:3478' },
      { urls: 'turn:relay.example?transport=udp', username: 'legacy', credential: 'legacy-value' },
    ],
  });
  const turn = { id: 'regional', urls: ['turn:relay.example:3478'], credentialMode: 'rest',
    username: '', credentialEnv: '', region: '', weight: 1 };
  try {
    for (const headers of [ADMIN, { 'x-api-key': 'acme-key' }]) {
      const saved = await core.api('PUT', '/v1/admin/scale', { headers, body: { scale: { turn: [turn] } } });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.body.turn[0].credentialMode, 'rest');
      assert.equal(saved.body.turn[0].credentialConfigured, headers === ADMIN);
      assert.doesNotMatch(saved.text, /qa-coturn-signing-key/);
    }
    assert.deepEqual((await core.api('GET', '/v1/ice')).body.iceServers, [{ urls: 'stun:stun.example:3478' }]);
    const getWelcome = async (headers: typeof ADMIN) => {
      const room = await core.api('POST', '/v1/rooms', { headers, body: { name: 'Temporary TURN credential' } });
      assert.equal(room.status, 200, room.text);
      const client = await openWs(`${core.wsUrl}?token=${encodeURIComponent(room.body.token)}`);
      try { return await client.waitFor((message) => message.type === 'welcome'); }
      finally { await client.close(); }
    };
    const before = Math.floor(Date.now() / 1000);
    const welcome = await getWelcome(ADMIN);
    const ice = welcome.iceServers as Array<{ urls: string | string[]; username?: string; credential?: string }>;
    const relay = ice.find((server) => [server.urls].flat().includes(turn.urls[0]!) && server.username);
    assert.ok(relay?.username && relay.credential);
    assert.deepEqual(relay.urls, ['turn:relay.example:3478', 'turn:relay.example:3478?transport=tcp']);
    assert.match(relay.username, /^\d+:[0-9a-f]{24}$/);
    const expiry = Number(relay.username.split(':')[0]);
    assert.ok(expiry >= before + 600 && expiry <= Math.floor(Date.now() / 1000) + 600);
    assert.equal(relay.credential, createHmac('sha1', key).update(relay.username).digest('base64'));
    assert.doesNotMatch(JSON.stringify(welcome), /qa-coturn-signing-key|legacy-value/);
    const acmeWelcome = await getWelcome({ 'x-api-key': 'acme-key' });
    assert.deepEqual(acmeWelcome.iceServers, [{ urls: 'stun:stun.example:3478' }]);
  } finally {
    await core.close();
  }
});

test('a joined client renews its temporary TURN credentials on heartbeat without a new welcome', async (t) => {
  const key = 'qa-coturn-signing-key-only-used-by-this-test';
  const core = await startTestServer({ coturnRestSecrets: { demo: { relay: key } }, coturnRestTtlSec: 600 });
  try {
    const scale = await core.api('PUT', '/v1/admin/scale', { headers: ADMIN, body: { scale: { turn: [{
      id: 'relay', urls: ['turn:relay.example:3478'], credentialMode: 'rest',
      username: '', credentialEnv: '', region: '', weight: 1,
    }] } } });
    assert.equal(scale.status, 200, scale.text);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const room = await core.api('POST', '/v1/rooms', { headers: ADMIN, body: { name: 'Renew TURN without rejoining' } });
    assert.equal(room.status, 200, room.text);
    const client = await openWs(`${core.wsUrl}?token=${encodeURIComponent(room.body.token)}`);
    try {
      const welcome = await client.waitFor((message) => message.type === 'welcome');
      const original = welcome.iceServers.find((server: { username?: string }) => server.username);
      const ping = (ts: number, refreshIce?: boolean) => {
        client.send({ type: 'ping', ts, refreshIce });
        return client.waitFor((message) => message.type === 'pong' && message.ts === ts);
      };
      assert.deepEqual(await ping(1, true), { type: 'pong', ts: 1 });
      now += 300_000;
      assert.deepEqual(await ping(2), { type: 'pong', ts: 2 }, 'legacy ping keeps the original response');
      const renewed = (await ping(3, true)).iceServers.find((server: { username?: string }) => server.username);
      assert.notEqual(renewed.credential, original.credential);
      assert.equal(renewed.username.split(':')[1], original.username.split(':')[1]);
      assert.equal(Number(renewed.username.split(':')[0]), Math.floor(now / 1000) + 600);
      assert.equal(renewed.credential, createHmac('sha1', key).update(renewed.username).digest('base64'));
      assert.deepEqual(await ping(4, true), { type: 'pong', ts: 4 }, 'a second ping does not mint another credential');
      assert.equal(client.messages.filter((message) => message.type === 'welcome').length, 1);
    } finally {
      await client.close();
    }
  } finally {
    t.mock.restoreAll();
    await core.close();
  }
});

test('managed TURN drops stopped, drained and foreign nodes from welcome and ICE refresh', async (t) => {
  const url = 'turn:managed-relay.example:3478';
  const stun = { urls: 'stun:stun.example:3478' };
  const nodeId = 'managed-turn';
  const core = await startTestServer({
    iceServers: [{ urls: [stun.urls, url], username: 'legacy', credential: 'legacy-value' }],
    coturnRestSecrets: { demo: { managed: 'demo-turn-key' }, acme: { managed: 'acme-turn-key' } },
  });
  try {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const issued = await core.api('POST', '/v1/admin/cluster/tokens', {
      headers: ADMIN, body: { kind: 'node', role: 'turn', features: ['turn'] },
    });
    assert.equal(issued.status, 201, issued.text);
    const registered = await core.api('POST', '/v1/nodes/register', {
      body: { token: issued.body.token, role: 'turn', nodeId },
    });
    assert.equal(registered.status, 201, registered.text);
    const heartbeat = async (status?: string, health = 'unknown', fields = {}) => {
      const response = await core.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
        headers: { 'x-node-token': registered.body.nodeKey },
        body: {
          ...(status ? { modules: [{ id: 'turn', image: 'coturn/coturn:4.6', status, health }] } : {}),
          ...fields,
        },
      });
      assert.equal(response.status, 200, response.text);
      return response.body.node;
    };
    const scalePath = '/v1/admin/scale';
    const turn = { id: 'managed', nodeId, urls: [url], credentialMode: 'rest',
      username: '', credentialEnv: '', region: '', weight: 1 };
    const acme = { 'x-api-key': 'acme-key' };
    for (const headers of [ADMIN, acme]) {
      const saved = await core.api('PUT', scalePath, { headers, body: { scale: { turn: [turn] } } });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.body.turn[0].nodeAvailable, false);
      assert.equal(saved.body.turn[0].nodeState, headers === ADMIN ? 'inventory_stale' : 'node_not_found');
    }
    const expectNodeState = async (state: string) => {
      const response = await core.api('GET', scalePath, { headers: ADMIN });
      assert.equal(response.body.turn[0].nodeState, state);
      assert.equal(response.body.turn[0].nodeAvailable, state === 'ready');
    };
    const connect = async (headers: typeof ADMIN) => {
      const room = await core.api('POST', '/v1/rooms', { headers, body: { name: 'Managed TURN' } });
      assert.equal(room.status, 200, room.text);
      return openWs(`${core.wsUrl}?token=${encodeURIComponent(room.body.token)}`);
    };
    await heartbeat(undefined, undefined, { moduleAvailability: 'disabled' });
    await expectNodeState('module_management_disabled');
    await heartbeat(undefined, undefined, { modules: [] });
    await expectNodeState('turn_not_installed');
    await heartbeat('running');
    await expectNodeState('ready');
    const foreign = await connect(acme);
    try {
      assert.deepEqual((await foreign.waitFor((message) => message.type === 'welcome')).iceServers, [stun]);
    } finally {
      await foreign.close();
    }
    const client = await connect(ADMIN);
    try {
      const welcome = await client.waitFor((message) => message.type === 'welcome');
      assert.deepEqual(welcome.iceServers[1].urls, [url, `${url}?transport=tcp`]);
      assert.doesNotMatch(JSON.stringify(welcome.iceServers), /legacy-value/);
      const refresh = () => {
        now += 15_001;
        client.send({ type: 'ping', ts: now, refreshIce: true });
        return client.waitFor((message) => message.type === 'pong' && message.ts === now);
      };
      const setModulePolicy = async (enabled: boolean) => {
        const reply = await core.api('PATCH', `/v1/admin/nodes/${nodeId}`, {
          headers: ADMIN, body: { moduleEnabled: { turn: enabled } },
        });
        assert.equal(reply.status, 200, reply.text);
      };
      await setModulePolicy(false);
      await heartbeat('running', 'healthy');
      await expectNodeState('module_disabled');
      assert.deepEqual((await refresh()).iceServers, [stun]);
      await setModulePolicy(true);
      assert.deepEqual((await refresh()).iceServers, [stun]);
      await heartbeat('running', 'healthy');
      assert.deepEqual((await refresh()).iceServers[1].urls, [url, `${url}?transport=tcp`]);
      await heartbeat('stopped');
      await expectNodeState('turn_not_running');
      assert.deepEqual((await refresh()).iceServers, [stun]);
      await heartbeat('running');
      assert.deepEqual((await refresh()).iceServers[1].urls, [url, `${url}?transport=tcp`]);
      const drained = await core.api('POST', `/v1/admin/nodes/${nodeId}/drain`, { headers: ADMIN, body: { drain: true } });
      assert.equal(drained.status, 200, drained.text);
      await expectNodeState('node_draining');
      assert.deepEqual((await refresh()).iceServers, [stun]);
      const newCall = await connect(ADMIN);
      try {
        assert.deepEqual((await newCall.waitFor((message) => message.type === 'welcome')).iceServers, [stun]);
      } finally {
        await newCall.close();
      }
      await heartbeat('running', 'unhealthy');
      const undrained = await core.api('POST', `/v1/admin/nodes/${nodeId}/drain`, { headers: ADMIN, body: { drain: false } });
      assert.equal(undrained.status, 200, undrained.text);
      await expectNodeState('turn_unhealthy');
      assert.deepEqual((await refresh()).iceServers, [stun]);
      await heartbeat('running', 'healthy');
      assert.deepEqual((await refresh()).iceServers[1].urls, [url, `${url}?transport=tcp`]);

      now += 90_001;
      const stillOnline = await heartbeat();
      assert.equal(stillOnline.status, 'online');
      assert.equal(stillOnline.modules[0].status, 'running', 'retain last inventory for diagnostics');
      assert.deepEqual((await refresh()).iceServers, [stun]);
      await expectNodeState('inventory_stale');
      await heartbeat('running', 'healthy');
      assert.deepEqual((await refresh()).iceServers[1].urls, [url, `${url}?transport=tcp`]);
      await heartbeat(undefined, undefined, { moduleAvailability: 'unavailable' });
      await heartbeat();
      await expectNodeState('docker_unavailable');
      assert.deepEqual((await refresh()).iceServers, [stun], 'a liveness-only heartbeat cannot clear a Docker failure');
      await heartbeat(undefined, undefined, { moduleAvailability: 'available' });
      assert.deepEqual((await refresh()).iceServers, [stun], 'Docker recovery alone does not confirm that TURN is running');
      await heartbeat('running', 'healthy', { moduleAvailability: 'available' });
      assert.deepEqual((await refresh()).iceServers[1].urls, [url, `${url}?transport=tcp`]);
      await heartbeat(undefined, undefined, { status: 'offline' });
      await expectNodeState('node_offline');
      await heartbeat();
      assert.deepEqual((await refresh()).iceServers, [stun], 'a reboot requires a fresh inventory');
      await heartbeat('running', 'healthy');
      for (const disabled of [true, false]) {
        const changed = await core.api('POST', `/v1/admin/nodes/${nodeId}/disable`, { headers: ADMIN, body: { disabled } });
        assert.equal(changed.status, 200, changed.text);
        await expectNodeState(disabled ? 'node_disabled' : 'inventory_stale');
      }
      await heartbeat('running', 'healthy');
      assert.deepEqual((await refresh()).iceServers[1].urls, [url, `${url}?transport=tcp`]);

      const turnEndpoint = { ip: '192.0.2.20', port: 3478, tlsPort: 5349 };
      const invalidEndpoint = await core.api('POST', `/v1/nodes/${nodeId}/heartbeat`, {
        headers: { 'x-node-token': registered.body.nodeKey },
        body: { turnReady: true, turnEndpoint: { ...turnEndpoint, port: 0 } },
      });
      assert.equal(invalidEndpoint.status, 400);
      const setFeatures = async (features: string[]) => {
        const response = await core.api('PATCH', `/v1/admin/nodes/${nodeId}`, { headers: ADMIN, body: { features } });
        assert.equal(response.status, 200, response.text);
      };
      await setFeatures([]);
      const firstBundledReport = await heartbeat('running', 'healthy', { turnReady: true, turnEndpoint });
      assert.deepEqual(firstBundledReport.availableModules, ['turn'], 'Docker inventory can still be managed');
      assert.equal(firstBundledReport.turnEndpoint, undefined, 'disabled bundled endpoint is never advertised');
      await expectNodeState('turn_feature_disabled');
      const callWhileDisabled = await connect(ADMIN);
      try {
        assert.deepEqual((await callWhileDisabled.waitFor((message) => message.type === 'welcome')).iceServers, [stun]);
      } finally {
        await callWhileDisabled.close();
      }
      await setFeatures(['turn']);
      await expectNodeState('inventory_stale');
      const bundledReady = await heartbeat(undefined, undefined, { turnReady: true, turnEndpoint, moduleAvailability: 'disabled' });
      assert.equal(bundledReady.turnReady, true);
      assert.deepEqual(bundledReady.turnEndpoint, turnEndpoint);
      const foreign = await core.api('GET', '/v1/admin/nodes', { headers: acme });
      assert.equal(foreign.status, 200);
      assert.ok(!foreign.body.nodes.some((node: { id: string }) => node.id === nodeId));
      assert.deepEqual(bundledReady.availableModules, [], 'bundled coturn is not a Docker module');
      await expectNodeState('ready');
      assert.deepEqual((await refresh()).iceServers[1].urls, [url, `${url}?transport=tcp`]);
      await heartbeat('running', 'healthy', { turnReady: false, moduleAvailability: 'available' });
      await expectNodeState('turn_unhealthy');
      assert.deepEqual((await refresh()).iceServers, [stun], 'Docker inventory cannot mask a failing bundled relay');
      await heartbeat(undefined, undefined, { turnReady: true, turnEndpoint });
      await setFeatures([]);
      await heartbeat('running', 'healthy', { turnReady: true, turnEndpoint });
      await expectNodeState('turn_feature_disabled');
      assert.deepEqual((await refresh()).iceServers, [stun], 'disabled bundled TURN must not fall back to Docker inventory');
      await setFeatures(['turn']);
      await expectNodeState('inventory_stale');
      assert.deepEqual((await refresh()).iceServers, [stun], 're-enabling TURN requires a fresh bundled readiness report');
      await heartbeat(undefined, undefined, { turnReady: true, turnEndpoint });
      await expectNodeState('ready');
      now += 90_001;
      const staleReport = await heartbeat();
      assert.equal(staleReport.turnReady, false);
      assert.equal(staleReport.turnEndpoint, undefined);
      await expectNodeState('inventory_stale');
      assert.deepEqual((await refresh()).iceServers, [stun]);
      await heartbeat(undefined, undefined, { turnReady: true });
      assert.deepEqual((await refresh()).iceServers[1].urls, [url, `${url}?transport=tcp`]);
      await heartbeat(undefined, undefined, { status: 'offline', turnReady: true });
      await expectNodeState('node_offline');
      await heartbeat();
      await expectNodeState('inventory_stale');
      assert.deepEqual((await refresh()).iceServers, [stun], 'a restarted agent must prove bundled TURN readiness again');
    } finally {
      await client.close();
    }
  } finally {
    t.mock.restoreAll();
    await core.close();
  }
});

test('TURN test performs real UDP + TCP reachability probes', async () => {
  const udp = await startUdpStun();
  const tcp = await startTcpTurn();
  // Snapshot timing: the allowlisted TURN credential must exist at startup.
  process.env.AGIL_TURN_PROBE_SECRET = 'turn-secret';
  const ts = await startTestServer();
  try {
    const saved = await ts.api('PUT', '/v1/admin/scale', {
      headers: ADMIN,
      body: {
        scale: {
          turn: [
            {
              id: 'local-turn',
              urls: [`turn:127.0.0.1:${udp.port}`, `turn:127.0.0.1:${tcp.port}?transport=tcp`],
              username: 'agil',
              credentialEnv: 'AGIL_TURN_PROBE_SECRET',
              region: 'local',
              weight: 100,
            },
            {
              id: 'turn-broken',
              urls: [`turn:127.0.0.1:${udp.port}`],
              username: 'agil',
              credentialEnv: 'AGIL_TURN_MISSING_SECRET',
              region: 'local',
              weight: 5,
            },
            {
              id: 'dead-turn',
              urls: [`turn:127.0.0.1:${await closedTcpPort()}?transport=tcp`],
              username: 'agil',
              credentialEnv: 'AGIL_TURN_PROBE_SECRET',
              region: 'local',
              weight: 10,
            },
          ],
        },
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const ok = await ts.api('POST', '/v1/admin/scale/turn/test', { headers: ADMIN, body: { id: 'local-turn' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
    assert.equal(typeof ok.body.latencyMs, 'number');
    assert.ok(ok.body.latencyMs <= 2000, `short probe timeout, got ${ok.body.latencyMs}ms`);
    assert.match(ok.body.detail, /UDP.*ok/i);
    assert.match(ok.body.detail, /TCP.*ok/i);

    const dead = await ts.api('POST', '/v1/admin/scale/turn/test', { headers: ADMIN, body: { id: 'dead-turn' } });
    assert.equal(dead.status, 200);
    assert.equal(dead.body.ok, false);
    assert.match(dead.body.detail, /failed|timeout|ECONNREFUSED/i);

    const missing = await ts.api('POST', '/v1/admin/scale/turn/test', { headers: ADMIN, body: { id: 'turn-broken' } });
    assert.equal(missing.body.ok, false);
    assert.match(missing.body.detail, /AGIL_TURN_MISSING_SECRET/);
    assert.equal((await ts.api('POST', '/v1/admin/scale/turn/test', { headers: ADMIN, body: { id: 'nope' } })).status, 404);
  } finally {
    delete process.env.AGIL_TURN_PROBE_SECRET;
    await ts.close();
    await udp.close();
    await tcp.close();
  }
});
