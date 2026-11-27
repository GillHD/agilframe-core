/**
 * SIEM audit export (optional, off by default).
 *
 * Every AuditLog append is enqueued for tenants with `integrations.siem.enabled`
 * and POSTed to the company's collector as JSON or CEF. Optional HMAC signature
 * (`x-agil-signature`, hex HMAC-SHA256 of the raw body) uses the secret from the
 * env variable named in `secretEnv`. Delivery is fail-open: the audit trail and
 * API never block or fail because the SIEM endpoint is down; the last outcome is
 * exposed via `/v1/admin/siem/status`. Raw IPs are never sent (only `ipHash`).
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { AuditEntry, TenantConfig } from '@agil/protocol';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import { resolveTenantSecret } from './secret-env.js';

export interface SiemDelivery {
  at: number;
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  attempts: number;
  error?: string;
}

export interface SiemStatus {
  configured: boolean;
  enabled: boolean;
  format: 'json' | 'cef';
  queue: number;
  lastError: string | null;
  lastDelivery: SiemDelivery | null;
}

export interface SiemTestResult {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  detail: string;
}

interface SiemTenantState {
  lastError: string | null;
  lastDelivery: SiemDelivery | null;
}

const MAX_QUEUE = 1000;
const SEVERITY_NUMBER: Record<string, number> = { info: 3, warn: 6, critical: 9 };

function escapeCef(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n').replace(/\r/g, '');
}

function escapeCefExtension(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\n/g, '\\n');
}

export class SiemDispatcher {
  private readonly queue: AuditEntry[] = [];
  private readonly states = new Map<string, SiemTenantState>();
  private draining = false;

  constructor(
    private readonly env: Env,
    private readonly getConfig: (tenantId: string) => TenantConfig | null,
    private readonly logger: Logger,
  ) {}

  private state(tenantId: string): SiemTenantState {
    let state = this.states.get(tenantId);
    if (!state) {
      state = { lastError: null, lastDelivery: null };
      this.states.set(tenantId, state);
    }
    return state;
  }

  private tenantConfig(tenantId: string): TenantConfig | null {
    try {
      return this.getConfig(tenantId);
    } catch {
      return null;
    }
  }

  /** Fail-open enqueue: never throws, never blocks the caller. */
  ingest(entry: AuditEntry): void {
    try {
      if (!entry.tenantId) return;
      const config = this.tenantConfig(entry.tenantId);
      const siem = config?.integrations.siem;
      if (!siem || !siem.enabled || !siem.url.trim()) return;
      if (siem.events.length > 0 && !siem.events.includes(entry.type)) return;
      if (this.queue.length >= MAX_QUEUE) this.queue.shift();
      this.queue.push(entry);
      void this.drain();
    } catch {
      /* fail-open */
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        try {
          await this.dispatch(entry);
        } catch {
          /* dispatch never throws; belt-and-braces */
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private buildJson(entry: AuditEntry, deliveryId: string, tenantId: string): string {
    return JSON.stringify({
      deliveryId,
      ts: entry.ts,
      tenantId,
      event: entry.type,
      severity: entry.severity,
      message: entry.message,
      details: entry.details ?? {},
      ipHash: entry.ipHash ?? null,
    });
  }

  private buildCef(entry: AuditEntry, deliveryId: string, tenantId: string): string {
    const severity = SEVERITY_NUMBER[entry.severity] ?? 3;
    const header = `CEF:0|AGIL|Calls|0.1|${escapeCef(entry.type)}|${escapeCef(entry.message.slice(0, 512))}|${severity}|`;
    const extension = [
      `deliveryId=${escapeCefExtension(deliveryId)}`,
      `tenantId=${escapeCefExtension(tenantId)}`,
      `event=${escapeCefExtension(entry.type)}`,
      `severity=${escapeCefExtension(entry.severity)}`,
      `rt=${entry.ts}`,
      ...(entry.ipHash ? [`src=${entry.ipHash}`] : []),
      `msg=${escapeCefExtension(entry.message.slice(0, 512))}`,
    ].join(' ');
    return header + extension;
  }

  private signature(rawBody: string, secretEnv: string): string | undefined {
    if (!secretEnv) return undefined;
    // Snapshot + allowlist only: a tenant naming `AGIL_TOKEN_SECRET` as the SIEM
    // secret must not turn the audit exporter into an HMAC oracle for a
    // server-wide secret.
    const secret = resolveTenantSecret(this.env, secretEnv, 'siem').value;
    if (!secret) return undefined;
    return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  }

  private async post(
    url: string,
    body: string,
    config: TenantConfig['integrations']['siem'],
  ): Promise<{ statusCode?: number; error?: string }> {
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Math.min(30_000, config.timeoutMs));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Some fetch implementations resolve slowly on abort; race with an explicit
    // timeout promise so a hanging SIEM collector can never block the queue.
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('timeout')), timeoutMs + 100);
    });
    try {
      const signature = this.signature(body, config.secretEnv);
      const response = await Promise.race([
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': config.format === 'cef' ? 'text/plain; charset=utf-8' : 'application/json',
            ...(signature ? { 'x-agil-signature': signature } : {}),
            'x-agil-format': config.format,
          },
          body,
          signal: controller.signal,
          redirect: 'error',
        }),
        timeoutPromise,
      ]);
      return { statusCode: response.status, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
    } catch (error) {
      const message = (error as Error).name === 'AbortError' || (error as Error).message === 'timeout' ? 'timeout' : (error as Error).message;
      return { error: message };
    } finally {
      clearTimeout(timer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  private async dispatch(entry: AuditEntry, options: { ignoreEventsFilter?: boolean } = {}): Promise<SiemDelivery> {
    const tenantId = entry.tenantId ?? this.env.defaultTenantId;
    const config = this.tenantConfig(tenantId);
    const siem = config?.integrations.siem;
    if (!siem || !siem.enabled || !siem.url.trim()) {
      return { at: Date.now(), ok: false, latencyMs: 0, attempts: 0, error: 'SIEM disabled' };
    }
    if (!options.ignoreEventsFilter && siem.events.length > 0 && !siem.events.includes(entry.type)) {
      return { at: Date.now(), ok: false, latencyMs: 0, attempts: 0, error: 'event filtered' };
    }
    const deliveryId = randomUUID();
    const body = siem.format === 'cef' ? this.buildCef(entry, deliveryId, tenantId) : this.buildJson(entry, deliveryId, tenantId);
    const retries = Math.max(0, Math.min(10, siem.retries));
    const attemptsMax = retries + 1;
    let last: { statusCode?: number; error?: string } = { error: 'not attempted' };
    let attempts = 0;
    const started = Date.now();
    for (let attempt = 1; attempt <= attemptsMax; attempt += 1) {
      attempts = attempt;
      last = await this.post(siem.url, body, siem);
      if (last.statusCode && last.statusCode >= 200 && last.statusCode < 300) {
        const delivery: SiemDelivery = {
          at: Date.now(),
          ok: true,
          statusCode: last.statusCode,
          latencyMs: Date.now() - started,
          attempts,
        };
        const state = this.state(tenantId);
        state.lastDelivery = delivery;
        state.lastError = null;
        return delivery;
      }
      if (attempt < attemptsMax) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 200 * 2 ** (attempt - 1))));
    }
    const delivery: SiemDelivery = {
      at: Date.now(),
      ok: false,
      ...(last.statusCode !== undefined ? { statusCode: last.statusCode } : {}),
      latencyMs: Date.now() - started,
      attempts,
      error: last.error ?? 'delivery failed',
    };
    const state = this.state(tenantId);
    state.lastDelivery = delivery;
    state.lastError = delivery.error ?? 'delivery failed';
    // Never log the payload; the error is enough for diagnostics.
    this.logger.warn('SIEM delivery failed', { tenantId, error: delivery.error });
    return delivery;
  }

  status(tenantId: string): SiemStatus {
    const config = this.tenantConfig(tenantId);
    const siem = config?.integrations.siem;
    const state = this.state(tenantId);
    return {
      configured: Boolean(siem?.url && siem?.url.trim()),
      enabled: Boolean(siem?.enabled && siem?.url && siem.url.trim()),
      format: siem?.format ?? 'json',
      queue: this.queue.length,
      lastError: state.lastError,
      lastDelivery: state.lastDelivery,
    };
  }

  /** Sends a synthetic test event synchronously (used by the admin test endpoint). */
  async test(tenantId: string): Promise<SiemTestResult | null> {
    const config = this.tenantConfig(tenantId);
    const siem = config?.integrations.siem;
    if (!siem || !siem.enabled || !siem.url.trim()) return null;
    const entry: AuditEntry = {
      id: randomUUID(),
      ts: Date.now(),
      type: 'admin.action',
      severity: 'info',
      tenantId,
      message: 'SIEM test delivery',
      details: { kind: 'siem.test' },
    };
    const delivery = await this.dispatch(entry, { ignoreEventsFilter: true });
    return {
      ok: delivery.ok,
      ...(delivery.statusCode !== undefined ? { statusCode: delivery.statusCode } : {}),
      latencyMs: delivery.latencyMs,
      detail: delivery.ok ? 'test event delivered' : delivery.error ?? 'delivery failed',
    };
  }
}
