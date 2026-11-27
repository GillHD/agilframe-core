/**
 * Builder for `AiAgentRequest` (contract §13, `compliance.ts`).
 *
 * The payload is always validated with `aiAgentRequestSchema` before it leaves
 * the process: invalid input (too many segments, over-long names, etc.) throws
 * a `ZodError` instead of sending a malformed webhook.
 */
import { randomUUID } from 'node:crypto';
import { aiAgentRequestSchema } from '@agil/protocol';
import type { AiAgentRequest, CompliancePolicyRule, TranscriptSegment } from '@agil/protocol';

export type AiAgentParticipantRole = 'host' | 'moderator' | 'guest';

export interface AiAgentParticipantInput {
  id: string;
  name: string;
  /** Default `guest`. */
  role?: AiAgentParticipantRole;
  /** ISO 3166-1 alpha-2, e.g. `RU`. */
  country?: string;
  /** Default `false`. */
  verified?: boolean;
}

export interface AiAgentChatInput {
  /** Defaults to a random UUID. */
  id?: string;
  fromName: string;
  text: string;
  ts: number;
}

export interface AiAgentPolicyInput {
  /** Default `[]`. */
  rules?: CompliancePolicyRule[];
  /** Default `''`. */
  policyText?: string;
}

export interface AiAgentMeetingContextInput {
  startedAt?: number;
  hostName?: string;
}

export interface BuildAiAgentRequestInput {
  tenantId: string;
  roomId: string;
  /** Default `''`. */
  roomName?: string;
  /** Default `'ru'`. */
  locale?: 'ru' | 'en';
  /** Default `[]`. */
  participants?: AiAgentParticipantInput[];
  /** Default `[]`; at most 200 per schema. */
  segments?: TranscriptSegment[];
  /** Default `[]`; at most 200 per schema. */
  chat?: AiAgentChatInput[];
  /** Shorthand array or `{ rules, policyText }`; default empty. */
  policy?: CompliancePolicyRule[] | AiAgentPolicyInput;
  meetingContext?: AiAgentMeetingContextInput;
  /** Defaults to `crypto.randomUUID()`. */
  requestId?: string;
}

function normalizePolicy(policy: BuildAiAgentRequestInput['policy']): { rules: CompliancePolicyRule[]; policyText: string } {
  if (!policy) return { rules: [], policyText: '' };
  if (Array.isArray(policy)) {
    return { rules: [...(policy as CompliancePolicyRule[])], policyText: '' };
  }
  return {
    rules: policy.rules ? [...policy.rules] : [],
    policyText: policy.policyText ?? '',
  };
}

/**
 * Assemble and validate a webhook payload for the corporate AI agent.
 *
 * @throws zod.ZodError when the assembled payload violates `aiAgentRequestSchema`.
 */
export function buildAiAgentRequest(input: BuildAiAgentRequestInput): AiAgentRequest {
  const policy = normalizePolicy(input.policy);
  const payload: Record<string, unknown> = {
    requestId: input.requestId ?? randomUUID(),
    tenantId: input.tenantId,
    roomId: input.roomId,
    roomName: input.roomName ?? '',
    locale: input.locale ?? 'ru',
    participants: (input.participants ?? []).map((participant) => {
      const mapped: Record<string, unknown> = {
        id: participant.id,
        name: participant.name,
        role: participant.role ?? 'guest',
        verified: participant.verified ?? false,
      };
      if (participant.country) mapped.country = participant.country;
      return mapped;
    }),
    segments: [...(input.segments ?? [])],
    chat: (input.chat ?? []).map((message) => ({
      id: message.id ?? randomUUID(),
      fromName: message.fromName,
      text: message.text,
      ts: message.ts,
    })),
    policy,
  };

  if (input.meetingContext) {
    payload.meetingContext = { ...input.meetingContext };
  }

  return aiAgentRequestSchema.parse(payload);
}
