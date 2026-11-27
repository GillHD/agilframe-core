/**
 * Environment configuration for the AgilFrame MCP server.
 *
 * Defaults match the local development stack described in docs/contract.md.
 * The API key is *never* logged: use `redactKey()` whenever a key could end up
 * in a diagnostic message.
 */
export const DEFAULT_SERVER_URL = 'http://localhost:8787';
export const DEFAULT_API_KEY = 'dev-key';
export const DEFAULT_TENANT_ID = 'demo';
export const DEFAULT_TIMEOUT_MS = 8000;

/** Tool exposure mode (docs/api-exposure.md §2): full = all tools, read = read/design only. */
export type McpMode = 'full' | 'read';

export interface McpEnv {
  /** Base URL of the AgilFrame HTTP server, without a trailing slash. */
  serverUrl: string;
  /** Tenant API key sent as `x-api-key`. */
  apiKey: string;
  /** Tenant id used by online tools and by default config resolution. */
  tenantId: string;
  /** SCIM Bearer token from AGIL_SCIM_TOKEN (never logged). Empty when SCIM is not configured. */
  scimToken: string;
  /** Per-request network timeout. */
  timeoutMs: number;
  /** `read` registers only read/design tools (no config/room/webhook mutations). */
  mode: McpMode;
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 100) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 60_000);
}

function normalizeServerUrl(raw: string | undefined): { url: string; warning?: string } {
  const value = (raw ?? '').trim();
  if (!value) return { url: DEFAULT_SERVER_URL };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        url: DEFAULT_SERVER_URL,
        warning: `AGIL_SERVER_URL must use http(s); got "${parsed.protocol}". Falling back to ${DEFAULT_SERVER_URL}.`,
      };
    }
    return { url: parsed.origin + parsed.pathname.replace(/\/+$/, '') };
  } catch {
    return {
      url: DEFAULT_SERVER_URL,
      warning: `AGIL_SERVER_URL is not a valid URL ("${value}"). Falling back to ${DEFAULT_SERVER_URL}.`,
    };
  }
}

function parseMode(raw: string | undefined): { mode: McpMode; warning?: string } {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'full') return { mode: 'full' };
  if (value === 'read' || value === 'readonly' || value === 'read-only') return { mode: 'read' };
  return { mode: 'read', warning: 'AGIL_MCP_MODE is unknown; expected "full" or "read". Using "read".' };
}

export interface ReadEnvResult {
  env: McpEnv;
  warnings: string[];
}

/** Reads and normalizes MCP environment variables. Never throws. */
export function readEnv(source: NodeJS.ProcessEnv = process.env): ReadEnvResult {
  const warnings: string[] = [];
  const server = normalizeServerUrl(source.AGIL_SERVER_URL);
  if (server.warning) warnings.push(server.warning);
  const mode = parseMode(source.AGIL_MCP_MODE);
  if (mode.warning) warnings.push(mode.warning);
  const apiKey = (source.AGIL_API_KEY ?? '').trim() || DEFAULT_API_KEY;
  const tenantId = (source.AGIL_TENANT_ID ?? '').trim() || DEFAULT_TENANT_ID;
  const scimToken = (source.AGIL_SCIM_TOKEN ?? '').trim();
  return {
    env: {
      serverUrl: server.url,
      apiKey,
      tenantId,
      scimToken,
      timeoutMs: parseTimeout(source.AGIL_MCP_TIMEOUT_MS),
      mode: mode.mode,
    },
    warnings,
  };
}

/** Masks a secret for diagnostics: "configured" vs "not set", never the value. */
export function redactKey(key: string): string {
  return key ? 'configured' : 'not set';
}

/** Human-readable, key-free description of the current MCP environment. */
export function describeEnv(env: McpEnv): string {
  return `server=${env.serverUrl} tenant=${env.tenantId} apiKey=${redactKey(env.apiKey)} scim=${redactKey(env.scimToken)} timeout=${env.timeoutMs}ms mode=${env.mode}`;
}
