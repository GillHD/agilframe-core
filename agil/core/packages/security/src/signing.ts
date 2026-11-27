/**
 * HMAC-SHA256 helpers used to sign file/recording download URLs.
 *
 * Signature payload format (internal, do not depend on it outside the package):
 *   file:<id>:<exp>       — FileStore
 *   recording:<id>:<exp>  — RecordingStore
 *
 * The signature is base64url so it can be put into a query string verbatim.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 over `payload`, base64url encoded (43 chars, URL-safe). */
export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

/**
 * Constant-time comparison of two strings.
 *
 * Both inputs are hashed first, so the comparison always runs over equal-length
 * buffers and does not leak the length of the expected signature.
 */
export function secureCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** Verifies a signature produced by {@link signPayload}; never throws. */
export function verifyPayload(secret: string, payload: string, signature: string | null | undefined): boolean {
  if (typeof signature !== 'string') return false;
  const provided = signature.trim();
  if (provided.length === 0 || provided.length > 256) return false;
  try {
    return secureCompare(signPayload(secret, payload), provided);
  } catch {
    return false;
  }
}
