/**
 * Outgoing webhook signing (AgilFrame → company endpoint).
 *
 * Contract (docs/contract.md §19): POST JSON `WebhookPayload` with headers
 *   x-agil-signature — hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *   x-agil-delivery  — payload.id
 *   x-agil-event     — payload.type
 *   x-agil-timestamp — epoch milliseconds used in the signature
 *   content-type: application/json
 *
 * The secret is never stored in the tenant config: only the *name* of the env
 * variable (`secretEnv`) is persisted; the server resolves the value and passes
 * it here. The signature covers the exact raw request body, so the server must
 * send `JSON.stringify(payload)` verbatim — use `buildWebhookRequest()` to get
 * both the body and the headers from one place.
 *
 * Verification is constant-time and rejects timestamps outside the tolerance
 * window (replay protection).
 */
import { createHmac } from 'node:crypto';
import type { WebhookEventType, WebhookPayload } from '@agil/protocol';
import { secureCompare } from './signing.js';

/** Header names used for webhook HMAC signing (kept in sync with @agil/protocol). */
export const WEBHOOK_SIGNATURE_HEADER = 'x-agil-signature';
export const WEBHOOK_DELIVERY_HEADER = 'x-agil-delivery';
export const WEBHOOK_EVENT_HEADER = 'x-agil-event';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-agil-timestamp';

/** Default allowed clock skew for `verifyWebhookSignature`, seconds. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;

function floorTimestamp(timestamp: number): number {
  return Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now();
}

function parseTimestamp(timestamp: number | string | undefined): number | undefined {
  if (typeof timestamp === 'number') return Number.isFinite(timestamp) ? Math.floor(timestamp) : undefined;
  if (typeof timestamp === 'string') {
    const trimmed = timestamp.trim();
    if (!/^\d{1,16}$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
  }
  return undefined;
}

function assertSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('webhook: secret must be a non-empty string (resolve it from the secretEnv variable)');
  }
  return secret;
}

/**
 * Signs a webhook body: hex HMAC-SHA256 over `${timestamp}.${rawBody}`.
 *
 * @param rawBody — the exact JSON string that will be sent (not a parsed object);
 * @param secret — resolved secret value (never the env variable name);
 * @param timestamp — epoch ms (defaults to now); must match `x-agil-timestamp`.
 * @throws Error when the secret is empty (a webhook must never be sent unsigned).
 */
export function signWebhookPayload(rawBody: string, secret: string, timestamp: number = Date.now()): string {
  const body = typeof rawBody === 'string' ? rawBody : String(rawBody);
  const ts = floorTimestamp(timestamp);
  return createHmac('sha256', assertSecret(secret)).update(`${ts}.${body}`, 'utf8').digest('hex');
}

/**
 * Verifies an incoming webhook signature (constant-time + timestamp window).
 * Never throws; malformed input, an expired/future timestamp or a wrong secret
 * all yield `false`.
 */
export function verifyWebhookSignature(
  rawBody: string,
  secret: string,
  signature: string,
  timestamp: number | string | undefined,
  toleranceSec: number = WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
): boolean {
  try {
    if (typeof rawBody !== 'string' || typeof signature !== 'string') return false;
    const provided = signature.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(provided)) return false;
    if (typeof secret !== 'string' || secret.length === 0) return false;

    const ts = parseTimestamp(timestamp);
    if (ts === undefined) return false;

    const toleranceMs =
      Number.isFinite(toleranceSec) && toleranceSec >= 0 ? toleranceSec * 1000 : WEBHOOK_TIMESTAMP_TOLERANCE_SEC * 1000;
    if (Math.abs(Date.now() - ts) > toleranceMs) return false;

    const expected = signWebhookPayload(rawBody, secret, ts);
    return secureCompare(expected, provided);
  } catch {
    return false;
  }
}

/**
 * Builds the standard delivery headers for a webhook payload.
 *
 * The body sent to the endpoint must be exactly `JSON.stringify(payload)`;
 * `buildWebhookRequest()` returns both so they cannot diverge.
 */
export function buildWebhookHeaders(
  payload: WebhookPayload,
  secretEnvValue: string,
  timestamp: number = Date.now(),
): Record<string, string> {
  const ts = floorTimestamp(timestamp);
  const rawBody = JSON.stringify(payload);
  return {
    'content-type': 'application/json',
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(rawBody, secretEnvValue, ts),
    [WEBHOOK_DELIVERY_HEADER]: payload.id,
    [WEBHOOK_EVENT_HEADER]: payload.type,
    [WEBHOOK_TIMESTAMP_HEADER]: String(ts),
  };
}

export interface WebhookRequest {
  /** Exact body to POST (UTF-8 JSON). */
  body: string;
  headers: Record<string, string>;
  timestamp: number;
}

/**
 * Convenience helper: returns the exact body + signed headers for a delivery.
 * Use with `fetch(endpoint.url, { method: 'POST', body: request.body,
 * headers: request.headers })`.
 */
export function buildWebhookRequest(
  payload: WebhookPayload,
  secretEnvValue: string,
  timestamp: number = Date.now(),
): WebhookRequest {
  const ts = floorTimestamp(timestamp);
  return {
    body: JSON.stringify(payload),
    headers: buildWebhookHeaders(payload, secretEnvValue, ts),
    timestamp: ts,
  };
}

/** Re-exported event type alias for consumers that only need the union. */
export type { WebhookEventType, WebhookPayload };
