/**
 * Resolution of tenant-config secret references against the **startup
 * snapshot** of server-owned env namespaces (see `env.parseTenantSecretEnv`).
 *
 * Two guarantees:
 *  1. a tenant config may only name an allowlisted namespace
 *     (`AGIL_INTEGRATION_*` / `AGIL_WEBHOOK_*` / `AGIL_SIEM_*` / `AGIL_SFU_*` /
 *     `AGIL_TURN_*`), checked again here at use time; and
 *  2. even an allowlisted name is read from `env.tenantSecretEnv`, never from
 *     `process.env`, so a config cannot observe a variable set after startup.
 *
 * `validateTenantSecretEnvRefs` feeds the same rules into config writes
 * (`TenantStore.validateConfig`, room overrides) so a bad name is rejected with
 * `400 validation_failed` instead of being persisted.
 */
import {
  describeTenantSecretEnv,
  isAllowedTenantSecretEnv,
  type TenantSecretEnvKind,
} from '@agil/protocol';
import type { Env } from './env.js';

/** The env slice needed to resolve a reference (kept structural for tests). */
export type TenantSecretSnapshot = Pick<Env, 'tenantSecretEnv'>;

export interface TenantSecretResolution {
  /** True when the reference is empty or inside the server-owned namespace. */
  allowed: boolean;
  /** Value from the startup snapshot (undefined when unset or not allowed). */
  value: string | undefined;
  /** Trimmed reference as written in the config ('' when unset). */
  ref: string;
}

/** Resolves a tenant-config secret reference from the startup snapshot only. */
export function resolveTenantSecret(
  env: TenantSecretSnapshot,
  name: string | undefined | null,
  kind: TenantSecretEnvKind,
): TenantSecretResolution {
  const ref = typeof name === 'string' ? name.trim() : '';
  if (!ref) return { allowed: true, value: undefined, ref };
  if (!isAllowedTenantSecretEnv(ref, kind)) return { allowed: false, value: undefined, ref };
  const value = env.tenantSecretEnv[ref];
  return { allowed: true, value: typeof value === 'string' && value.length > 0 ? value : undefined, ref };
}

export interface ConfigIssue {
  path: string;
  message: string;
}

/**
 * Structural view of the secret-reference fields in a (possibly partial)
 * tenant config; the cast in {@link validateTenantSecretEnvRefs} keeps zod's
 * deep-partial type out of this module.
 */
interface SecretEnvRefsConfig {
  session?: {
    aiAgent?: { apiKeyEnv?: string | null } | null;
    knowledgeAgent?: { apiKeyEnv?: string | null } | null;
    inCallAgent?: { apiKeyEnv?: string | null } | null;
  } | null;
  providers?: Record<string, { apiKeyEnv?: string | null } | undefined> | null;
  integrations?: {
    webhooks?: Array<{ secretEnv?: string | null } | undefined> | null;
    siem?: { secretEnv?: string | null } | null;
  } | null;
  scale?: {
    sfu?: { apiKeyEnv?: string | null; apiSecretEnv?: string | null } | null;
    turn?: Array<{ credentialEnv?: string | null } | undefined> | null;
  } | null;
}

/**
 * Every tenant-controlled secret reference in a config (or config patch).
 * Returns validation issues for names outside the server-owned namespace —
 * never for an allowlisted-but-unset name (the value simply stays unresolved).
 */
export function validateTenantSecretEnvRefs(config: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const root = (config && typeof config === 'object' ? config : {}) as SecretEnvRefsConfig;
  const check = (raw: unknown, path: string, kind: TenantSecretEnvKind): void => {
    if (raw === undefined || raw === null) return;
    if (typeof raw !== 'string') {
      issues.push({ path, message: 'Must be a string naming a server environment variable' });
      return;
    }
    if (!isAllowedTenantSecretEnv(raw, kind)) {
      issues.push({ path, message: `Must be empty or ${describeTenantSecretEnv(kind)}` });
    }
  };

  check(root.session?.aiAgent?.apiKeyEnv, 'session.aiAgent.apiKeyEnv', 'integration');
  check(root.session?.knowledgeAgent?.apiKeyEnv, 'session.knowledgeAgent.apiKeyEnv', 'integration');
  check(root.session?.inCallAgent?.apiKeyEnv, 'session.inCallAgent.apiKeyEnv', 'integration');
  for (const [slot, value] of Object.entries(root.providers ?? {})) {
    check(value?.apiKeyEnv, `providers.${slot}.apiKeyEnv`, 'integration');
  }
  (root.integrations?.webhooks ?? []).forEach((webhook, index) => {
    check(webhook?.secretEnv, `integrations.webhooks.${index}.secretEnv`, 'webhook');
  });
  check(root.integrations?.siem?.secretEnv, 'integrations.siem.secretEnv', 'siem');
  check(root.scale?.sfu?.apiKeyEnv, 'scale.sfu.apiKeyEnv', 'sfu');
  check(root.scale?.sfu?.apiSecretEnv, 'scale.sfu.apiSecretEnv', 'sfu');
  (root.scale?.turn ?? []).forEach((server, index) => {
    check(server?.credentialEnv, `scale.turn.${index}.credentialEnv`, 'turn');
  });
  return issues;
}
