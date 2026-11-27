/** Files, recordings and STT endpoints (participant-facing, Bearer + signed URLs). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeUrl, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;
let token: string;
let roomId: string;

before(async () => {
  ts = await startTestServer();
  // Feature flags are the tenant-level gate; the participant's effective
  // permissions are checked in addition (see the dedicated gating test).
  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { features: { fileShare: true } },
  });
  assert.equal(patched.status, 200);
  const created = await ts.api('POST', '/v1/rooms', { body: { name: 'Files room' } });
  token = created.body.token;
  roomId = created.body.room.id;
});

after(async () => {
  await ts.close();
});

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test('upload with join token returns a record with a signed URL; download returns the same bytes', async () => {
  const response = await ts.api('POST', '/v1/files', {
    headers: { ...bearer(), 'x-file-name': encodeURIComponent('notes.txt'), 'content-type': 'text/plain' },
    rawBody: 'hello AgilFrame',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.name, 'notes.txt');
  assert.equal(response.body.size, Buffer.byteLength('hello AgilFrame'));
  assert.ok(response.body.url.includes('sig='));

  const download = await ts.api('GET', relativeUrl(response.body.url));
  assert.equal(download.status, 200);
  assert.equal(download.text, 'hello AgilFrame');
  assert.equal(download.headers.get('content-type'), 'text/plain');

  const withoutSignature = await ts.api('GET', `/v1/files/${response.body.id}`);
  assert.equal(withoutSignature.status, 403);

  const badSignature = await ts.api('GET', `/v1/files/${response.body.id}?sig=deadbeef&exp=9999999999999`);
  assert.equal(badSignature.status, 403);

  const traversal = await ts.api('GET', '/v1/files/..%2f..%2fpackage.json');
  assert.equal(traversal.status, 404);

  const noAuth = await ts.api('POST', '/v1/files', {
    headers: { 'x-file-name': 'x.txt', 'content-type': 'text/plain' },
    rawBody: 'x',
  });
  assert.equal(noAuth.status, 401);

  // Signed links are not delivered while the tenant disables the feature.
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: false } } });
  const gatedDownload = await ts.api('GET', relativeUrl(response.body.url));
  assert.equal(gatedDownload.status, 403);
  assert.equal(gatedDownload.body.error.code, 'feature_disabled');
  await ts.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: true } } });
});

test('F-03: files require features.fileShare AND the effective participant permission', async () => {
  const gated = await startTestServer();
  try {
    const created = await gated.api('POST', '/v1/rooms', { body: { name: 'Gating room' } });
    const roomId = created.body.room.id;
    const hostToken = created.body.token;
    const upload = async (bearerToken: string): Promise<any> =>
      gated.api('POST', '/v1/files', {
        headers: { authorization: `Bearer ${bearerToken}`, 'x-file-name': 'gate.txt', 'content-type': 'text/plain' },
        rawBody: 'gate',
      });

    // features.fileShare defaults to false → everyone is denied, including hosts.
    const hostDenied = await upload(hostToken);
    assert.equal(hostDenied.status, 403, 'strict gate applies to the host too');
    assert.equal(hostDenied.body.error.code, 'feature_disabled');

    const guest = await gated.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId, participant: { name: 'Guest', role: 'guest' } },
    });
    const guestDenied = await upload(guest.body.token);
    assert.equal(guestDenied.status, 403, 'guest denied while features.fileShare=false');

    await gated.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: true } } });
    assert.equal((await upload(hostToken)).status, 200, 'host with the feature enabled can upload');
    assert.equal((await upload(guest.body.token)).status, 200, 'guest role defaults include fileShare');

    const pinned = await gated.api('POST', '/v1/tokens', {
      headers: ADMIN,
      body: { tenantId: 'demo', roomId, participant: { name: 'Pinned' }, permissions: ['chat'] },
    });
    const pinnedDenied = await upload(pinned.body.token);
    assert.equal(pinnedDenied.status, 403, 'token pinned without fileShare');
    assert.equal(pinnedDenied.body.error.code, 'feature_disabled');

    await gated.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: false } } });
    assert.equal((await upload(guest.body.token)).status, 403, 'feature flag off denies the guest too');
  } finally {
    await gated.close();
  }
});

test('upload larger than the configured limit → 413', async () => {
  const small = await startTestServer({ maxUploadMb: 1 });
  try {
    await small.api('PATCH', '/v1/tenants/demo/config', { headers: ADMIN, body: { features: { fileShare: true } } });
    const created = await small.api('POST', '/v1/rooms', { body: { name: 'Tiny' } });
    const upload = await small.api('POST', '/v1/files', {
      headers: {
        authorization: `Bearer ${created.body.token}`,
        'x-file-name': 'big.bin',
        'content-type': 'application/octet-stream',
      },
      rawBody: Buffer.alloc(2 * 1024 * 1024, 1),
    });
    assert.equal(upload.status, 413);
    assert.equal(upload.body.error.code, 'file_too_large');
  } finally {
    await small.close();
  }
});

test('file uploads follow the effective room MIME and size policy', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: {
    name: 'Text attachments', configOverrides: { session: { fileShare: { allowedMimeTypes: ['TEXT/*'], maxFileSizeMb: 1 } } },
  } });
  assert.equal(created.status, 200);
  const upload = (contentType: string, rawBody: Buffer | string) => ts.api('POST', '/v1/files', {
    headers: { authorization: `Bearer ${created.body.token}`, 'x-file-name': 'input.txt' }, contentType, rawBody,
  });
  const allowed = await upload('text/plain; charset=utf-8', 'meeting notes');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.mime, 'text/plain');
  const other = await upload('image/png', 'out of scope');
  assert.equal(other.status, 415);
  assert.equal(other.body.error.code, 'unsupported_mime');
  const large = await upload('text/plain', Buffer.alloc(1024 * 1024 + 1));
  assert.equal(large.status, 413);
  assert.equal(large.body.error.code, 'file_too_large');
});

test('recordings: disabled by default, enabled by config, listed and deleted by admin', async () => {
  const disabled = await ts.api('POST', '/v1/recordings', {
    headers: { ...bearer(), 'x-recording-meta': JSON.stringify({ roomId, durationSec: 3, mimeType: 'video/webm' }), 'content-type': 'video/webm' },
    rawBody: Buffer.from('fake-webm'),
  });
  assert.equal(disabled.status, 403);

  const patched = await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: {
      session: { recording: { enabled: true, storeOnServer: true } },
      features: { recording: true },
    },
  });
  assert.equal(patched.status, 200);

  const uploaded = await ts.api('POST', '/v1/recordings', {
    headers: { ...bearer(), 'x-recording-meta': JSON.stringify({ roomId, durationSec: 3, mimeType: 'video/webm' }), 'content-type': 'video/webm' },
    rawBody: Buffer.from('fake-webm'),
  });
  assert.equal(uploaded.status, 200);
  assert.ok(uploaded.body.url.includes('sig='));

  const download = await ts.api('GET', relativeUrl(uploaded.body.url));
  assert.equal(download.status, 200);
  assert.equal(download.text, 'fake-webm');

  const list = await ts.api('GET', `/v1/admin/recordings?roomId=${roomId}`, { headers: ADMIN });
  assert.equal(list.status, 200);
  assert.ok(list.body.recordings.some((record: { id: string }) => record.id === uploaded.body.id));

  const removed = await ts.api('DELETE', `/v1/admin/recordings/${uploaded.body.id}`, { headers: ADMIN });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);
  const after = await ts.api('DELETE', `/v1/admin/recordings/${uploaded.body.id}`, { headers: ADMIN });
  assert.equal(after.status, 404);

  // Guest role has no `recording` permission even with the tenant flag on.
  const guest = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Guest', role: 'guest' } },
  });
  const guestRecording = await ts.api('POST', '/v1/recordings', {
    headers: {
      authorization: `Bearer ${guest.body.token}`,
      'content-type': 'video/webm',
      'x-recording-meta': JSON.stringify({ roomId, durationSec: 1, mimeType: 'video/webm' }),
    },
    rawBody: Buffer.from('webm'),
  });
  assert.equal(guestRecording.status, 403);
  assert.equal(guestRecording.body.error.code, 'feature_disabled');
});

test('STT returns 501 with a hint when AGIL_STT_URL is not configured', async () => {
  const response = await ts.api('POST', '/v1/stt/transcribe', {
    headers: { ...bearer(), 'content-type': 'audio/webm', 'x-language': 'ru' },
    rawBody: Buffer.from('audio'),
  });
  assert.equal(response.status, 501);
  assert.equal(response.body.error.code, 'stt_not_configured');
  assert.ok(String(response.body.error.message).toLowerCase().includes('stt'));
});
