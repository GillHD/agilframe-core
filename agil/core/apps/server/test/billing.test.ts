/**
 * Billing / quota metering baseline (P2):
 *  - usage accumulation from room lifecycle + recordings;
 *  - hard quota enforcement on room create (402) and join (429 / WS quota_exceeded);
 *  - soft-warning policy (default) and tenant isolation;
 *  - plan PATCH validation + audit;
 *  - UTC month reset with persisted monthly JSON files.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BillingService,
  billingMonth,
  evaluateJoinQuota,
  evaluateRoomCreateQuota,
} from '../src/billing.js';
import { DEFAULT_BILLING, type BillingConfig } from '@agil/protocol';
import { delay, openWs, startTestServer, waitForClose, type TestServer } from './helpers.js';

let ts: TestServer;

const PLATFORM = { 'x-api-key': 'platform-secret' };

before(async () => {
  ts = await startTestServer({ platformKey: 'platform-secret' });
});

after(async () => {
  await ts?.close();
});

/** Creates an isolated tenant through the platform surface and returns its API key. */
async function createTenant(tenantId: string): Promise<string> {
  const response = await ts.api('POST', '/v1/admin/tenants', {
    headers: PLATFORM,
    body: { tenantId, name: `Tenant ${tenantId}` },
  });
  assert.equal(response.status, 200, response.text);
  assert.ok(response.body.apiKey, 'tenant API key must be issued once');
  return response.body.apiKey as string;
}

function admin(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey };
}

async function setPlan(apiKey: string, patch: Record<string, unknown>) {
  return ts.api('PATCH', '/v1/admin/billing/plan', { headers: admin(apiKey), body: patch });
}

async function createRoom(apiKey: string, body: Record<string, unknown> = {}) {
  return ts.api('POST', '/v1/rooms', {
    headers: admin(apiKey),
    body: { name: 'Billing room', maxParticipants: 10, ...body },
  });
}

async function usage(apiKey: string, month?: string) {
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  return ts.api('GET', `/v1/admin/billing/usage${query}`, { headers: admin(apiKey) });
}

test('usage accumulates room minutes/participants/rooms and persists monthly JSON', async () => {
  const key = await createTenant('meter-1');
  const empty = await usage(key);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.usage.minutes, 0);
  assert.equal(empty.body.usage.roomsCreated, 0);
  assert.equal(empty.body.billing.plan, 'free');
  assert.equal(empty.body.billing.enabled, false);
  assert.equal(empty.body.billing.overagePolicy, 'warn');

  const room = await createRoom(key, { maxParticipants: 6 });
  assert.equal(room.status, 200, room.text);
  const token = room.body.token as string;
  assert.ok(token);

  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(token)}`);
  await delay(300);
  await client.close();
  await delay(150);

  const afterLeave = await usage(key);
  assert.equal(afterLeave.status, 200, afterLeave.text);
  assert.equal(afterLeave.body.usage.roomsCreated, 1);
  assert.equal(afterLeave.body.usage.participantJoins, 1);
  assert.equal(afterLeave.body.usage.peakParticipants, 1);
  assert.ok(afterLeave.body.usage.minutes > 0, 'settled minutes must be > 0');
  assert.equal(afterLeave.body.live.activeParticipants, 0);
  assert.equal(afterLeave.body.live.liveMinutes, 0);
  assert.equal(afterLeave.body.live.totalMinutes, afterLeave.body.usage.minutes);

  // One JSON file per tenant per UTC month.
  const month = billingMonth(Date.now());
  const file = path.join(ts.dataDir, 'billing', 'meter-1', `${month}.json`);
  assert.ok(existsSync(file), `expected usage file ${file}`);
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.month, month);
  assert.equal(persisted.tenantId, 'meter-1');
  assert.equal(persisted.roomsCreated, 1);
  assert.equal(persisted.participantJoins, 1);
});

test('hard quota: room creation returns 402 and join returns 429/WS quota_exceeded', async () => {
  const createKey = await createTenant('quota-rooms');
  const plan = await setPlan(createKey, {
    enabled: true,
    plan: 'free',
    includedMinutes: 1000,
    maxParticipants: 2,
    maxRooms: 1,
    overagePolicy: 'block',
  });
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.body.billing.enabled, true);

  const first = await createRoom(createKey);
  assert.equal(first.status, 200, first.text);
  const second = await createRoom(createKey);
  assert.equal(second.status, 402);
  assert.equal(second.body.error.code, 'quota_exceeded');
  assert.equal(second.body.error.details.metric, 'rooms');
  assert.equal(second.body.error.details.limit, 1);

  // Participant quota is enforced per tenant, not only per room: create the
  // room while billing is off (room cap 5), then switch the plan to 2.
  const joinKey = await createTenant('quota-join');
  const room = await createRoom(joinKey, { maxParticipants: 5 });
  assert.equal(room.status, 200, room.text);
  const roomId = room.body.room.id as string;
  const joinPlan = await setPlan(joinKey, { enabled: true, includedMinutes: 1000, maxParticipants: 2, overagePolicy: 'block' });
  assert.equal(joinPlan.status, 200, joinPlan.text);

  const host = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(room.body.token as string)}`);
  const guestJoin = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Guest' } });
  assert.equal(guestJoin.status, 200, guestJoin.text);
  const guest = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guestJoin.body.token as string)}`);
  await delay(100);

  const third = await ts.api('POST', `/v1/rooms/${roomId}/join`, { body: { name: 'Third' } });
  assert.equal(third.status, 429, third.text);
  assert.equal(third.body.error.code, 'quota_exceeded');
  assert.equal(third.body.error.details.metric, 'participants');

  // The WebSocket path is enforced too (a token can be minted, the join fails).
  const minted = await ts.api('POST', '/v1/tokens', {
    headers: admin(joinKey),
    body: { tenantId: 'quota-join', roomId, participant: { name: 'Third' } },
  });
  assert.equal(minted.status, 200, minted.text);
  const rejected = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(minted.body.token as string)}`);
  const errorFrame = await rejected.waitFor((message) => message.type === 'error');
  assert.equal(errorFrame.code, 'quota_exceeded');
  const closeCode = await waitForClose(rejected);
  assert.equal(closeCode, 1008);

  await guest.close();
  await host.close();
});

test('soft warning policy allows the operation and surfaces a warning', async () => {
  const key = await createTenant('warn-1');
  const plan = await setPlan(key, {
    enabled: true,
    includedMinutes: 1000,
    maxParticipants: 5,
    maxRooms: 1,
    overagePolicy: 'warn',
  });
  assert.equal(plan.status, 200, plan.text);

  const first = await createRoom(key);
  assert.equal(first.status, 200);
  const second = await createRoom(key);
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.billingWarning.code, 'quota_warning');
  assert.equal(second.body.billingWarning.metric, 'rooms');
  assert.equal(second.headers.get('x-agil-billing-warning'), 'rooms');

  const current = await usage(key);
  assert.equal(current.status, 200);
  assert.ok(current.body.warnings.some((warning: { metric: string }) => warning.metric === 'rooms'));
  assert.equal(current.body.quota.maxRooms, 1);
});

test('tenant isolation: usage counters and plans never leak across tenants', async () => {
  const keyA = await createTenant('iso-a');
  const keyB = await createTenant('iso-b');

  const room = await createRoom(keyA);
  assert.equal(room.status, 200);
  const client = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(room.body.token as string)}`);
  await delay(200);
  await client.close();
  await delay(100);

  const usageA = await usage(keyA);
  const usageB = await usage(keyB);
  assert.equal(usageA.status, 200);
  assert.equal(usageB.status, 200);
  assert.ok(usageA.body.usage.roomsCreated >= 1);
  assert.ok(usageA.body.usage.minutes > 0);
  assert.equal(usageB.body.tenantId, 'iso-b');
  assert.equal(usageB.body.usage.roomsCreated, 0);
  assert.equal(usageB.body.usage.minutes, 0);
  assert.equal(usageB.body.usage.participantJoins, 0);
  assert.deepEqual(usageB.body.months, []);

  // A plan change for A is invisible to B.
  const patched = await setPlan(keyA, { plan: 'business', enabled: true });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.billing.plan, 'business');
  const planB = await ts.api('GET', '/v1/admin/billing/plan', { headers: admin(keyB) });
  assert.equal(planB.status, 200);
  assert.equal(planB.body.billing.plan, 'free');
  assert.equal(planB.body.billing.enabled, false);
});

test('plan PATCH: catalog presets, explicit overrides and validation', async () => {
  const key = await createTenant('plan-1');

  const team = await setPlan(key, { plan: 'team', enabled: true, overagePolicy: 'warn' });
  assert.equal(team.status, 200, team.text);
  assert.equal(team.body.billing.plan, 'team');
  assert.equal(team.body.billing.includedMinutes, 3000);
  assert.equal(team.body.billing.maxParticipants, 25);
  assert.equal(team.body.billing.maxRooms, 50);
  assert.equal(team.body.billing.enabled, true);
  assert.equal(team.body.plans.enterprise.maxRooms, 5000);

  const override = await setPlan(key, { plan: 'business', includedMinutes: 12345, maxRooms: 77 });
  assert.equal(override.status, 200, override.text);
  assert.equal(override.body.billing.plan, 'business');
  assert.equal(override.body.billing.includedMinutes, 12345);
  assert.equal(override.body.billing.maxRooms, 77);
  assert.equal(override.body.billing.maxParticipants, 100, 'catalog value kept unless overridden');
  assert.equal(override.body.billing.enabled, true, 'enabled is preserved when omitted');

  const getPlan = await ts.api('GET', '/v1/admin/billing/plan', { headers: admin(key) });
  assert.equal(getPlan.status, 200);
  assert.equal(getPlan.body.billing.includedMinutes, 12345);
  assert.equal(typeof getPlan.body.usage.totalMinutes, 'number');

  for (const body of [
    {},
    { plan: 'platinum' },
    { includedMinutes: -1 },
    { maxRooms: 0 },
    { maxParticipants: 1 },
    { overagePolicy: 'block-hard' },
    { cardNumber: '4111111111111111' },
  ]) {
    const invalid = await setPlan(key, body);
    assert.equal(invalid.status, 400, `expected 400 for ${JSON.stringify(body)}: ${invalid.text}`);
    assert.equal(invalid.body.error.code, 'validation_failed');
  }

  const audit = await ts.api('GET', '/v1/admin/audit?type=admin.action&limit=100', { headers: admin(key) });
  assert.equal(audit.status, 200);
  const billingEntry = (audit.body.entries as Array<Record<string, any>>).find(
    (entry) => entry.details?.kind === 'billing.updated',
  );
  assert.ok(billingEntry, 'billing plan change must be audited');
  assert.equal(billingEntry.details.plan, 'business');
  assert.equal(billingEntry.details.previousPlan, 'team');
  assert.ok(!('cardNumber' in billingEntry.details));
});

test('usage month query validates format and returns an empty past month', async () => {
  const key = await createTenant('month-1');
  const invalid = await ts.api('GET', '/v1/admin/billing/usage?month=2026-13', { headers: admin(key) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'validation_failed');

  const past = await usage(key, '2020-01');
  assert.equal(past.status, 200);
  assert.equal(past.body.month, '2020-01');
  assert.equal(past.body.usage.minutes, 0);
  assert.equal(past.body.live.totalMinutes, 0);
  assert.deepEqual(past.body.months, []);
});

test('BillingService: month reset keeps previous month and starts from zero (UTC)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agil-billing-test-'));
  try {
    let now = Date.UTC(2026, 10, 15, 12, 0, 0); // 2026-11-15
    const service = new BillingService({ dir, now: () => now });
    service.recordRoomCreated('demo');
    service.recordParticipantJoin('demo', 'room-1', 'p-1');
    now += 90_000; // 1.5 minutes
    service.recordParticipantLeave('room-1', 'p-1');
    service.recordRecording('demo', 90);

    const november = service.getUsage('demo');
    assert.equal(november.month, '2026-11');
    assert.equal(november.minutes, 1.5);
    assert.equal(november.roomsCreated, 1);
    assert.equal(november.participantJoins, 1);
    assert.equal(november.recordings, 1);
    assert.equal(november.recordingMinutes, 1.5);

    // New UTC month: current usage starts at zero; the old file stays readable.
    now = Date.UTC(2026, 11, 1, 0, 5, 0); // 2026-12-01
    const december = service.getUsage('demo');
    assert.equal(december.month, '2026-12');
    assert.equal(december.minutes, 0);
    assert.equal(december.roomsCreated, 0);
    assert.deepEqual(service.listMonths('demo'), ['2026-11']);

    const novemberAgain = service.getUsage('demo', '2026-11');
    assert.equal(novemberAgain.minutes, 1.5);
    assert.equal(novemberAgain.recordings, 1);

    service.recordRoomCreated('demo');
    assert.equal(service.getUsage('demo').roomsCreated, 1);
    assert.deepEqual(service.listMonths('demo'), ['2026-12', '2026-11']);

    // A restarted service reads the persisted month back from disk.
    const reopened = new BillingService({ dir, now: () => now });
    assert.equal(reopened.getUsage('demo', '2026-11').minutes, 1.5);
    assert.equal(reopened.getUsage('demo', '2026-12').roomsCreated, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BillingService: resume continues/reopens a session and duplicate sockets do not count joins', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agil-billing-resume-'));
  try {
    let now = Date.UTC(2026, 10, 15, 12, 0, 0);
    const service = new BillingService({ dir, now: () => now });
    service.recordParticipantJoin('demo', 'room-1', 'p-1');
    assert.equal(service.getUsage('demo').participantJoins, 1);
    now += 60_000;
    // Legacy duplicate socket for the same participant: no new join, no reset.
    service.recordParticipantJoin('demo', 'room-1', 'p-1');
    assert.equal(service.getUsage('demo').participantJoins, 1);
    assert.equal(service.liveMinutes('demo'), 1);
    // Grace-window resume is a no-op: the session never stopped.
    service.recordParticipantResume('demo', 'room-1', 'p-1');
    assert.equal(service.getUsage('demo').participantJoins, 1);
    assert.equal(service.liveMinutes('demo'), 1);

    // Core restart: a fresh service has no in-memory session. The resumed
    // participant reopens the meter at resume time without a join count.
    now += 60_000;
    const restarted = new BillingService({ dir, now: () => now });
    assert.equal(restarted.getUsage('demo').participantJoins, 1);
    restarted.recordParticipantResume('demo', 'room-1', 'p-1');
    assert.equal(restarted.getUsage('demo').participantJoins, 1, 'resume is not a join');
    now += 30_000;
    assert.equal(restarted.liveMinutes('demo'), 0.5, 'live minutes resume from the reconnect');
    restarted.recordParticipantLeave('room-1', 'p-1');
    assert.equal(restarted.getUsage('demo').minutes, 0.5);
    assert.equal(restarted.getUsage('demo').participantJoins, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quota helpers: default free/off allows everything; policies decide warn vs block', () => {
  const off: BillingConfig = { ...DEFAULT_BILLING };
  assert.equal(evaluateRoomCreateQuota({ billing: off, usage: { minutes: 999 }, liveMinutes: 0, activeRooms: 50 }).allowed, true);
  assert.equal(evaluateJoinQuota({ billing: off, usage: { minutes: 999 }, liveMinutes: 0, activeParticipants: 50 }).allowed, true);

  const block: BillingConfig = { ...DEFAULT_BILLING, enabled: true, includedMinutes: 10, maxRooms: 2, maxParticipants: 2, overagePolicy: 'block' };
  const roomDecision = evaluateRoomCreateQuota({ billing: block, usage: { minutes: 0 }, liveMinutes: 0, activeRooms: 2 });
  assert.equal(roomDecision.allowed, false);
  assert.equal(roomDecision.blocked?.metric, 'rooms');

  const joinDecision = evaluateJoinQuota({ billing: block, usage: { minutes: 10 }, liveMinutes: 0, activeParticipants: 1 });
  assert.equal(joinDecision.allowed, false);
  assert.equal(joinDecision.blocked?.metric, 'minutes');

  const warn: BillingConfig = { ...block, overagePolicy: 'warn' };
  const warned = evaluateRoomCreateQuota({ billing: warn, usage: { minutes: 0 }, liveMinutes: 0, activeRooms: 2 });
  assert.equal(warned.allowed, true);
  assert.equal(warned.warnings[0]?.metric, 'rooms');
  assert.equal(warned.warnings[0]?.policy, 'warn');

  const allow: BillingConfig = { ...block, overagePolicy: 'allow' };
  const allowed = evaluateRoomCreateQuota({ billing: allow, usage: { minutes: 0 }, liveMinutes: 0, activeRooms: 2 });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.warnings, []);
});
