/**
 * Billing / quota tools (backend contract: /v1/admin/billing/*).
 *
 * Read-only: monthly usage counters and the current tenant plan. There are no
 * payment tools and no card data anywhere in this API.
 */
import { z } from 'zod';
import { ApiError, ServerUnavailableError } from '../http-client.js';
import { defineTool, jsonOutcome, ToolError, type AnyToolSpec } from '../tool-kit.js';

const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM (UTC)')
  .optional()
  .describe('UTC calendar month, e.g. 2026-11 (default: current month)');

function billingFailure(error: unknown, action: string): never {
  if (error instanceof ServerUnavailableError) {
    throw new ToolError(
      `${action}: сервер AgilFrame недоступен (${error.reason}).`,
      'Проверьте AGIL_SERVER_URL и доступность сервера; billing — /v1/admin/billing/*.',
    );
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      throw new ToolError(
        `${action}: нет прав на billing (${error.status}).`,
        'Нужен административный ключ тенанта (AGIL_API_KEY, заголовок x-api-key).',
      );
    }
    if (error.status === 400) {
      throw new ToolError(`${action}: некорректный месяц (400).`, 'Передайте month в формате YYYY-MM (UTC), например 2026-11.');
    }
    if (error.status === 404) {
      throw new ToolError(`${action}: endpoint billing недоступен (404).`, 'Обновите сервер AgilFrame: нужны /v1/admin/billing/usage и /v1/admin/billing/plan.');
    }
    throw new ToolError(`${action}: сервер вернул ошибку ${error.status}.`, 'Проверьте доступность admin API и права ключа.');
  }
  throw error;
}

function billingUsageOutput(payload: unknown): Record<string, unknown> {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const billing = (raw.billing ?? {}) as Record<string, unknown>;
  return {
    tenantId: raw.tenantId,
    month: raw.month,
    plan: billing.plan,
    enforcementEnabled: billing.enabled,
    overagePolicy: billing.overagePolicy,
    quota: raw.quota,
    usage: raw.usage,
    live: raw.live,
    months: raw.months,
    warnings: raw.warnings,
  };
}

function billingStatusOutput(payload: unknown): Record<string, unknown> {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const billing = (raw.billing ?? {}) as Record<string, unknown>;
  return {
    tenantId: raw.tenantId,
    plan: billing.plan,
    enforcementEnabled: billing.enabled,
    includedMinutes: billing.includedMinutes,
    maxParticipants: billing.maxParticipants,
    maxRooms: billing.maxRooms,
    overagePolicy: billing.overagePolicy,
    plans: raw.plans,
    usage: raw.usage,
  };
}

export function billingToolSpecs(): AnyToolSpec[] {
  return [
    defineTool({
      name: 'billing_usage',
      title: 'Metered usage for the tenant',
      description:
        'Read monthly usage counters via GET /v1/admin/billing/usage: room minutes, rooms created, participant joins, ' +
        'peak concurrent participants, recordings and recording minutes, plus live (not yet settled) minutes and current ' +
        'quota warnings. Optional month=YYYY-MM returns a past UTC month. Read-only; no card data is ever accepted or returned.',
      online: true,
      inputSchema: z.object({ month: monthSchema }),
      handler: async (args, ctx) => {
        const query = args.month ? `?month=${encodeURIComponent(args.month)}` : '';
        try {
          const payload = await ctx.client.get<unknown>(`/v1/admin/billing/usage${query}`);
          return jsonOutcome(billingUsageOutput(payload));
        } catch (error) {
          billingFailure(error, 'Использование billing');
        }
      },
    }),

    defineTool({
      name: 'billing_status',
      title: 'Billing plan and quota status',
      description:
        'Read the current tenant billing plan via GET /v1/admin/billing/plan: plan name, enforcement flag, included minutes, ' +
        'max participants/rooms, overage policy, plan catalog and a usage summary. Read-only; shows why create/join may be ' +
        'blocked by quota (402/429/quota_exceeded). No card data.',
      online: true,
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        try {
          const payload = await ctx.client.get<unknown>('/v1/admin/billing/plan');
          return jsonOutcome(billingStatusOutput(payload));
        } catch (error) {
          billingFailure(error, 'Статус billing');
        }
      },
    }),
  ];
}
