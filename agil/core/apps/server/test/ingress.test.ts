import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { flowCreateSchema } from '@agil/protocol';
import { RtmpIngressLifecycle } from '../src/ingress-lifecycle.js';
import { RtmpIngressOwnershipStore } from '../src/ingress-ownership.js';
import { RtmpIngressClient, PullIngressClient } from '../src/ingress.js';
import { parseIngressSources, pullSourceUrl } from '../src/ingress-sources.js';

const target = { roomName: 'tenant__room', participantIdentity: 'rtmp-source' };
const provider = {
  ingress_id: 'IN_test',
  room_name: target.roomName,
  participant_identity: target.participantIdentity,
  url: 'rtmps://media.invalid/live',
  stream_key: 'example-test-key',
};

test('managed RTMP accepts one same-room push source and rejects external settings or unsupported branches', () => {
  const source = { kind: 'rtmp_ingest', mode: 'push', roomId: 'studio' };
  const sink = { kind: 'room', roomId: 'studio' };
  const flow = { sources: [source], sinks: [sink] };
  assert.equal(flowCreateSchema.safeParse(flow).success, true);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sources: [{ ...source, url: 'rtmp://invalid.test/live' }] }).success, false);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sources: [{ ...source, kind: 'hls_ingest' }] }).success, false);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sinks: [sink, { kind: 'hls' }] }).success, false);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sinks: [{ ...sink, publish: ['microphone'] }] }).success, false);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sinks: [{ ...sink, roomId: 'other' }] }).success, false);
});

test('managed pull uses a tenant source ID and only operator-registered private IPv4 destinations', () => {
  const source = { kind: 'srt_ingest', mode: 'pull', roomId: 'studio', sourceId: 'camera' };
  const sink = { kind: 'room', roomId: 'studio' };
  const flow = { sources: [source], sinks: [sink] };
  assert.equal(flowCreateSchema.safeParse(flow).success, true);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sources: [{ ...source, url: 'srt://10.2.0.1:5000' }] }).success, false);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sources: [{ ...source, secretRef: 'AGIL_ROUTE_SECRET_SRT' }] }).success, false);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sources: [{ ...source, kind: 'rtmp_ingest' }] }).success, false);
  const hls = { ...source, kind: 'hls_ingest' };
  assert.equal(flowCreateSchema.safeParse({ ...flow, sources: [hls] }).success, true);
  assert.equal(flowCreateSchema.safeParse({ ...flow, sources: [{ ...hls, url: 'http://10.2.0.1/index.m3u8' }] }).success, false);
  const registered = { tenantId: 'demo', sourceId: 'camera', host: '10.2.0.1', port: 5000 };
  const parseSources = (items: unknown) => parseIngressSources(JSON.stringify(items), 'AGIL_TEST_INGRESS_SOURCES');
  const bindings = parseSources([registered, { ...registered, tenantId: 'acme' }]);
  assert.equal(bindings.length, 2);
  assert.equal(pullSourceUrl('srt', bindings[0]!), 'srt://10.2.0.1:5000?mode=caller');
  assert.equal(pullSourceUrl('hls', bindings[1]!), 'http://10.2.0.1:5000/sources/acme/camera/index.m3u8');
  assert.throws(() => parseSources([registered, registered]), /duplicate/);
  for (const host of ['studio.invalid', '127.0.0.1', '169.254.169.254', '8.8.8.8', '::1', '10.2.0.1/extra', '172.32.0.1']) {
    assert.throws(() => parseSources([{ ...registered, host }]), /private IPv4/);
  }
});

async function controlFixture(t: TestContext, respond: (method: string, body: object) => { status?: number; body: object; location?: string }) {
  const secret = 'test-ingress-signing-key';
  const requests: Array<{ method: string; body: object; token: string }> = [];
  const server = createServer(async (request, response) => {
    const method = request.url?.split('/').at(-1) ?? '';
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as object;
    requests.push({ method, body, token });
    const reply = respond(method, body);
    response.writeHead(reply.status ?? 200, {
      'content-type': 'application/json',
      ...(reply.location ? { location: reply.location } : {}),
    }).end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const sfuControlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { sfuEnabled: true, sfuControlUrl, sfuApiKey: 'qa-key', sfuApiSecret: secret };
  return { env, client: new RtmpIngressClient(env), requests };
}

test('RTMP Ingress creates a receiver and reports publishing only after explicit provider state', async (t) => {
  let status: string | number = 'ENDPOINT_BUFFERING';
  let deleted = false;
  const fixture = await controlFixture(t, (method) => {
    if (method === 'CreateIngress') return { body: provider };
    if (method === 'DeleteIngress') {
      deleted = true;
      return { body: {} };
    }
    return deleted
      ? { status: 404, body: { code: 'not_found' } }
      : { body: { items: [{ ...provider, state: { status } }] } };
  });
  const created = await fixture.client.create(target);
  const { handle } = created;
  assert.deepEqual(created, { handle: { id: 'IN_test', ...target }, url: provider.url, streamKey: provider.stream_key });
  assert.equal(await fixture.client.status(handle), 'buffering');
  status = 'UNRECOGNIZED_VERSION';
  assert.equal(await fixture.client.status(handle), 'unknown');
  status = 2;
  assert.equal(await fixture.client.status(handle), 'publishing');
  await fixture.client.revoke(handle);
  assert.equal(await fixture.client.status(handle), null);
  await fixture.client.revoke(handle);
  assert.equal(fixture.requests.filter(({ method }) => method === 'DeleteIngress').length, 1);
  assert.deepEqual(fixture.requests[0]?.body, {
    input_type: 'RTMP_INPUT', name: 'AGIL RTMP source', participant_name: 'RTMP source',
    room_name: target.roomName, participant_identity: target.participantIdentity,
  });
  const [header, payload, signature] = fixture.requests[0]!.token.split('.');
  assert.equal(createHmac('sha256', fixture.env.sfuApiSecret).update(`${header}.${payload}`).digest('base64url'), signature);
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  assert.deepEqual(claims.video, { ingressAdmin: true });
  assert.equal(claims.exp - claims.nbf, 35);
});

test('RTMP Ingress does not revoke a handle from a different room or participant', async (t) => {
  const fixture = await controlFixture(t, () => ({ body: { items: [provider] } }));
  const handle = { id: provider.ingress_id, ...target };
  await assert.rejects(fixture.client.revoke({ ...handle, roomName: 'other__room' }), /does not match/);
  await assert.rejects(fixture.client.status({ ...handle, participantIdentity: 'different' }), /does not match/);
  assert.deepEqual(fixture.requests.map(({ method }) => method), ['ListIngress', 'ListIngress']);
});

test('RTMP Ingress requires a configured control endpoint and hides provider errors', async (t) => {
  const fixture = await controlFixture(t, () => ({
    status: 502, body: { message: provider.stream_key },
  }));
  await assert.rejects(fixture.client.create(target), {
    message: 'LiveKit CreateIngress returned HTTP 502',
  });
  await assert.rejects(new RtmpIngressClient({ ...fixture.env, sfuControlUrl: '' }).create(target), /operator-configured/);
  assert.equal(fixture.requests.length, 1);
});

test('RTMP Ingress control never follows redirects with the operator grant', async (t) => {
  const fixture = await controlFixture(t, () => ({
    status: 307, body: {}, location: '/another-service',
  }));
  await assert.rejects(fixture.client.create(target), /is unavailable/);
  assert.equal(fixture.requests.length, 1);
});

test('RTMP Ingress treats a missing control method as an error during revocation', async (t) => {
  const fixture = await controlFixture(t, () => ({ status: 404, body: { code: 'bad_route' } }));
  await assert.rejects(fixture.client.revoke({ id: provider.ingress_id, ...target }), {
    message: 'LiveKit ListIngress returned HTTP 404',
  });
});

test('RTMP Ingress recovers one exact room and participant from the provider pages without a stream key', async (t) => {
  const fixture = await controlFixture(t, (method, body) => {
    assert.equal(method, 'ListIngress');
    if ('page_token' in body) return { body: { items: [provider], next_page_token: null } };
    return {
      body: {
        items: [
          { ...provider, ingress_id: 'IN_foreign', room_name: 'other__room' },
          { ...provider, ingress_id: 'IN_other_identity', participant_identity: 'someone-else' },
          { ...provider, ingress_id: 'IN_whip', input_type: 'WHIP_INPUT' },
        ],
        next_page_token: { token: 'second-page' },
      },
    };
  });
  assert.deepEqual(await fixture.client.findOwned(target), { id: provider.ingress_id, ...target });
  assert.deepEqual(fixture.requests.map(({ body }) => body), [
    { room_name: target.roomName },
    { room_name: target.roomName, page_token: { token: 'second-page' } },
  ]);
});

test('RTMP Ingress stops reconciliation when more than one receiver matches or pagination loops', async (t) => {
  let duplicate = true;
  const fixture = await controlFixture(t, () => ({
    body: duplicate
      ? { items: [provider, { ...provider, ingress_id: 'IN_duplicate' }] }
      : { next_page_token: { token: 'never-progresses' } },
  }));
  await assert.rejects(fixture.client.findOwned(target), /multiple RTMP receivers/);
  duplicate = false;
  await assert.rejects(fixture.client.findOwned(target), /listing did not finish/);
});

test('SRT Ingress creates a URL_INPUT without returning coordinates and recovers its exact provider type', async (t) => {
  const url = 'srt://10.2.0.1:5000?mode=caller';
  const srt = { ...provider, ingress_id: 'IN_srt', input_type: 'URL_INPUT', url };
  const fixture = await controlFixture(t, (method) => ({
    body: method === 'CreateIngress' ? srt : { items: [provider, srt] },
  }));
  const client = new PullIngressClient(fixture.env, 'srt');
  const created = await client.create(target, { tenantId: 'demo', sourceId: 'camera', host: '10.2.0.1', port: 5000 });
  assert.deepEqual(created, { handle: { id: srt.ingress_id, ...target } });
  assert.deepEqual(await client.findOwned(target), created.handle);
  assert.equal(fixture.requests[0]?.body && (fixture.requests[0].body as { url?: string }).url, url);
});

test('RTMP lifecycle keeps an unresolved create and waits for confirmed revocation', async () => {
  let entry: string | null = null;
  const store = new RtmpIngressOwnershipStore({
    leaderValue: async (_key, change) => {
      const changed = Boolean(change && change.expected === entry);
      if (change && changed) entry = change.next;
      return { value: entry, changed };
    },
  });
  let creates = 0;
  let revokes = 0;
  let visible = false;
  const lifecycle = new RtmpIngressLifecycle(store, {
    create: async () => { creates += 1; throw new Error('temporarily unavailable'); },
    findOwned: async (scope) => visible ? {
      id: provider.ingress_id, roomName: scope.roomName, participantIdentity: scope.participantIdentity,
    } : null,
    revoke: async () => { revokes += 1; if (revokes > 1) visible = false; },
    status: async () => visible ? 'waiting' : null,
  });
  const flow = { tenantId: 'demo', flowId: 'input' };
  const room = { tenantId: flow.tenantId, id: 'room' };
  await assert.rejects(lifecycle.create(flow, room), /temporarily unavailable/);
  assert.equal(await lifecycle.revoke(flow), 'pending');
  assert.equal((await store.get(flow))?.phase, 'provisioning');
  await assert.rejects(lifecycle.create(flow, room), { code: 'ingress_already_reserved' });
  assert.equal(creates, 1);
  assert.equal(revokes, 0);
  visible = true;
  assert.equal(await lifecycle.revoke(flow), 'pending');
  assert.equal((await store.get(flow))?.phase, 'revoking');
  assert.equal(await lifecycle.revoke(flow), 'complete');
  assert.equal(await lifecycle.revoke(flow), 'complete');
  assert.equal(revokes, 2);
});
