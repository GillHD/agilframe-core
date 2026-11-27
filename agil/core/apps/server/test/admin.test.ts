/** Admin API: overview, rooms, invites, lock, kick, transcript, analysis, audit. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openWs, startTestServer, waitForClose, type TestServer } from './helpers.js';
import { summarizeExternalError } from '../src/analysis.js';

const ADMIN = { 'x-api-key': 'dev-key' };
let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

test('overview + room lifecycle + invite links', async () => {
  const overview = await ts.api('GET', '/v1/admin/overview', { headers: ADMIN });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.tenantId, 'demo');
  assert.ok(overview.body.totalRoomsCreated >= 0);
  assert.equal(typeof overview.body.countries, 'object');

  const created = await ts.api('POST', '/v1/admin/rooms', {
    headers: ADMIN,
    body: { name: 'Admin room', password: 'pass1234', maxParticipants: 5 },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.passwordProtected, true);
  assert.ok(!JSON.stringify(created.body).includes('pass1234'));
  const roomId = created.body.room.id;

  const list = await ts.api('GET', '/v1/admin/rooms', { headers: ADMIN });
  const summary = list.body.rooms.find((entry: { room: { id: string } }) => entry.room.id === roomId);
  assert.ok(summary);
  assert.equal(summary.passwordProtected, true);
  assert.equal(summary.maxParticipants, 5);

  const invite = await ts.api('POST', `/v1/admin/rooms/${roomId}/invites`, { headers: ADMIN, body: { ttlSec: 600 } });
  assert.equal(invite.status, 200);
  assert.ok(invite.body.joinUrl.includes('token='));
  assert.ok(invite.body.embedUrl.includes('/embed.html?'));
  assert.ok(invite.body.token);
  assert.equal(invite.body.passwordProtected, true);

  const detail = await ts.api('GET', `/v1/admin/rooms/${roomId}`, { headers: ADMIN });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.room.id, roomId);
  assert.ok(Array.isArray(detail.body.messages));
  assert.equal(detail.body.passwordProtected, true);

  const foreign = await ts.api('GET', `/v1/admin/rooms/${roomId}`, { headers: { 'x-api-key': 'acme-key' } });
  assert.equal(foreign.status, 403);

  const deleted = await ts.api('DELETE', `/v1/admin/rooms/${roomId}`, { headers: ADMIN });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.closed, true);
  const gone = await ts.api('GET', `/v1/admin/rooms/${roomId}`, { headers: ADMIN });
  assert.equal(gone.status, 404);
});

test('kick closes the participant WebSocket', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Kick room' } });
  const roomId = created.body.room.id;
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'KickMe' } },
  });
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
  const welcome = await client.waitFor((message) => message.type === 'welcome');
  const close = waitForClose(client);
  const kicked = await ts.api('POST', `/v1/admin/rooms/${roomId}/kick`, {
    headers: ADMIN,
    body: { participantId: welcome.self.id },
  });
  assert.equal(kicked.status, 200);
  assert.equal(kicked.body.kicked, true);
  assert.ok([1000, 1005, 1006, 1008].includes(await close));
  const missing = await ts.api('POST', `/v1/admin/rooms/${roomId}/kick`, {
    headers: ADMIN,
    body: { participantId: 'ghost' },
  });
  assert.equal(missing.status, 404);
});

test('transcript collects captions and analysis runs local compliance rules', async () => {
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Analysis room' } });
  const roomId = created.body.room.id;
  const issued = await ts.api('POST', '/v1/tokens', {
    headers: ADMIN,
    body: { tenantId: 'demo', roomId, participant: { name: 'Speaker' } },
  });

  const configured = await ts.api('PUT', '/v1/admin/ai-agent', {
    headers: ADMIN,
    body: {
      config: {
        enabled: true,
        mode: 'local',
        policyRules: [
          { id: 'confidential', name: 'Секретная тема', type: 'phrase', pattern: 'секрет', severity: 'warn', action: 'flag', enabled: true },
        ],
      },
    },
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.config.policyRules.length, 1);

  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(issued.body.token)}`);
  await client.waitFor((message) => message.type === 'welcome');
  client.send({ type: 'caption', text: 'это секретная информация компании', isFinal: true, lang: 'ru' });
  client.send({ type: 'caption', text: 'обсудим квартальный отчёт и бюджет', isFinal: true, lang: 'ru' });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const transcript = await ts.api('GET', `/v1/admin/rooms/${roomId}/transcript`, { headers: ADMIN });
  assert.equal(transcript.status, 200);
  assert.ok(transcript.body.segments.length >= 2);
  assert.equal(transcript.body.segments[0].participantName, 'Speaker');

  const run = await ts.api('POST', `/v1/admin/rooms/${roomId}/analysis/run`, { headers: ADMIN });
  assert.equal(run.status, 200);
  assert.ok(Array.isArray(run.body.findings));
  assert.ok(run.body.findings.some((finding: { ruleId: string }) => finding.ruleId === 'confidential'));
  assert.ok(run.body.report);
  assert.ok(run.body.notes);

  const stored = await ts.api('GET', `/v1/admin/rooms/${roomId}/analysis`, { headers: ADMIN });
  assert.equal(stored.status, 200);
  assert.ok(stored.body.findings.length >= 1);

  // BUG-ROOM-EXPORT: notes/analysis are exportable as JSON and markdown.
  const notes = await ts.api('GET', `/v1/admin/rooms/${roomId}/notes`, { headers: ADMIN });
  assert.equal(notes.status, 200);
  assert.equal(notes.body.roomId, roomId);
  assert.ok(notes.body.notes && typeof notes.body.notes.summary === 'string');
  const notesMd = await ts.api('GET', `/v1/admin/rooms/${roomId}/notes?format=md&download=1`, { headers: ADMIN });
  assert.equal(notesMd.status, 200);
  assert.ok(notesMd.headers.get('content-type')?.includes('text/markdown'));
  assert.ok(notesMd.headers.get('content-disposition')?.includes('attachment'));
  assert.ok(notesMd.text.includes('# Заметки встречи'));
  const analysisMd = await ts.api('GET', `/v1/admin/rooms/${roomId}/analysis?format=md`, { headers: ADMIN });
  assert.equal(analysisMd.status, 200);
  assert.ok(analysisMd.text.includes('# Анализ звонка'));
  assert.ok(analysisMd.text.includes('## Находки'));

  const analysisMessage = client.waitFor((message) => message.type === 'analysis');
  client.send({ type: 'analysis-request' });
  const broadcast = await analysisMessage;
  assert.equal(broadcast.roomId, roomId);

  const audit = await ts.api('GET', `/v1/admin/audit?roomId=${roomId}&limit=100`, { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { details?: { kind?: string } }) => entry.details?.kind === 'analysis.run'));
  await client.close();
});

test('GET /v1/admin/ai-agent returns the default config when the agent is not configured', async () => {
  const response = await ts.api('GET', '/v1/admin/ai-agent', { headers: ADMIN });
  assert.equal(response.status, 200);
  assert.equal(response.body.endpointConfigured, false);
  assert.equal(response.body.apiKeyConfigured, false);
  assert.equal(typeof response.body.config, 'object');
  assert.equal(Array.isArray(response.body.config.policyRules), true);
});

test('audit and security endpoints are tenant-scoped', async () => {
  const audit = await ts.api('GET', '/v1/admin/audit?limit=20', { headers: ADMIN });
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.body.entries));
  assert.ok(audit.body.entries.every((entry: { tenantId?: string }) => entry.tenantId === 'demo'));
  assert.ok(!JSON.stringify(audit.body).includes('127.0.0.1'));
  assert.equal(typeof audit.body.total, 'number');
  assert.equal(audit.body.offset, 0);
  assert.equal(audit.body.limit, 20);

  const secondPage = await ts.api('GET', '/v1/admin/audit?limit=5&offset=5', { headers: ADMIN });
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.offset, 5);
  assert.ok(secondPage.body.entries.length <= 5);

  const warnOnly = await ts.api('GET', '/v1/admin/audit?severity=warn&limit=50', { headers: ADMIN });
  assert.equal(warnOnly.status, 200);
  assert.ok(warnOnly.body.entries.every((entry: { severity: string }) => entry.severity === 'warn'));
  const badSeverity = await ts.api('GET', '/v1/admin/audit?severity=nope', { headers: ADMIN });
  assert.equal(badSeverity.status, 400);

  const invalid = await ts.api('GET', '/v1/admin/audit?type=nope', { headers: ADMIN });
  assert.equal(invalid.status, 400);

  const security = await ts.api('GET', '/v1/admin/security', { headers: ADMIN });
  assert.equal(security.status, 200);
  assert.equal(security.body.tenantId, 'demo');

  const recordings = await ts.api('GET', '/v1/admin/recordings', { headers: ADMIN });
  assert.equal(recordings.status, 200);
  assert.ok(Array.isArray(recordings.body.recordings));
});

test('analysis audit externalError stores only a code/status, never provider HTML', () => {
  const html = '<!doctype html><html><body><h1>502 Bad Gateway</h1><p>Sensitive upstream body</p></body></html>';
  assert.equal(summarizeExternalError(`HTTP 502: ${html}`), 'http_502');
  assert.equal(summarizeExternalError(html), 'provider_error');
  assert.equal(summarizeExternalError('fetch failed'), 'provider_error');
  assert.equal(summarizeExternalError('connect ECONNREFUSED 127.0.0.1:9'), 'network_error');
  assert.equal(summarizeExternalError('The operation was aborted due to timeout'), 'timeout');
  assert.equal(summarizeExternalError(undefined), null);
});
