/**
 * SFU capacity profiles: `AGIL_SFU_PROFILE` env override, tenant
 * `scale.sfu.capacityProfile` fallback, and surfacing in the client config,
 * WS welcome and `/v1/admin/scale` status.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };

/** Started with `AGIL_SFU_PROFILE=low` (current pilot). */
let envServer: TestServer;
/** Started without env; the tenant config selects the profile. */
let configServer: TestServer;
/** Fresh deployment with neither env nor tenant override. */
let defaultServer: TestServer;

before(async () => {
  process.env.AGIL_SFU_PROFILE = 'low';
  envServer = await startTestServer();
  delete process.env.AGIL_SFU_PROFILE;
  configServer = await startTestServer();
  defaultServer = await startTestServer();
});

after(async () => {
  delete process.env.AGIL_SFU_PROFILE;
  await envServer.close();
  await configServer.close();
  await defaultServer.close();
});

async function scaleStatus(ts: TestServer): Promise<any> {
  const response = await ts.api('GET', '/v1/admin/scale', { headers: ADMIN });
  assert.equal(response.status, 200);
  return response.body;
}

test('AGIL_SFU_PROFILE=low wins over the tenant config and is surfaced in config/status', async () => {
  // Store a conflicting tenant value: the deployment profile must still win.
  const patch = await envServer.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { sfu: { capacityProfile: 'high' } } },
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.config.scale.sfu.capacityProfile, 'high', 'the stored tenant value is not rewritten');

  const config = await envServer.api('GET', '/v1/tenants/demo/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.config.scale.sfu.capacityProfile, 'low', 'clients receive the env-effective profile');

  const status = await scaleStatus(envServer);
  assert.equal(status.sfuProfile, 'low');
  assert.equal(status.sfuCapacity.remoteVideosPerClient, 2);
  assert.equal(status.sfuCapacity.participants, 25);
  assert.equal(status.config.sfu.capacityProfile, 'low', 'status shows the effective profile, not the stored one');

  const room = await envServer.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Profile room' } });
  const joined = await envServer.api('POST', `/v1/rooms/${room.body.room.id}/join`, { body: { name: 'Guest' } });
  assert.equal(joined.status, 200);
  const ws = await openWs(`${envServer.wsUrl}?token=${encodeURIComponent(joined.body.token)}`);
  try {
    const welcome = await ws.waitFor((message) => message.type === 'welcome');
    assert.equal(welcome.config.scale.sfu.capacityProfile, 'low', 'welcome carries the effective profile');
  } finally {
    await ws.close();
  }
});

test('without env, scale.sfu.capacityProfile selects the profile and survives sibling patches', async () => {
  const patch = await configServer.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { sfu: { capacityProfile: 'high' } } },
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.config.scale.sfu.capacityProfile, 'high');

  const config = await configServer.api('GET', '/v1/tenants/demo/config');
  assert.equal(config.body.config.scale.sfu.capacityProfile, 'high');

  const status = await scaleStatus(configServer);
  assert.equal(status.sfuProfile, 'high');
  assert.equal(status.sfuCapacity.remoteVideosPerClient, 12);
  assert.equal(status.sfuCapacity.participants, 200);

  // Patching another sfu field must not reset the profile (deep-partial merge).
  const sibling = await configServer.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { scale: { sfu: { region: 'ru-msk' } } },
  });
  assert.equal(sibling.status, 200);
  assert.equal(sibling.body.config.scale.sfu.capacityProfile, 'high');
  assert.equal((await scaleStatus(configServer)).sfuProfile, 'high');
});

test('new deployments default to standard', async () => {
  const config = await defaultServer.api('GET', '/v1/tenants/demo/config');
  assert.equal(config.body.config.scale.sfu.capacityProfile, 'standard');
  const status = await scaleStatus(defaultServer);
  assert.equal(status.sfuProfile, 'standard');
  assert.equal(status.sfuCapacity.remoteVideosPerClient, 6);
  assert.equal(status.sfuCapacity.participants, 50);
  // Not a fake 50-HD claim: the status note names the deployed sizing.
  assert.ok(status.sfuCapacity.note.includes('Default for new deployments'));
});

test('an unknown AGIL_SFU_PROFILE falls back to standard instead of guessing capacity', async () => {
  process.env.AGIL_SFU_PROFILE = 'turbo';
  const ts = await startTestServer();
  try {
    const status = await scaleStatus(ts);
    assert.equal(status.sfuProfile, 'standard');
    assert.equal(status.sfuCapacity.remoteVideosPerClient, 6);
  } finally {
    delete process.env.AGIL_SFU_PROFILE;
    await ts.close();
  }
});
