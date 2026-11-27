/**
 * Security error codes shared by the security library and the REST API.
 *
 * Every code maps 1:1 to an HTTP error code from docs/contract.md §14, so the
 * server can forward `error.code` without a translation table.
 */
export type SecurityErrorCode =
  | 'password_required'
  | 'password_invalid'
  | 'geo_blocked'
  | 'rate_limited'
  | 'room_locked'
  | 'file_too_large'
  | 'unsupported_mime'
  | 'file_infected'
  | 'not_found'
  | 'stt_not_configured'
  | 'integrity_failed'
  | 'liveness_not_configured';

/** Error thrown by the security services; carries a stable machine-readable code. */
export class SecurityError extends Error {
  readonly code: SecurityErrorCode;

  constructor(code: SecurityErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SecurityError';
    this.code = code;
  }
}

/** Type guard that also survives `SecurityError` instances from another copy of the lib. */
export function isSecurityError(value: unknown): value is SecurityError {
  return (
    value instanceof SecurityError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'SecurityError' &&
      typeof (value as { code?: unknown }).code === 'string')
  );
}
