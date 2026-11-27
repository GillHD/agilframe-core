/**
 * Room-password hashing (scrypt, sync).
 *
 * Stored format (v1):
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 *   N=16384, r=8, p=1, 16-byte random salt, 64-byte derived key.
 *
 * The plain password is never stored or logged; `verifyPassword` runs in
 * constant time via `crypto.timingSafeEqual` and returns false (never throws)
 * for malformed hashes.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SecurityError } from './errors.js';

/** scrypt cost parameter N (2^14). */
export const SCRYPT_N = 16_384;
/** scrypt block size r. */
export const SCRYPT_R = 8;
/** scrypt parallelisation p. */
export const SCRYPT_P = 1;
/** Salt length in bytes. */
export const SCRYPT_SALT_BYTES = 16;
/** Derived key length in bytes. */
export const SCRYPT_KEY_LEN = 64;
/** Prefix of every stored hash. */
export const PASSWORD_HASH_PREFIX = 'scrypt';

/** Upper bound for `maxmem`; 128*N*r = 16 MiB for the default parameters. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** Guard rails when verifying untrusted stored hashes (DoS protection). */
const MIN_N = 1024;
const MAX_N = 1_048_576;
const MAX_R = 32;
const MAX_P = 16;

function derive(plain: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Buffer {
  return scryptSync(plain, salt, keyLen, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

function isPositiveInt(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** True when `value` looks like a stored scrypt hash (not a plain password). */
export function isPasswordHash(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('$');
  return parts.length === 6 && parts[0] === PASSWORD_HASH_PREFIX;
}

/**
 * Hashes a plain-text password with scrypt.
 *
 * @throws SecurityError code `password_required` when the password is empty.
 */
export function hashPassword(plain: string): string {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new SecurityError('password_required', 'Password must be a non-empty string');
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = derive(plain, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEY_LEN);
  return [
    PASSWORD_HASH_PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/**
 * Verifies a plain-text password against a stored scrypt hash.
 *
 * Never throws: malformed hashes, wrong parameters and unexpected crypto
 * errors all yield `false`.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  try {
    if (typeof plain !== 'string' || plain.length === 0) return false;
    if (typeof stored !== 'string') return false;
    const parts = stored.trim().split('$');
    if (parts.length !== 6) return false;
    const [algo, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
    if (!algo || algo !== PASSWORD_HASH_PREFIX) return false;
    if (!nRaw || !rRaw || !pRaw || !saltRaw || !hashRaw) return false;

    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!isPositiveInt(n, MIN_N, MAX_N) || !isPositiveInt(r, 1, MAX_R) || !isPositiveInt(p, 1, MAX_P)) return false;
    // scrypt requires N to be a power of two.
    if ((n & (n - 1)) !== 0) return false;

    const salt = Buffer.from(saltRaw, 'base64url');
    const expected = Buffer.from(hashRaw, 'base64url');
    // The v1 format fixes salt=16 B and key=64 B; anything else is not our hash
    // (this also rejects truncated hashes, which would otherwise verify as a prefix).
    if (salt.length !== SCRYPT_SALT_BYTES || expected.length !== SCRYPT_KEY_LEN) return false;

    const actual = derive(plain, salt, n, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
