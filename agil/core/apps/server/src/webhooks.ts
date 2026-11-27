/**
 * Outbound webhooks: signed JSON deliveries to the company's systems with
 * timeouts, exponential backoff and a local queue for unfinished deliveries.
 *
 * The server never stores webhook secrets: each endpoint references an
 * environment variable (`secretEnv`, restricted to `AGIL_WEBHOOK_*`), resolved
 * at delivery time from the startup snapshot — never `process.env` by the
 * tenant-supplied name. Events are fire-and-forget (a failing webhook must never
 * block a call), but every final outcome is recorded and audited
 * (`webhook.delivered` / `webhook.failed`).
 * The queue belongs to one Core data directory. Delivery is at least once;
 * receivers should deduplicate by `x-agil-delivery`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildWebhookRequest } from '@agil/security';
import { webhookPayloadSchema } from '@agil/protocol';
import { z } from 'zod';
import type {
  AuditEntry,
  TenantConfig,
  WebhookDeliveryRecord,
  WebhookEndpointConfig,
  WebhookEventType,
  WebhookPayload,
} from '@agil/protocol';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import { resolveTenantSecret } from './secret-env.js';

export const MAX_DELIVERY_LOG = 200;
const MAX_QUEUED_DELIVERIES = 1000;
const MAX_DELIVERY_BYTES = 256 * 1024;
const DELIVERY_CONCURRENCY = 8;

const queuedDeliverySchema = z.object({
  version: z.literal(1),
  endpointId: z.string().min(1).max(64),
  recipientHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: webhookPayloadSchema,
  // A crash can leave an attempt unacknowledged. Only observed failures count.
  failures: z.number().int().min(0).max(10),
  retryAfter: z.number().int().nonnegative(),
});
type QueuedDelivery = z.infer<typeof queuedDeliverySchema>;

export interface WebhookDispatcherOptions {
  env: Env;
  logger: Logger;
  getConfig(tenantId: string): TenantConfig;
  /** Look up a pending delivery's tenant without recreating a deleted tenant. */
  getConfigIfExists?: (tenantId: string) => TenantConfig | null;
  /** Audit sink (already bound to the tenant-aware AuditLog). */
  audit?: (entry: Omit<AuditEntry, 'id' | 'ts'> & { ip?: string }) => void;
}

export interface DeliveryOutcome {
  status: 'delivered' | 'failed';
  statusCode?: number;
  error?: string;
  attempts: number;
}

export interface WebhookTestResult {
  endpointId: string;
  status: 'delivered' | 'failed';
  statusCode?: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return delay(ms, undefined, { ref: false });
}

const recipientHash = (url: string): string => createHash('sha256').update(url).digest('hex');

function deliveryId(tenantId: string, type: WebhookEventType, endpointId: string, eventId?: string): string {
  if (eventId === undefined) return randomUUID();
  const hex = createHash('sha256').update(JSON.stringify([tenantId, type, endpointId, eventId])).digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class WebhookDispatcher {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly getConfig: (tenantId: string) => TenantConfig | null;
  private readonly audit?: WebhookDispatcherOptions['audit'];
  private readonly queueDir: string;
  private readonly queued = new Map<string, QueuedDelivery>();
  private readonly deliveries: Array<{ tenantId: string; record: WebhookDeliveryRecord }> = [];
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private closing = false;

  constructor(options: WebhookDispatcherOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.getConfig = options.getConfigIfExists ?? options.getConfig;
    this.audit = options.audit;
    this.queueDir = join(this.env.dataDir, 'webhook-queue');
    this.recover();
    this.pump();
  }

  /** Most recent deliveries, newest first. */
  list(limit = 50, tenantId?: string): WebhookDeliveryRecord[] {
    return this.deliveries.filter((entry) => tenantId === undefined || entry.tenantId === tenantId)
      .slice(0, Math.max(1, limit)).map(({ record }) => record);
  }

  /** Webhook endpoints configured for a tenant. */
  endpointsFor(tenantId: string): WebhookEndpointConfig[] {
    try {
      return this.getConfig(tenantId)?.integrations.webhooks ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Publishes an event to every endpoint of the tenant that subscribed to it.
   * Counts durably queued deliveries, including a repeat of a still-pending
   * logical event. The recipient handles repeats after acknowledgement.
   */
  emit(
    type: WebhookEventType,
    context: { tenantId: string; roomId?: string },
    data: Record<string, unknown> = {},
    options?: { eventId: string },
  ): number {
    if (this.closing) return 0;
    const endpoints = this.endpointsFor(context.tenantId).filter((endpoint) => endpoint.enabled && endpoint.events.includes(type));
    let accepted = 0;
    for (const endpoint of endpoints) {
      const id = deliveryId(context.tenantId, type, endpoint.id, options?.eventId);
      if (this.queued.has(id) || this.inflight.has(id)) {
        accepted++;
        continue;
      }
      if (this.queued.size + this.inflight.size >= MAX_QUEUED_DELIVERIES) {
        this.logger.warn('webhook queue is full', { tenantId: context.tenantId, endpointId: endpoint.id, event: type });
        break;
      }
      const payload: WebhookPayload = {
        id,
        type,
        ts: Date.now(),
        tenantId: context.tenantId,
        ...(context.roomId ? { roomId: context.roomId } : {}),
        data,
      };
      const pending: QueuedDelivery = {
        version: 1,
        endpointId: endpoint.id,
        recipientHash: recipientHash(endpoint.url),
        payload,
        failures: 0,
        retryAfter: 0,
      };
      if (!this.persist(pending)) continue;
      this.queued.set(payload.id, pending);
      accepted++;
    }
    this.pump();
    return accepted;
  }

  private pump(): void {
    for (const [id, pending] of this.queued) {
      if (this.shutdown.signal.aborted || this.inflight.size >= DELIVERY_CONCURRENCY) break;
      this.queued.delete(id);
      const job = this.deliverQueued(pending)
        .catch((error: unknown) => {
          if (this.shutdown.signal.aborted) return;
          this.logger.warn('webhook delivery interrupted', { endpointId: pending.endpointId, error: (error as Error).name });
        })
        .finally(() => {
          this.inflight.delete(id);
          this.pump();
        });
      this.inflight.set(id, job);
    }
  }

  private async deliverQueued(pending: QueuedDelivery): Promise<void> {
    const { payload, endpointId } = pending;
    const record = this.remember(payload.tenantId, {
      id: payload.id, endpointId, type: payload.type, status: 'retrying', attempts: pending.failures, ts: payload.ts,
    });
    if (pending.retryAfter > Date.now()) {
      await delay(pending.retryAfter - Date.now(), undefined, { ref: false, signal: this.shutdown.signal });
    }
    const endpoint = this.queuedEndpoint(pending);
    if (endpoint) {
      await this.deliver(endpoint, payload, record, pending);
    } else {
      this.finish(record, { status: 'failed', attempts: pending.failures, error: 'Webhook endpoint is no longer subscribed or changed recipient' }, payload.tenantId);
    }
    this.remove(pending);
  }

  private queuedEndpoint(pending: QueuedDelivery): WebhookEndpointConfig | undefined {
    return this.endpointsFor(pending.payload.tenantId).find((endpoint) => endpoint.id === pending.endpointId
      && endpoint.enabled && endpoint.events.includes(pending.payload.type) && recipientHash(endpoint.url) === pending.recipientHash);
  }

  private filePath(id: string): string {
    return join(this.queueDir, `${id}.json`);
  }

  private persist(pending: QueuedDelivery): boolean {
    const file = this.filePath(pending.payload.id);
    const tmp = `${file}.tmp`;
    try {
      const body = JSON.stringify(pending);
      if (Buffer.byteLength(body) > MAX_DELIVERY_BYTES) throw new Error('delivery exceeds size limit');
      // Keep the exact accepted data snapshot even if the caller mutates it.
      if (pending.failures === 0) pending.payload = queuedDeliverySchema.parse(JSON.parse(body)).payload;
      mkdirSync(this.queueDir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flush: true });
      renameSync(tmp, file);
      return true;
    } catch {
      this.logger.warn('could not save webhook queue entry', { endpointId: pending.endpointId, deliveryId: pending.payload.id });
      try { rmSync(tmp, { force: true }); } catch { /* ignored during recovery */ }
      return false;
    }
  }

  private remove(pending: QueuedDelivery): void {
    try {
      rmSync(this.filePath(pending.payload.id), { force: true });
    } catch {
      this.logger.warn('could not remove webhook queue entry', { endpointId: pending.endpointId, deliveryId: pending.payload.id });
    }
  }

  private recover(): void {
    let files;
    try {
      files = readdirSync(this.queueDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('could not read webhook queue');
      return;
    }
    for (const file of files) {
      if (!file.isFile() || !/^[0-9a-f-]{36}\.json(?:\.tmp)?$/.test(file.name)) continue;
      const path = join(this.queueDir, file.name);
      try {
        if (file.name.endsWith('.tmp')) {
          rmSync(path, { force: true });
          continue;
        }
        const parsed = queuedDeliverySchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        if (!parsed.success || `${parsed.data.payload.id}.json` !== file.name) throw new Error('invalid entry');
        this.queued.set(parsed.data.payload.id, parsed.data);
      } catch {
        this.logger.warn('could not recover webhook queue entry', { file: file.name });
      }
    }
  }

  /** Delivers one payload with retries; resolves with the final outcome. */
  async deliver(
    endpoint: WebhookEndpointConfig,
    payload: WebhookPayload,
    record?: WebhookDeliveryRecord,
    pending?: QueuedDelivery,
  ): Promise<DeliveryOutcome> {
    const logRecord = record ?? this.remember(payload.tenantId, {
      id: payload.id,
      endpointId: endpoint.id,
      type: payload.type,
      status: 'retrying',
      attempts: 0,
      ts: Date.now(),
    });

    const retries = Number.isFinite(endpoint.retries) ? Math.max(0, Math.min(10, Math.trunc(endpoint.retries))) : this.env.webhookRetries;
    const timeoutMs = Number.isFinite(endpoint.timeoutMs)
      ? Math.max(500, Math.min(30_000, Math.trunc(endpoint.timeoutMs)))
      : this.env.webhookTimeoutMs;
    let lastError = 'Webhook retry budget exhausted';
    let lastStatus: number | undefined;

    for (let attempt = (pending?.failures ?? 0) + 1; attempt <= retries + 1; attempt += 1) {
      const target = pending ? this.queuedEndpoint(pending) : endpoint;
      if (!target) {
        lastError = 'Webhook endpoint is no longer subscribed or changed recipient';
        break;
      }
      // Resolve at use time from the startup snapshot and sign with a fresh timestamp.
      const secretRef = resolveTenantSecret(this.env, target.secretEnv, 'webhook');
      if (!secretRef.allowed) {
        lastError = `Webhook secret env ${secretRef.ref || '<empty>'} is not allowed (expected AGIL_WEBHOOK_*)`;
        break;
      }
      if (!secretRef.value) {
        lastError = `Webhook secret env ${target.secretEnv || '<empty>'} is not configured`;
        break;
      }
      const request = buildWebhookRequest(payload, secretRef.value);
      logRecord.attempts = attempt;
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), this.shutdown.signal]);
      this.shutdown.signal.throwIfAborted();
      try {
        const response = await fetch(target.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          signal,
        });
        void response.body?.cancel().catch(() => undefined);
        lastStatus = response.status;
        if (response.ok) {
          this.finish(logRecord, { status: 'delivered', attempts: attempt, statusCode: response.status }, payload.tenantId);
          return { status: 'delivered', attempts: attempt, statusCode: response.status };
        }
        lastError = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) break; // no point retrying 4xx
      } catch (error) {
        this.shutdown.signal.throwIfAborted();
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt <= retries) {
        const backoffMs = Math.min(2000, 200 * 2 ** (attempt - 1));
        if (pending) {
          pending.failures = attempt;
          pending.retryAfter = Date.now() + backoffMs;
          this.persist(pending);
        }
        await delay(backoffMs, undefined, { ref: false, signal: this.shutdown.signal });
      }
    }

    this.finish(
      logRecord,
      {
        status: 'failed',
        attempts: logRecord.attempts,
        ...(lastStatus !== undefined ? { statusCode: lastStatus } : {}),
        error: lastError,
      },
      payload.tenantId,
    );
    return {
      status: 'failed',
      attempts: logRecord.attempts,
      ...(lastStatus !== undefined ? { statusCode: lastStatus } : {}),
      error: lastError,
    };
  }

  /** Sends a synthetic `security.event` delivery to one configured endpoint. */
  async test(tenantId: string, endpoint: WebhookEndpointConfig): Promise<WebhookTestResult> {
    const payload: WebhookPayload = {
      id: randomUUID(),
      type: 'security.event',
      ts: Date.now(),
      tenantId,
      data: { test: true, message: 'AgilFrame webhook test delivery' },
    };
    const outcome = await this.deliver(endpoint, payload);
    return {
      endpointId: endpoint.id,
      status: outcome.status,
      ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /** Waits for queued deliveries, including jobs started as earlier jobs finish. */
  async drain(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      const timedOut = await Promise.race([
        Promise.allSettled([...this.inflight.values()]).then(() => false),
        sleep(Math.max(0, deadline - Date.now())).then(() => true),
      ]);
      if (timedOut) break;
    }
  }

  /** Stops acceptance and leaves unacknowledged jobs for the next startup. */
  async close(timeoutMs = 1500): Promise<void> {
    this.closing = true;
    await this.drain(timeoutMs);
    this.shutdown.abort();
    await Promise.allSettled([...this.inflight.values()]);
  }

  private remember(tenantId: string, record: WebhookDeliveryRecord): WebhookDeliveryRecord {
    this.deliveries.unshift({ tenantId, record });
    if (this.deliveries.length > MAX_DELIVERY_LOG) this.deliveries.length = MAX_DELIVERY_LOG;
    return record;
  }

  private finish(
    record: WebhookDeliveryRecord,
    outcome: { status: 'delivered' | 'failed'; attempts: number; statusCode?: number; error?: string },
    tenantId?: string,
  ): void {
    record.status = outcome.status;
    record.attempts = outcome.attempts;
    if (outcome.statusCode !== undefined) record.statusCode = outcome.statusCode;
    if (outcome.error) record.lastError = outcome.error.slice(0, 300);
    try {
      this.audit?.({
        type: outcome.status === 'delivered' ? 'webhook.delivered' : 'webhook.failed',
        severity: outcome.status === 'delivered' ? 'info' : 'warn',
        ...(tenantId ? { tenantId } : {}),
        message: `Webhook ${outcome.status}: ${record.type} -> ${record.endpointId}`,
        details: {
          endpointId: record.endpointId,
          event: record.type,
          attempts: record.attempts,
          ...(record.statusCode !== undefined ? { statusCode: record.statusCode } : {}),
          ...(record.lastError ? { error: record.lastError } : {}),
        },
      });
    } catch {
      /* auditing must never break delivery bookkeeping */
    }
  }
}
