/** SSO/OIDC verified joins: local JWKS + RS256 tokens, claims mapping, failures, audit privacy. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;
let jwks: Server;
let jwksUrl = '';
let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
let otherPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];

function makeToken(payload: Record<string, unknown>, key = privateKey): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-1' };
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

function identityPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://sso.example',
    aud: 'agil-calls',
    sub: 'user-123',
    name: 'Иван Петров',
    role: 'moderator',
    permissions: ['chat', 'screenShare'],
    verified: true,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    ...overrides,
  };
}

async function setupRoom(): Promise<string> {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: `OIDC ${Date.now()}` } });
  return created.body.room.id;
}

before(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  otherPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
  jwks = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', () => resolve()));
  const port = (jwks.address() as { port: number }).port;
  jwksUrl = `http://127.0.0.1:${port}/jwks.json`;

  ts = await startTestServer();
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      integrations: {
        identity: {
          mode: 'oidc',
          issuer: 'https://sso.example',
          audience: 'agil-calls',
          jwksUrl,
          userIdClaim: 'sub',
          nameClaim: 'name',
          roleClaim: 'role',
          permissionsClaim: 'permissions',
          verifiedClaim: 'verified',
        },
      },
      security: { requireVerifiedIdentity: true },
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
});

after(async () => {
  await ts.close();
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
});

test('verified join: claims map to name/role/permissions; verify endpoint; no token in audit', async () => {
  const roomId = await setupRoom();
  const token = makeToken(identityPayload());
  const verified = await ts.api('POST', '/v1/auth/oidc/verify', { body: { tenantId: 'demo', identityToken: token } });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.userId, 'user-123');
  assert.equal(verified.body.name, 'Иван Петров');
  assert.equal(verified.body.role, 'moderator');
  assert.equal(verified.body.verified, true);
  assert.equal(verified.body.issuer, 'https://sso.example');
  assert.deepEqual(verified.body.permissions, ['chat', 'screenShare']);
  assert.equal(verified.body.token, undefined, 'verify endpoint never mints tokens');

  const joined = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { identityToken: token } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.participant.name, 'Иван Петров');
  assert.equal(joined.body.participant.role, 'moderator');
  assert.deepEqual(joined.body.permissions, ['chat', 'screenShare'], 'permissions come from the verified claim');

  const audit = await ts.api('GET', '/v1/admin/audit?limit=100', { headers: ADMIN });
  const text = JSON.stringify(audit.body);
  assert.ok(!text.includes(token), 'identity token is not stored in audit');
  assert.ok(!text.includes(token.split('.')[2]!), 'signature is not stored in audit');
});

test('required identity: missing token → 401 identity_required; invalid unverified → 401', async () => {
  const roomId = await setupRoom();
  const missing = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Anon' } });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'identity_required');

  const unverified = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    body: { identityToken: makeToken(identityPayload({ verified: false })) },
  });
  assert.equal(unverified.status, 401);
  assert.equal(unverified.body.error.code, 'invalid_identity_token');
});

test('invalid OIDC tokens: expired, wrong audience/issuer, bad signature, unknown role → guest', async () => {
  const roomId = await setupRoom();
  const expired = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    body: { identityToken: makeToken(identityPayload({ exp: Math.floor(Date.now() / 1000) - 600 })) },
  });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'invalid_identity_token');

  const wrongAudience = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    body: { identityToken: makeToken(identityPayload({ aud: 'another-client' })) },
  });
  assert.equal(wrongAudience.status, 401);

  const wrongIssuer = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    body: { identityToken: makeToken(identityPayload({ iss: 'https://evil.example' })) },
  });
  assert.equal(wrongIssuer.status, 401);

  const badSignature = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    body: { identityToken: makeToken(identityPayload(), otherPrivateKey) },
  });
  assert.equal(badSignature.status, 401);
  assert.equal(badSignature.body.error.code, 'invalid_identity_token');

  const guestRole = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
    body: { identityToken: makeToken(identityPayload({ role: 'superadmin' })) },
  });
  assert.equal(guestRole.status, 200);
  assert.equal(guestRole.body.participant.role, 'guest', 'unknown role falls back to guest');
});

test('identity token is checked even when not required; verify endpoint rejects bad tokens', async () => {
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { security: { requireVerifiedIdentity: false } } });
  try {
    const roomId = await setupRoom();
    const anonymous = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Anon' } });
    assert.equal(anonymous.status, 200, 'not required → anonymous join still works');
    const bad = await ts.api('POST', `/v1/rooms/${roomId}/join`, {
      body: { name: 'Bad', identityToken: makeToken(identityPayload(), otherPrivateKey) },
    });
    assert.equal(bad.status, 401, 'present but invalid token is always rejected');
    const verifyBad = await ts.api('POST', '/v1/auth/oidc/verify', { body: { tenantId: 'demo', identityToken: 'not-a-jwt' } });
    assert.equal(verifyBad.status, 401);
    assert.equal(verifyBad.body.error.code, 'invalid_identity_token');
    assert.ok(!JSON.stringify(verifyBad.body).includes('not-a-jwt'));
  } finally {
    await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { security: { requireVerifiedIdentity: true } } });
  }
});

test('organization-verified OIDC users can join after the anonymous budget is used', async () => {
  const settings = (requireVerifiedIdentity: boolean, publicAbuseMode: 'enforce' | null) => ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { security: { requireVerifiedIdentity, publicAbuseMode } },
  });
  assert.equal((await settings(false, 'enforce')).status, 200);
  try {
    const roomId = await setupRoom();
    const join = (body: Record<string, unknown>) => ts.api('POST', `/v1/rooms/${roomId}/join`, { body });
    for (let count = 0; count < 120; count += 1) assert.equal((await join({})).status, 200);
    assert.equal((await join({})).status, 429);
    assert.equal((await join({ identityToken: makeToken(identityPayload({ verified: false })) })).status, 429);
    const verified = await join({ identityToken: makeToken(identityPayload()) });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.participant.id, 'user-123');
  } finally {
    assert.equal((await settings(true, null)).status, 200);
  }
});

test('verified identity confirms a voice-channel member without overriding their assigned role', async () => {
  const endpoint = '/v1/admin/voice-channels';
  const created = await ts.api('POST', endpoint, {
    headers: ADMIN,
    body: { id: 'oidc-voice', name: 'Corporate voice', members: [{ participantId: 'user-123', name: 'Channel member', role: 'guest' }] },
  });
  assert.equal(created.status, 201, created.text);
  const grant = await ts.api('POST', endpoint + '/oidc-voice/join', { headers: ADMIN, body: { participantId: 'user-123' } });
  assert.equal(grant.status, 200, grant.text);
  const route = '/v1/rooms/' + grant.body.roomId + '/join';
  const join = (identityToken?: string) => ts.api('POST', route, { body: { token: grant.body.token, identityToken } });
  assert.equal((await join()).status, 401, 'the channel grant does not replace required identity');
  assert.equal((await join(makeToken(identityPayload({ sub: 'different-user' })))).status, 403);
  const matching = await join(makeToken(identityPayload({ role: 'host', permissions: ['recording'] })));
  assert.equal(matching.status, 200, matching.text);
  assert.deepEqual(matching.body.participant, { id: 'user-123', name: 'Channel member', role: 'guest' });
  assert.ok(!matching.body.permissions.includes('recording'));
});
