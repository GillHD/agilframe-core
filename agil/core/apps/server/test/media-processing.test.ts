/** Optional server-side media processing policy: defaults, warnings, flags, audit. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

test('media processing defaults to client-only; endpoint is admin-only', async () => {
  assert.equal((await ts.api('GET', '/v1/admin/media/processing')).status, 401);
  const status = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
  assert.equal(status.status, 200);
  assert.equal(status.body.policy.mode, 'client-only');
  assert.equal(status.body.policy.video, false);
  assert.equal(status.body.policy.audio, false);
  assert.equal(status.body.policy.egress, false);
  assert.equal(status.body.policy.transcoding, false);
  assert.equal(status.body.policy.provider, 'none');
  assert.equal(status.body.serverProcessingActive, false);
  assert.equal(status.body.sfuForwardingOnly, false);
  assert.equal(status.body.egressConfigured, false);
  assert.equal(status.body.misconfigured, false);
  assert.match(status.body.note, /client-only/i);

  const publicConfig = await ts.api('GET', '/v1/tenants/demo/config');
  assert.equal(publicConfig.body.config.mediaProcessing.mode, 'client-only', 'default stays client-only');
});

test('server-assisted without components is allowed but reported misconfigured with a warning', async () => {
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { mediaProcessing: { mode: 'server-assisted' } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.config.mediaProcessing.mode, 'server-assisted');
  assert.equal(patched.body.mediaProcessing.misconfigured, true);
  assert.equal(patched.body.mediaProcessing.serverProcessingActive, false);
  assert.match(String(patched.body.warning), /компонент/i);

  const status = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
  assert.equal(status.body.misconfigured, true);
  assert.equal(status.body.serverProcessingActive, false);
  assert.match(status.body.note, /ни один компонент/i);

  const audit = await ts.api('GET', '/v1/admin/audit?limit=50', { headers: ADMIN });
  assert.ok(
    audit.body.entries.some(
      (entry: { details?: { kind?: string } }) => entry.details?.kind === 'media.processing.updated',
    ),
  );
});

test('explicit components and egress flags are reported as policy, separately from worker health', async () => {
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      mediaProcessing: {
        mode: 'server-assisted',
        video: true,
        audio: true,
        egress: true,
        transcoding: true,
        provider: 'livekit-egress',
      },
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const status = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
  assert.equal(status.body.serverProcessingActive, true);
  assert.equal(status.body.egressConfigured, true);
  assert.equal(status.body.misconfigured, false);
  assert.match(status.body.note, /Доступность воркеров.+проверяются отдельно/);

  // Scale status carries a short mediaProcessing summary.
  const scale = await ts.api('GET', '/v1/admin/scale', { headers: ADMIN });
  assert.equal(scale.status, 200);
  assert.equal(scale.body.mediaProcessing.mode, 'server-assisted');
  assert.equal(scale.body.mediaProcessing.serverProcessingActive, true);
  assert.equal(scale.body.mediaProcessing.egressConfigured, true);
  assert.equal(scale.body.mediaProcessing.misconfigured, false);

  // SFU/broadcast media mode means forwarding-only.
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { scale: { mediaMode: 'sfu' } } });
  const forwarding = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
  assert.equal(forwarding.body.sfuForwardingOnly, true);
  assert.equal((await ts.api('GET', '/v1/admin/scale', { headers: ADMIN })).body.mediaProcessing.sfuForwardingOnly, true);
});

test('mediaProcessing is validated by zod; client-only can be restored', async () => {
  const invalidMode = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { mediaProcessing: { mode: 'nonsense' } },
  });
  assert.equal(invalidMode.status, 400);
  assert.equal(invalidMode.body.error.code, 'validation_failed');

  const invalidProvider = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { mediaProcessing: { provider: 'unknown-provider' } },
  });
  assert.equal(invalidProvider.status, 400);

  const restored = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      mediaProcessing: {
        mode: 'client-only',
        video: false,
        audio: false,
        egress: false,
        transcoding: false,
        provider: 'none',
      },
      scale: { mediaMode: 'mesh' },
    },
  });
  assert.equal(restored.status, 200);
  const status = await ts.api('GET', '/v1/admin/media/processing', { headers: ADMIN });
  assert.equal(status.body.policy.mode, 'client-only');
  assert.equal(status.body.serverProcessingActive, false);
  assert.equal(status.body.sfuForwardingOnly, false);
  assert.equal(status.body.egressConfigured, false);
});
