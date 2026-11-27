/** Liveness challenge engine, tenant-scoped sessions, TTL/attempt limits and engine failure policy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChallengeLivenessEngine,
  HttpLivenessEngine,
  LIVENESS_TASKS,
  LivenessService,
  LivenessSessionStore,
  type LivenessEngine,
} from '../src/liveness.js';
import { SecurityError } from '../src/errors.js';

const OWNER = { tenantId: 'demo', roomId: 'room-1', participantId: 'p-1' };

function serviceWith(
  engine?: LivenessEngine,
  policy: { ttlSec?: number; maxAttempts?: number; onEngineError?: 'fail-open' | 'fail-closed' } = {},
): LivenessService {
  return new LivenessService({
    engine: engine ?? new ChallengeLivenessEngine(),
    policy: { ttlSec: policy.ttlSec ?? 180, maxAttempts: policy.maxAttempts ?? 2, onEngineError: policy.onEngineError ?? 'fail-open' },
  });
}

test('challenge engine issues a task from the supported list bound to tenant/room/participant', async () => {
  const service = serviceWith();
  const challenge = await service.issue(OWNER);
  assert.ok(LIVENESS_TASKS.includes(challenge.task));
  assert.equal(challenge.tenantId, 'demo');
  assert.equal(challenge.roomId, 'room-1');
  assert.equal(challenge.participantId, 'p-1');
  assert.equal(challenge.attempts, 0);
  assert.equal(challenge.maxAttempts, 2);
  assert.ok(challenge.expiresAt > challenge.issuedAt);
  assert.equal(service.sessionCount, 1);
  assert.equal(service.engineName, 'challenge');
});

test('the matching task signal verifies; a missing signal fails without accusing a deepfake', async () => {
  const service = serviceWith();
  const blink = await service.issue({ ...OWNER, task: 'blink' });
  const passed = await service.verify({ ...OWNER, sessionId: blink.sessionId, signals: { blinkDetected: true, faceDetected: true } });
  assert.equal(passed.passed, true);
  assert.equal(passed.status, 'verified');
  assert.equal(passed.flags.length, 0);
  assert.equal(passed.attempts, 1);
  assert.equal(service.sessionCount, 0, 'verified sessions are single-use');

  const turn = await service.issue(OWNER);
  const headTask = turn.task !== 'blink';
  const failed = await service.verify({
    ...OWNER,
    sessionId: turn.sessionId,
    signals: headTask ? { blinkDetected: true } : { headTurnDetected: false },
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.flags.includes('liveness_signal_missing'));
});

test('unavailable face model is "unknown", not a failure (fail-open default)', async () => {
  const service = serviceWith();
  const challenge = await service.issue(OWNER);
  const verdict = await service.verify({ ...OWNER, sessionId: challenge.sessionId, signals: { modelAvailable: false } });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.status, 'unavailable');
  assert.ok(verdict.flags.includes('liveness_model_unavailable'));
});

test('sessions are tenant scoped: a foreign tenant/room/participant cannot verify or consume them', async () => {
  const service = serviceWith();
  const challenge = await service.issue(OWNER);

  const foreignTenant = await service.verify({
    tenantId: 'acme',
    roomId: 'room-1',
    participantId: 'p-1',
    sessionId: challenge.sessionId,
    signals: { blinkDetected: true },
  });
  assert.equal(foreignTenant.status, 'invalid');
  assert.ok(foreignTenant.flags.includes('liveness_session_unknown'));

  const foreignParticipant = await service.verify({
    ...OWNER,
    participantId: 'p-2',
    sessionId: challenge.sessionId,
    signals: { blinkDetected: true },
  });
  assert.equal(foreignParticipant.status, 'invalid');
  assert.ok(foreignParticipant.flags.includes('liveness_session_mismatch'));

  const stillValid = await service.verify({
    ...OWNER,
    sessionId: challenge.sessionId,
    signals: { blinkDetected: true, headTurnDetected: true },
  });
  assert.equal(stillValid.status, 'verified', 'failed cross-tenant attempts do not consume the session');
});

test('attempts are bounded and the session id becomes unusable afterwards', async () => {
  const service = serviceWith(undefined, { maxAttempts: 2 });
  const challenge = await service.issue(OWNER);
  const first = await service.verify({ ...OWNER, sessionId: challenge.sessionId, signals: { blinkDetected: false } });
  assert.equal(first.attempts, 1);
  const second = await service.verify({ ...OWNER, sessionId: challenge.sessionId, signals: { blinkDetected: false } });
  assert.equal(second.attempts, 2);
  const third = await service.verify({ ...OWNER, sessionId: challenge.sessionId, signals: { blinkDetected: true } });
  assert.equal(third.status, 'invalid');
  assert.ok(third.flags.includes('liveness_session_unknown') || third.flags.includes('liveness_attempts_exhausted'));
});

test('TTL expiry: sessions expire and are swept', async () => {
  let now = Date.now();
  const store = new LivenessSessionStore({ now: () => now });
  const service = new LivenessService({ engine: new ChallengeLivenessEngine(), store, policy: { ttlSec: 30 } });
  const challenge = await service.issue(OWNER);
  now += 31_000;
  assert.equal(store.size, 1, 'expired sessions remain until get()/sweep()');
  const verdict = await service.verify({ ...OWNER, sessionId: challenge.sessionId, signals: { blinkDetected: true } });
  assert.equal(verdict.status, 'invalid');
  assert.equal(store.size, 0);
  assert.equal(store.sweep(), 0);
});

test('engine crash/timeout follows the explicit fail-open / fail-closed policy', async () => {
  const crashing: LivenessEngine = {
    name: 'crashing',
    isConfigured: () => true,
    issue: async (input, options) => new ChallengeLivenessEngine().issue(input, options),
    verify: async () => {
      throw new Error('engine exploded');
    },
  };

  const open = new LivenessService({ engine: crashing, policy: { ttlSec: 180, maxAttempts: 2, onEngineError: 'fail-open' } });
  const openChallenge = await open.issue(OWNER);
  const openResult = await open.verify({ ...OWNER, sessionId: openChallenge.sessionId, signals: { blinkDetected: true } });
  assert.equal(openResult.status, 'unavailable');
  assert.equal(openResult.passed, false);
  assert.ok(openResult.flags.includes('liveness_engine_error'));

  const closed = new LivenessService({ engine: crashing, policy: { ttlSec: 180, maxAttempts: 2, onEngineError: 'fail-closed' } });
  const closedChallenge = await closed.issue(OWNER);
  const closedResult = await closed.verify({ ...OWNER, sessionId: closedChallenge.sessionId, signals: { blinkDetected: true } });
  assert.equal(closedResult.status, 'failed');
  assert.equal(closedResult.passed, false);
  assert.ok(closedResult.flags.includes('liveness_engine_unavailable_fail_closed'));
});

test('no engine configured → SecurityError liveness_not_configured (HTTP 501 upstream)', async () => {
  const service = new LivenessService({});
  assert.equal(service.isEnabled(), false);
  await assert.rejects(
    () => service.issue(OWNER),
    (error: unknown) => error instanceof SecurityError && error.code === 'liveness_not_configured',
  );
  await assert.rejects(
    () => service.verify({ ...OWNER, sessionId: 'nope', signals: {} }),
    (error: unknown) => error instanceof SecurityError && error.code === 'liveness_not_configured',
  );
});

test('HttpLivenessEngine: self-hosted detector round-trip, timeout and malformed replies are safe', async () => {
  const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')),
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    return new Response(JSON.stringify({ passed: true, score: 0.05, flags: [], status: 'verified' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const engine = new HttpLivenessEngine({ url: 'http://liveness.local:8080/', key: 'test-key', fetchImpl });
  assert.equal(engine.isConfigured(), true);
  const challenge = await new ChallengeLivenessEngine().issue(OWNER, { ttlSec: 60 });
  const verdict = await engine.verify({ challenge: { ...challenge, attempts: 1, maxAttempts: 2 }, signals: { blinkDetected: true } });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.engine, 'external');
  assert.equal(calls[0]?.url, 'http://liveness.local:8080/v1/liveness/verify');
  assert.equal(calls[0]?.auth, 'Bearer test-key');
  assert.deepEqual((calls[0]?.body as { session: { tenantId: string } }).session.tenantId, 'demo');

  const failing = new HttpLivenessEngine({
    url: 'http://liveness.local:8080',
    timeoutMs: 50,
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  });
  const down = await failing.verify({ challenge: { ...challenge, attempts: 1, maxAttempts: 2 }, signals: {} });
  assert.equal(down.status, 'unavailable');
  assert.ok(down.flags.includes('liveness_engine_error'));

  const malformed = new HttpLivenessEngine({
    url: 'http://liveness.local:8080',
    fetchImpl: (async () => new Response('not-json', { status: 500 })) as unknown as typeof fetch,
  });
  const broken = await malformed.verify({ challenge: { ...challenge, attempts: 1, maxAttempts: 2 }, signals: {} });
  assert.equal(broken.status, 'unavailable');

  assert.equal(new HttpLivenessEngine({ url: '' }).isConfigured(), false);
});

test('HttpLivenessEngine: contradictory status/passed replies are normalised, not trusted blindly', async () => {
  const challenge = await new ChallengeLivenessEngine().issue(OWNER, { ttlSec: 60 });
  const verifyWith = async (payload: Record<string, unknown>) => {
    const engine = new HttpLivenessEngine({
      url: 'http://liveness.local:8080',
      fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch,
    });
    return engine.verify({ challenge: { ...challenge, attempts: 1, maxAttempts: 2 }, signals: { blinkDetected: true } });
  };

  // `verified` + `passed:false`: the status wins (the endpoint judges status),
  // and the contradiction is visible as a flag.
  const falseNegative = await verifyWith({ status: 'verified', passed: false, score: 0.9 });
  assert.equal(falseNegative.status, 'verified');
  assert.equal(falseNegative.passed, true);
  assert.ok(falseNegative.flags.includes('liveness_engine_inconsistent_verdict'));

  // `failed` + `passed:true` must not pass.
  const falsePositive = await verifyWith({ status: 'failed', passed: true, score: 0.1 });
  assert.equal(falsePositive.status, 'failed');
  assert.equal(falsePositive.passed, false);
  assert.ok(falsePositive.flags.includes('liveness_engine_inconsistent_verdict'));

  // A payload with only `passed` keeps the legacy mapping (no false flag).
  const passedOnly = await verifyWith({ passed: true, score: 0.05 });
  assert.equal(passedOnly.status, 'verified');
  assert.equal(passedOnly.passed, true);
  assert.equal(passedOnly.flags.includes('liveness_engine_inconsistent_verdict'), false);

  // The service boundary keeps status/passed consistent for any engine, so the
  // endpoint can never mark `verified` while returning `passed:false`.
  const inconsistentEngine: LivenessEngine = {
    name: 'inconsistent',
    isConfigured: () => true,
    issue: async (input, options) => new ChallengeLivenessEngine().issue(input, options),
    verify: async () => ({ passed: false, status: 'verified', score: 0.1, flags: [], engine: 'inconsistent' }),
  };
  const service = serviceWith(inconsistentEngine);
  const issued = await service.issue(OWNER);
  const verdict = await service.verify({ ...OWNER, sessionId: issued.sessionId, signals: { blinkDetected: true } });
  assert.equal(verdict.status, 'verified');
  assert.equal(verdict.passed, true);
});
