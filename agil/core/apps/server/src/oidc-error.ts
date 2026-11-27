/**
 * Shared OIDC error type (status + stable machine-readable code).
 *
 * Kept in its own module so `oidc-flow.ts`/`oidc.ts`/`oidc-discovery.ts` can
 * depend on it without an import cycle. `oidc.ts` re-exports it for
 * compatibility with existing imports.
 */
export class OidcError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'OidcError';
    this.status = status;
    this.code = code;
  }
}
