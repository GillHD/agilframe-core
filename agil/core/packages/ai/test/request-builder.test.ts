import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { aiAgentRequestSchema } from '@agil/protocol';
import type { TranscriptSegment } from '@agil/protocol';
import { buildAiAgentRequest } from '../src/index.js';

function seg(index: number): TranscriptSegment {
  return {
    id: `s${index}`,
    participantId: `p${index}`,
    participantName: 'Анна',
    text: `Реплика номер ${index} про интеграцию.`,
    start: index,
    end: index + 1,
    isFinal: true,
    ts: 1_700_000_000_000 + index,
  };
}

test('builds a schema-valid AiAgentRequest with defaults', () => {
  const payload = buildAiAgentRequest({
    tenantId: 'tenant-1',
    roomId: 'room-1',
    roomName: 'Планерка',
    locale: 'ru',
    participants: [
      { id: 'p1', name: 'Анна', role: 'host', country: 'RU', verified: true },
      { id: 'p2', name: 'Борис' },
    ],
    segments: [seg(0), seg(1)],
    chat: [{ fromName: 'Анна', text: 'Привет', ts: 1 }],
    policy: [{ id: 'pii.email', name: 'Email', type: 'pii', pattern: 'email', severity: 'warn', action: 'flag', enabled: true }],
    meetingContext: { startedAt: 1, hostName: 'Анна' },
  });

  assert.equal(aiAgentRequestSchema.safeParse(payload).success, true);
  assert.equal(payload.tenantId, 'tenant-1');
  assert.equal(payload.roomId, 'room-1');
  assert.equal(payload.roomName, 'Планерка');
  assert.equal(payload.locale, 'ru');
  assert.ok(payload.requestId.length > 0);
  assert.equal(payload.participants.length, 2);
  assert.equal(payload.participants[1]!.role, 'guest');
  assert.equal(payload.participants[1]!.verified, false);
  assert.equal(payload.participants[0]!.country, 'RU');
  assert.equal(payload.segments.length, 2);
  assert.equal(payload.chat.length, 1);
  assert.ok(payload.chat[0]!.id.length > 0);
  assert.equal(payload.policy.rules.length, 1);
  assert.equal(payload.policy.policyText, '');
  assert.equal(payload.meetingContext?.hostName, 'Анна');
});

test('minimal input is valid and fills protocol defaults', () => {
  const payload = buildAiAgentRequest({ tenantId: 't', roomId: 'r' });
  assert.equal(aiAgentRequestSchema.safeParse(payload).success, true);
  assert.equal(payload.roomName, '');
  assert.equal(payload.locale, 'ru');
  assert.deepEqual(payload.participants, []);
  assert.deepEqual(payload.segments, []);
  assert.deepEqual(payload.chat, []);
  assert.deepEqual(payload.policy, { rules: [], policyText: '' });
  assert.equal(payload.meetingContext, undefined);
});

test('accepts { rules, policyText } policy and an explicit requestId', () => {
  const payload = buildAiAgentRequest({
    tenantId: 't',
    roomId: 'r',
    requestId: 'req-42',
    locale: 'en',
    policy: { rules: [], policyText: 'Corporate policy' },
  });
  assert.equal(payload.requestId, 'req-42');
  assert.equal(payload.locale, 'en');
  assert.deepEqual(payload.policy, { rules: [], policyText: 'Corporate policy' });
});

test('throws ZodError when there are more than 200 segments', () => {
  const segments = Array.from({ length: 201 }, (_, index) => seg(index));
  assert.throws(
    () => buildAiAgentRequest({ tenantId: 't', roomId: 'r', segments }),
    (error: unknown) => {
      assert.ok(error instanceof ZodError);
      assert.match(error.message, /200/);
      return true;
    },
  );
});

test('throws ZodError on over-long room name and participant name', () => {
  assert.throws(
    () => buildAiAgentRequest({ tenantId: 't', roomId: 'r', roomName: 'x'.repeat(121) }),
    ZodError,
  );
  assert.throws(
    () =>
      buildAiAgentRequest({
        tenantId: 't',
        roomId: 'r',
        participants: [{ id: 'p1', name: 'x'.repeat(121) }],
      }),
    ZodError,
  );
});
