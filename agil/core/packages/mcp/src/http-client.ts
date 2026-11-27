/**
 * Minimal JSON HTTP client for the AgilFrame REST API.
 *
 * Responsibilities:
 *  - attach the tenant API key (`x-api-key`) without ever logging it;
 *  - fail fast with actionable, LLM-friendly error messages when the server is
 *    down, which is the normal case for offline use of the MCP server;
 *  - parse the `{ error: { code, message } }` body shape from the contract.
 */
import type { McpEnv } from './env.js';

/** The AGIL server could not be reached at all (connection refused, DNS, timeout). */
export class ServerUnavailableError extends Error {
  readonly kind = 'server_unavailable';

  constructor(
    readonly serverUrl: string,
    readonly reason: string,
    hint?: string,
  ) {
    super(
      `AGIL server is not reachable at ${serverUrl}: ${reason}. ` +
        (hint ??
          'Start it with "npm run dev" or "npm run start -w @agil/calls-server", ' +
            'or point AGIL_SERVER_URL at a running instance.') +
        ' This tool needs a live server; offline tools such as agil_generate_theme, ' +
        'agil_validate_config, agil_audit_accessibility and agil_get_embed_snippet still work.',
    );
    this.name = 'ServerUnavailableError';
  }
}

/** The server answered with a non-2xx status. */
export class ApiError extends Error {
  readonly kind = 'api_error';

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
    hint?: string,
  ) {
    super(`AGIL API error ${status} (${code}): ${message}${hint ? ` ${hint}` : ''}`);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Overrides the default timeout from the MCP environment. */
  timeoutMs?: number;
  /** When false the request is sent without `x-api-key` (public endpoints). */
  auth?: boolean;
  /** Extra request headers (internal use, e.g. SCIM bearer/tenant). Never logged. */
  headers?: Record<string, string>;
  /** Overrides the body content-type (SCIM uses application/scim+json). */
  contentType?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function networkReason(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const err = error as { cause?: { code?: string }; message?: string };
  const code = err.cause?.code;
  if (code === 'ECONNREFUSED') return 'connection refused (ECONNREFUSED)';
  if (code === 'ENOTFOUND') return 'host not found (ENOTFOUND)';
  if (code === 'ECONNRESET') return 'connection reset (ECONNRESET)';
  if (code === 'ETIMEDOUT') return 'connection timed out';
  return err.message ?? String(error);
}

function errorHint(status: number, code: string): string | undefined {
  if (status === 401 || status === 403) {
    return 'Check AGIL_API_KEY: it must belong to AGIL_TENANT_ID (default "dev-key" for the demo tenant).';
  }
  if (status === 404) {
    return 'The requested resource was not found. Check the room id, or call agil_get_server_health / agil_list_rooms first.';
  }
  if (status === 400 && code === 'validation_failed') {
    return 'The server rejected the payload. Call agil_validate_config first and inspect the reported issues.';
  }
  if (status === 429) {
    return 'Rate limited: wait a moment and retry.';
  }
  if (status >= 500) {
    return 'The server failed to handle the request. Try again, or check agil_get_server_health.';
  }
  return undefined;
}

function parseApiErrorBody(raw: string): { code?: string; message?: string; details?: unknown } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'object' && error !== null) {
        const body = error as { code?: unknown; message?: unknown; details?: unknown };
        return {
          code: typeof body.code === 'string' ? body.code : undefined,
          message: typeof body.message === 'string' ? body.message : undefined,
          details: body.details,
        };
      }
    }
  } catch {
    // not JSON — fall through
  }
  return {};
}

export class AgilHttpClient {
  constructor(private readonly env: McpEnv) {}

  get serverUrl(): string {
    return this.env.serverUrl;
  }

  get tenantId(): string {
    return this.env.tenantId;
  }

  /** Absolute URL for a `/v1/...` path plus optional query parameters. */
  url(path: string, query?: RequestOptions['query']): string {
    const base = `${this.env.serverUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (options.auth !== false) headers['x-api-key'] = this.env.apiKey;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/json';
      body = JSON.stringify(options.body);
    }
    const timeoutMs = options.timeoutMs ?? this.env.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ServerUnavailableError(
          this.env.serverUrl,
          `request to ${path} timed out after ${timeoutMs}ms`,
          'The server may be overloaded or AGIL_MCP_TIMEOUT_MS is too low. Check agil_get_server_health.',
        );
      }
      throw new ServerUnavailableError(this.env.serverUrl, networkReason(error));
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      const parsed = parseApiErrorBody(text);
      const code = parsed.code ?? `http_${response.status}`;
      const message = parsed.message ?? (text.trim().slice(0, 500) || response.statusText || 'Unknown error');
      throw new ApiError(code, message, response.status, parsed.details, errorHint(response.status, code));
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError('invalid_json', `Expected JSON from ${path} but got: ${text.slice(0, 200)}`, response.status);
    }
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  put<T>(path: string, body: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PUT', body });
  }

  /**
   * SCIM 2.0 request (contract §32): Bearer AGIL_SCIM_TOKEN + x-tenant-id,
   * acceptance/content type application/scim+json, no x-api-key.
   * The token is taken from McpEnv only and is never included in errors/logs.
   */
  scim<T>(tenantId: string, path: string, options: Omit<RequestOptions, 'method' | 'body' | 'auth' | 'headers' | 'contentType'> & Pick<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, {
      ...options,
      auth: false,
      headers: {
        accept: 'application/scim+json',
        'content-type': 'application/scim+json',
        authorization: `Bearer ${this.env.scimToken}`,
        'x-tenant-id': tenantId,
      },
    });
  }
}
