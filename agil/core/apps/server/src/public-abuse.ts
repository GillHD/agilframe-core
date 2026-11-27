import type { PublicAbuseMode } from '@agil/protocol';
import { createRateLimiter, type RateLimitDecision } from '@agil/security';
import { safeAudit } from './http.js';
import type { Logger } from './logger.js';
import type { Services } from './services.js';

type PublicAction = 'room.create' | 'room.join';
type Scope = 'source' | 'organization' | 'installation_source';
type ActiveMode = Exclude<PublicAbuseMode, 'off'>;

const WINDOW_MS = 60_000;
const limits = (max: number, maxKeys: number) => createRateLimiter({ windowMs: WINDOW_MS, max, maxKeys });

interface Attempt {
  mode: PublicAbuseMode;
  action: PublicAction;
  tenantId: string;
  ipHash: string;
}

interface PublicAbuseDecision {
  allowed: boolean;
  retryAfterMs: number;
  threshold?: { mode: ActiveMode; scope: Scope; audit: boolean };
}

export function createPublicAbuseGuard() {
  const budgets = {
    'room.create': { source: limits(5, 20_000), organization: limits(100, 10_000) },
    'room.join': { source: limits(120, 20_000), organization: limits(1_000, 10_000) },
  };
  const installationCreateSource = limits(20, 20_000);
  const auditSamples = limits(1, 10_000);

  function rejection(
    mode: ActiveMode,
    action: PublicAction,
    tenantId: string,
    scope: Scope,
    decision: RateLimitDecision,
  ) {
    const audit = auditSamples.check(`${mode}:${action}:${tenantId}:${scope}`).allowed;
    return {
      allowed: mode === 'observe',
      retryAfterMs: decision.retryAfterMs,
      threshold: { mode, scope, audit },
    };
  }

  return {
    check({ mode, action, tenantId, ipHash }: Attempt): PublicAbuseDecision {
      if (mode === 'off') return { allowed: true, retryAfterMs: 0 };

      const orgKey = `${mode}:${tenantId}`;
      const budget = budgets[action];
      const source = budget.source.check(`${orgKey}:${ipHash}`);
      if (!source.allowed) return rejection(mode, action, tenantId, 'source', source);

      if (action === 'room.create') {
        const installation = installationCreateSource.check(`${mode}:${ipHash}`);
        if (!installation.allowed) return rejection(mode, action, tenantId, 'installation_source', installation);
      }

      const organization = budget.organization.check(orgKey);
      if (!organization.allowed) return rejection(mode, action, tenantId, 'organization', organization);

      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

export type PublicAbuseGuard = ReturnType<typeof createPublicAbuseGuard>;
export const PUBLIC_ABUSE_MESSAGE = 'Too many anonymous requests; try again later';

export function checkPublicAbuse(services: Pick<Services, 'publicAbuse' | 'audit'>, logger: Logger, attempt: Attempt) {
  const decision = services.publicAbuse.check(attempt);
  if (decision.threshold?.audit) {
    safeAudit(logger, services.audit, {
      type: 'public_abuse.threshold',
      severity: decision.allowed ? 'info' : 'warn',
      tenantId: attempt.tenantId,
      message: decision.allowed ? 'Anonymous request limit observed' : 'Anonymous request limit exceeded',
      details: { action: attempt.action, scope: decision.threshold.scope, mode: decision.threshold.mode },
    });
  }
  return decision;
}
