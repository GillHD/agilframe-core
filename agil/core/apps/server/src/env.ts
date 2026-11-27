/**
 * Server configuration: every knob is read from the environment at startup and
 * exposed as a plain, fully-resolved object.
 *
 * Design rules: the server never reads `process.env` outside this module (tests
 * inject overrides); relative paths are resolved from the monorepo root, not from
 * `process.cwd()`; malformed values fall back to documented defaults.
 */
import path from 'node:path';
import { parseIngressSources, type PullIngressSource } from './ingress-sources.js';
import { fileURLToPath } from 'node:url';
import { OIDC_TENANT_SECRETS_ENV, iceServerSchema, isAllowedOidcClientSecretEnv, isAllowedTenantSecretEnvName, publicAbuseModeSchema, type IceServerConfig, type PublicAbuseMode, type SfuCapacityProfile } from '@agil/protocol';
import { parseAllowlist } from './net-policy.js';

/** Repository root (agil/core/apps/server/src -> ../../../../../). */
export const ROOT_DIR = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

export type GeoProvider = 'header' | 'ipapi' | 'none';

export interface Env {
  /** HTTP+WS port. `0` asks the OS for a free port (used by tests). */
  port: number;
  host: string;
  tokenSecret: string;
  /** API key -> tenant id. */
  apiKeys: Record<string, string>;
  /** AGIL_PLATFORM_KEY: platform-owner key for /v1/admin/tenants (never a tenant key). */
  platformKey: string;
  allowAnonymous: boolean;
  publicAbuseDefaultMode: PublicAbuseMode;
  defaultTenantId: string;
  dataDir: string;
  chatPostgresUrl: string;
  staticDir: string;
  editorDir: string;
  dashboardDir: string;
  sdkDir: string;
  widgetDir: string;
  /** Repository docs directory served read-only under `/docs/<file>`. */
  docsDir: string;
  /** Optional shared directory for mutable CMS publications and history. */
  docsDataDir: string;
  publicOrigin: string;
  /** CNAME target advertised for custom domains (defaults to the publicOrigin host). */
  domainTarget: string;
  /** Per-lookup timeout for custom-domain DNS verification. */
  domainDnsTimeoutMs: number;
  /**
   * IP allowlist for the on-demand TLS approval hook (`GET /v1/domain/ask`).
   * Only the reverse proxy should reach it: the default is loopback, and an
   * empty value is also treated as loopback (never "everyone").
   */
  domainAskAllowIps: string[];
  /**
   * Optional shared secret for `/v1/domain/ask` (`AGIL_DOMAIN_ASK_SECRET`).
   * **Required** for on-demand TLS: when empty the hook always answers 403, so
   * a proxied external request cannot reach the certificate gate. The proxy
   * passes it as `x-agil-domain-ask-secret` or `?key=`.
   */
  domainAskSecret: string;
  /**
   * `Host` values accepted by `/v1/domain/ask` (`AGIL_DOMAIN_ASK_HOSTS`).
   * Caddy's internal ask targets `http://127.0.0.1:8787`, while a request
   * proxied through the public site keeps the public Host, so this separates
   * the two even though they share the same TCP peer. `*` disables the check
   * (only for proxies that rewrite Host; keep the secret mandatory).
   */
  domainAskHosts: string[];
  /** Approval-hook allowance per client IP per minute (`AGIL_DOMAIN_ASK_RATE_LIMIT_PER_MIN`). */
  domainAskRateLimitPerMin: number;
  /**
   * HSTS lifetime in seconds (`AGIL_HSTS_MAX_AGE_SEC`, default 180 days).
   * `0` disables the header entirely.
   */
  hstsMaxAgeSec: number;
  /**
   * Emit `includeSubDomains` for the platform's own host(s). Off = never emit it
   * anywhere. Customer hosts never get it unless
   * {@link hstsIncludeSubDomainsCustom} is set: forcing HTTPS on
   * `*.customer.com` cannot be undone before `max-age` expires.
   */
  hstsIncludeSubDomains: boolean;
  /** Opt-in `includeSubDomains` for customer/custom-domain hosts (dangerous). */
  hstsIncludeSubDomainsCustom: boolean;
  iceServers: IceServerConfig[];
  /** Add `?transport=tcp` TURN fallback URLs automatically (UDP-blocked networks). */
  iceTcpFallback: boolean;
  /** Deployment-owned coturn signing keys, indexed by exact tenant and relay ID. */
  coturnRestSecrets: Record<string, Record<string, string>>;
  coturnAutoSecrets: Record<string, Record<string, string>>;
  coturnRestTtlSec: number;
  roomTtlSec: number;
  /**
   * Live-call continuity (docs/call-continuity.md): persist room/session
   * snapshots and restore active rooms on Core startup. `AGIL_CONTINUITY=0`
   * turns the whole feature off (nothing is written to disk/Redis).
   */
  continuityEnabled: boolean;
  /** Room snapshot root (`AGIL_ROOM_SNAPSHOT_DIR`, default `<dataDir>/rooms`). */
  roomSnapshotDir: string;
  /** Snapshot backend: `file` (default) or `redis` (Redis-compatible store). */
  roomSnapshotStore: 'file' | 'redis';
  /** Periodic flush interval for live room snapshots (ms, 0 = event-driven only). */
  roomSnapshotFlushMs: number;
  /** Retention for snapshots of rooms without a TTL (`AGIL_ROOM_SNAPSHOT_MAX_AGE_SEC`). */
  roomSnapshotMaxAgeSec: number;
  /**
   * How long a dropped participant is kept resumable (`AGIL_RESUME_GRACE_SEC`).
   * 0 = immediate `peer-left`; only sockets that opted in with `?resume=1` are held.
   */
  resumeGraceSec: number;
  /** Resume-token lifetime in seconds (`AGIL_RESUME_TOKEN_TTL_SEC`). */
  resumeTokenTtlSec: number;
  /** Optional SFU node id override used by the room allocator/snapshot. */
  sfuNodeId: string;
  tokenTtlSec: number;
  trustProxy: boolean;
  /**
   * Validate the WebSocket `Origin` against `AGIL_PUBLIC_ORIGIN`, the tenant's
   * `integrations.allowedOrigins` and the tenant's verified custom domain.
   * `AGIL_WS_ORIGIN_ENFORCE=0` disables the check (a browser client must send an
   * allowed Origin either way).
   */
  wsOriginEnforce: boolean;
  /** Extra origins accepted by `/ws` in addition to the per-tenant list. */
  wsAllowedOrigins: string[];
  geoProvider: GeoProvider;
  /**
   * Trust the client-supplied `x-agil-country` header. Off by default: a client
   * must never pick its own geo policy country (use ipapi/edge in production).
   */
  geoHeaderAllow: boolean;
  ipSalt: string;
  fileTtlSec: number;
  maxUploadMb: number;
  maxRecordingMb: number;
  recordingsDir: string;
  /** SFU (LiveKit-compatible) media integration. */
  sfuUrl: string;
  /** Optional private LiveKit RoomService address for Core. */
  sfuControlUrl: string;
  srtIngressSources: PullIngressSource[];
  hlsIngressSources: PullIngressSource[];
  sfuNodeUrls: ReadonlyMap<string, ReadonlyMap<string, string>>;
  sfuApiKey: string;
  sfuApiSecret: string;
  sfuEnabled: boolean;
  /**
   * Deployment gallery capacity profile (`AGIL_SFU_PROFILE=low|standard|high`).
   * Empty = not set: the tenant `scale.sfu.capacityProfile` applies, else
   * `standard`. When set it wins over tenant config; the effective value is
   * surfaced in the client config and `/v1/admin/scale`.
   */
  sfuProfile: SfuCapacityProfile | '';
  /** Secret for deterministic per-room E2EE keys (AGIL_E2EE_SECRET); fallback dev-only. */
  e2eeSecret: string;
  /** SCIM 2.0 directory bearer token (AGIL_SCIM_TOKEN); empty = SCIM disabled (501). */
  scimToken: string;
  /** Lifetime of an SSO-issued dashboard (admin) session JWT (short-lived). */
  adminSessionTtlSec: number;
  /** Lifetime of a pending OIDC authorization (state+nonce+PKCE entry). */
  oidcStateTtlSec: number;
  /**
   * Bind same-origin dashboard SSO states to an HttpOnly cookie (login-CSRF
   * defense).
   */
  oidcCookieBinding: boolean;
  /**
   * The only OIDC client secrets the code exchange may read: a snapshot of
   * `process.env` entries in the server-owned `AGIL_OIDC_CLIENT_SECRET[_*]`
   * namespace. Tenant config selects a key here; it can never read another
   * environment variable.
   */
  oidcClientSecrets: Record<string, string>;
  /**
   * Explicit tenant -> OIDC client-secret env name binding, parsed from
   * `AGIL_OIDC_TENANT_SECRETS` (`demo=AGIL_OIDC_CLIENT_SECRET,acme=...`).
   * Complements the `AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME>` convention; a
   * tenant may only select a name bound to it.
   */
  oidcTenantSecrets: Record<string, string>;
  /**
   * Snapshot of the server-owned secret namespaces a tenant config may
   * reference: `AGIL_INTEGRATION_*`, `AGIL_WEBHOOK_*`, `AGIL_SIEM_*`,
   * `AGIL_SFU_*`, `AGIL_TURN_*`. Tenant config only selects a key here; the
   * server never looks up `process.env` by a tenant-controlled name, so a tenant
   * admin cannot make the server send `AGIL_TOKEN_SECRET` to their endpoint.
   */
  tenantSecretEnv: Record<string, string>;
  /** LiveKit Egress Twirp base URL and credentials (defaults to SFU keys). */
  egressUrl: string;
  egressApiKey: string;
  egressApiSecret: string;
  egressEnabled: boolean;
  /**
   * Optional egress worker health URL (`http://egress.internal:8080`), the
   * worker's health/metrics port — NOT the LiveKit Twirp base. Used only by
   * `GET /v1/admin/egress/workers` for reachability; the app never dispatches
   * jobs to it.
   */
  egressHealthUrl: string;
  /** Signed HLS/MP4 playback links (HMAC + TTL). */
  egressPlaybackEnabled: boolean;
  egressPlaybackBackend: 'auto' | 'local' | 's3';
  egressArchiveDeleteEnabled: boolean;
  /** HMAC secret for playback tokens; defaults to `AGIL_TOKEN_SECRET`. */
  egressPlaybackSecret: string;
  /** Default playback link TTL in seconds (default 900; clamped to 60..86400). */
  egressPlaybackTtlSec: number;
  /**
   * Optional local directory containing egress artifacts (the worker's `/out`
   * volume) for local storage or the backward-compatible auto selection.
   */
  egressPlaybackDir: string;
  /** App-side S3 read credentials for the playback proxy (never logged). */
  egressS3Endpoint: string;
  egressS3Region: string;
  egressS3Bucket: string;
  egressS3AccessKey: string;
  egressS3SecretKey: string;
  egressS3ForcePathStyle: boolean;
  /** Active egress sessions older than this are reported/stoppable as stuck. */
  egressStuckAfterSec: number;
  /** LiveKit SIP gateway Twirp base URL and credentials (defaults: SFU keys, disabled). */
  sipUrl: string;
  sipApiKey: string;
  sipApiSecret: string;
  sipEnabled: boolean;
  sttUrl: string;
  sttKey: string;
  sttModel: string;
  /**
   * Where captions come from: `local` (on-box whisper.cpp / faster-whisper),
   * `browser` (Web Speech API only), `none`, or `remote` (OpenAI-compatible
   * `AGIL_STT_URL` adapter). Never a hard startup dependency.
   */
  sttProvider: 'local' | 'browser' | 'none' | 'remote';
  /** `whisper-cpp` | `faster-whisper` | `auto` (docs/stt-translation-local.md). */
  sttLocalEngine: 'whisper-cpp' | 'faster-whisper' | 'auto';
  sttLocalBinary: string;
  sttLocalModelPath: string;
  /** faster-whisper model name or converted model directory. */
  sttLocalModel: string;
  sttLocalPython: string;
  /** Optional override for the bundled faster-whisper worker script. */
  sttLocalWorker: string;
  sttLocalThreads: number;
  sttLocalGpu: boolean;
  sttLocalTimeoutMs: number;
  sttLocalFfmpeg: string;
  /**
   * Explicit opt-in for a one-time HuggingFace weight download when local STT /
   * translation models are missing (`AGIL_STT_ALLOW_DOWNLOAD=1`). Off by
   * default: status probes and the first request never touch the network.
   */
  localModelsAllowDownload: boolean;
  /** `local` (OPUS-MT/Marian on-box), `llm` (optional opt-in) or `none`. */
  translateProvider: 'local' | 'llm' | 'none';
  translateLocalEngine: 'opus-mt' | 'marian' | 'nllb' | 'auto';
  translateLocalModelDir: string;
  /** Legacy variable detected to report the NLLB migration. */
  translateLocalModel: string;
  translateLocalPython: string;
  translateLocalWorker: string;
  translateLocalTimeoutMs: number;
  translateLocalGpu: boolean;
  translateLocalMaxChars: number;
  /** Optional LLM route for TRANSLATE_PROVIDER=llm (off by default). */
  translateLlmProvider: 'openai-compatible' | 'anthropic' | 'ollama' | '';
  translateLlmUrl: string;
  translateLlmKey: string;
  translateLlmModel: string;
  translateLlmTimeoutMs: number;
  /**
   * `local` refuses every external STT/translation/LLM path (privacy mode).
   * `standard` keeps the default behaviour.
   */
  privacyMode: 'standard' | 'local';
  /** Delete stored transcript segments older than N seconds (0 = room lifetime). */
  transcriptRetentionSec: number;
  /** Require explicit participant consent before server STT / transcript storage. */
  transcriptConsentRequired: boolean;
  integrityUrl: string;
  integrityKey: string;
  clamavHost: string;
  clamavPort: number;
  clamavSocket: string;
  clamavTimeoutMs: number;
  yaraRules: string;
  yaraBin: string;
  avConcurrency: number;
  avQueueLimit: number;
  /** Durable spool for accepted async scan jobs (`<AGIL_DATA_DIR>/av-queue`). */
  avQueueDir: string;
  quarantineDir: string;
  livenessEngine: 'challenge' | 'external';
  livenessUrl: string;
  livenessKey: string;
  livenessTimeoutMs: number;
  livenessTtlSec: number;
  livenessMaxAttempts: number;
  /** Optional HMAC secret used to sign corporate AI-agent webhook bodies. */
  aiAgentHmacSecret: string;
  inCallPolicyPath: string;
  inCallPolicyPublicKey: string;
  /** Server-side DeepSeek key for the dashboard mascot assistant (never returned/logged). */
  deepseekApiKey: string;
  deepseekModel: string;
  deepseekBaseUrl: string;
  deepseekTimeoutMs: number;
  /** Default outbound webhook timeout (ms) and retry count. */
  webhookTimeoutMs: number;
  webhookRetries: number;
  adminRateLimitPerMin: number;
  /** Join attempts allowed per minute per (IP, room). High enough for NAT/office egress. */
  joinRateLimitPerMin: number;
  /** Waiting-room request TTL and queue limit. */
  lobbyTtlSec: number;
  lobbyMax: number;
  /** Expose /docs, /docs/:file and the public OpenAPI spec. */
  docsEnabled: boolean;
  /** IP allowlist for docs/OpenAPI (empty = everyone). */
  docsAllowIps: string[];
  /** Dedicated docs/OpenAPI port (0 = serve on the main port). */
  docsPort: number;
  docsHost: string;
  docsRateLimitPerMin: number;
  /** Expose /v1/admin/* at all. */
  adminApiEnabled: boolean;
  /** IP allowlist for the admin API (empty = everyone). */
  adminAllowIps: string[];
  /**
   * Optional IP allowlist for the machine enrollment surface
   * (`/v1/cluster/join`, `/v1/nodes/register`, `/v1/nodes/:id/heartbeat`).
   * Empty = everyone; independent from the admin allowlist.
   */
  enrollAllowIps: string[];
  /** Heartbeat allowance per node per minute (contract = 2/min, default 10). */
  heartbeatRateLimitPerMin: number;
  /**
   * Outer heartbeat allowance per client IP per minute, charged before the
   * credential is validated (invalid keys included), so a flood of distinct bogus
   * keys hits one bounded bucket per IP.
   */
  heartbeatIpRateLimitPerMin: number;
  /** Default lifetime of a per-node key in seconds (0 = never expires). */
  nodeKeyTtlSec: number;
  /** `leader` (active) or `standby` (read-only registry; no enrollment writes). */
  clusterRole: 'leader' | 'standby';
  /**
   * Redis URL for the Core leader lease (`redis://` / `rediss://`), or empty
   * for standalone mode. Only the lease/state keys live in Redis; rooms, tenant
   * config and the node registry are not replicated (docs/ha-leader.md).
   */
  redisUrl: string;
  /** Shared cluster id; in Redis mode an empty value falls back to `default`. */
  clusterId: string;
  /** Stable id of this Core (lease value); empty = `<hostname>:<port>` at runtime. */
  clusterNodeId: string;
  /** Leader lease TTL (`AGIL_LEADER_LEASE_TTL_MS`), 2 s … 120 s. */
  leaderLeaseTtlMs: number;
  /** Lease renewal interval; must be well below the TTL (default TTL / 3). */
  leaderRenewIntervalMs: number;
  /** How often a standby retries acquiring the lease. */
  leaderRetryIntervalMs: number;
  /** Redis key prefix (`agil:cluster:<clusterId>:…`). */
  redisKeyPrefix: string;
  flowStore: 'file' | 'redis';
  /** HTTP MCP is served by the @agil/mcp process on its own port; flags only. */
  mcpHttpEnabled: boolean;
  mcpHttpPort: number;
  mcpHttpToken: string;
  mcpHttpAllowIps: string[];
  mcpMode: 'full' | 'read';
  /** When true, the logger prints nothing (tests / e2e). */
  quiet: boolean;
}

/** Same shape as {@link Env}, but every field is optional and final. */
export type EnvOverrides = Partial<Env>;

const DEFAULT_TOKEN_SECRET = 'dev-secret-agil-calls';
const DEFAULT_API_KEYS = 'dev-key:demo';
const DEFAULT_ICE_SERVERS: IceServerConfig[] = [{ urls: 'stun:stun.l.google.com:19302' }];

function envStr(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  return value ? value : fallback;
}

/** First non-empty value among aliases (`STT_PROVIDER`, `AGIL_STT_PROVIDER`, …). */
function envFirst(source: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Parses the usual boolean spellings; anything else keeps the default. */
export function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

/** Parses an integer and clamps it to [min, max]; malformed input keeps the default. */
export function envNum(raw: string | undefined, fallback: number, min = -Infinity, max = Infinity): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function envOrigin(raw: string | undefined, port: number): string {
  const value = envStr(raw, `http://localhost:${port}`);
  return value.replace(/\/+$/, '');
}

/**
 * Snapshots OIDC client secrets from the server-owned env namespace. Tenant
 * config (`integrations.identity.clientSecretEnv`) may only name one of these
 * keys, so a tenant admin cannot make the code exchange read an arbitrary
 * `process.env` value such as `AGIL_TOKEN_SECRET`.
 */
export function parseOidcClientSecrets(source: NodeJS.ProcessEnv): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (name !== name.trim() || !isAllowedOidcClientSecretEnv(name) || name === '') continue;
    secrets[name] = value;
  }
  return secrets;
}

/** Tenant ids accepted in `AGIL_OIDC_TENANT_SECRETS` (same shape as tenant routes). */
const OIDC_TENANT_SECRETS_TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Parses the optional explicit tenant binding:
 *
 *   AGIL_OIDC_TENANT_SECRETS="demo=AGIL_OIDC_CLIENT_SECRET,acme=AGIL_OIDC_CLIENT_SECRET_ACME"
 *
 * Pairs are comma/whitespace separated `tenantId=ENV_NAME`. Tenant ids are
 * matched **exactly and case-sensitively** (same policy as `TenantStore`):
 * `demo` and `DEMO` are distinct tenants, and `a-b`/`a_b`/`a.b`/`A_B` never
 * alias each other. Malformed pairs and names outside the
 * `AGIL_OIDC_CLIENT_SECRET[_*]` namespace are ignored (fail closed: the
 * affected exchange answers 400).
 *
 * A name mapped to two different tenants is ambiguous and dropped entirely. A
 * duplicate tenant key is also ambiguous: the whole map is ignored so no
 * mapped secret can be selected (fail closed at startup).
 */
export function parseOidcTenantSecrets(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return result;
  const owners = new Map<string, string>(); // env name -> exact tenant id
  const conflicted = new Set<string>();
  const seenTenants = new Set<string>();
  for (const pair of value.split(/[,\s]+/)) {
    const entry = pair.trim();
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator === entry.length - 1) continue;
    const tenantId = entry.slice(0, separator).trim();
    const name = entry.slice(separator + 1).trim();
    if (!OIDC_TENANT_SECRETS_TENANT_RE.test(tenantId)) continue;
    // Duplicate tenant key: disable the whole map instead of letting the last
    // entry win.
    if (seenTenants.has(tenantId)) return {};
    seenTenants.add(tenantId);
    if (!name || name.length > 100 || !isAllowedOidcClientSecretEnv(name)) continue;
    const owner = owners.get(name);
    if (conflicted.has(name)) continue;
    if (owner !== undefined && owner !== tenantId) {
      // The same secret name cannot belong to two tenants.
      conflicted.add(name);
      if (result[owner] === name) delete result[owner];
      continue;
    }
    result[tenantId] = name;
    owners.set(name, tenantId);
  }
  return result;
}

/**
 * Snapshots the server-owned secret namespaces at startup. Only names matching
 * the allowlist in `@agil/protocol` are copied, so a tenant config that names
 * `AGIL_TOKEN_SECRET` can never resolve a value — even if the variable exists
 * in the process environment.
 */
export function parseTenantSecretEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (name !== name.trim() || !isAllowedTenantSecretEnvName(name)) continue;
    secrets[name] = value;
  }
  return secrets;
}

/** `key:tenant,key2:tenant2` -> record. Malformed pairs are skipped. */
export function parseApiKeys(raw: string | undefined): Record<string, string> {
  const source = envStr(raw, DEFAULT_API_KEYS);
  const result: Record<string, string> = Object.create(null);
  for (const pair of source.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0 || separator === trimmed.length - 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const tenant = trimmed.slice(separator + 1).trim();
    if (key && tenant) result[key] = tenant;
  }
  if (Object.keys(result).length === 0) result[DEFAULT_API_KEYS.split(':')[0] as string] = 'demo';
  return result;
}

function parseSfuNodeUrls(raw: string | undefined): Env['sfuNodeUrls'] {
  const tenants = new Map<string, ReadonlyMap<string, string>>();
  if (!raw?.trim()) return tenants;
  try {
    const value = JSON.parse(raw) as Record<string, Record<string, string>>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    for (const [tenantId, nodes] of Object.entries(value)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId) || !nodes || typeof nodes !== 'object' || Array.isArray(nodes)) throw new Error();
      const endpoints = new Map<string, string>();
      for (const [nodeId, address] of Object.entries(nodes)) {
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId) || typeof address !== 'string') throw new Error();
        const url = new URL(address.trim());
        if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        endpoints.set(nodeId, url.href);
      }
      if (endpoints.size) tenants.set(tenantId, endpoints);
    }
    return tenants;
  } catch {
    throw new Error('AGIL_SFU_NODE_URLS must map tenant IDs to node IDs and ws(s) URLs without credentials, queries or fragments');
  }
}

/** Parses AGIL_ICE_SERVERS JSON; invalid entries are ignored. */
export function parseIceServers(raw: string | undefined): IceServerConfig[] {
  if (!raw || !raw.trim()) return DEFAULT_ICE_SERVERS.map((server) => ({ ...server }));
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const servers: IceServerConfig[] = [];
    for (const item of list) {
      const result = iceServerSchema.safeParse(item);
      if (result.success) servers.push(result.data);
    }
    if (servers.length > 0) return servers;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_ICE_SERVERS.map((server) => ({ ...server }));
}

function parseCoturnRestSecrets(raw: string | undefined): Env['coturnRestSecrets'] {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([tenantId, entries]) => {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
      return [[tenantId, Object.fromEntries(Object.entries(entries)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length >= 32))]];
    }));
  } catch {
    return {};
  }
}

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(ROOT_DIR, value);
}

/** Comma/space separated CIDR list -> trimmed array. */
export function parseIpList(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/** Host part of an origin; falls back to a documented example on malformed input. */
function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase() || 'calls.example.com';
  } catch {
    return 'calls.example.com';
  }
}

/**
 * Builds the effective configuration. Passing `overrides` skips env parsing for
 * those keys only — this is how tests and `createAgilServer()` pin values.
 */
export function loadEnv(overrides: EnvOverrides = {}): Env {
  const source = process.env;
  const port = overrides.port ?? envNum(source.PORT, 8787, 0, 65535);
  const dataDir = resolvePath(overrides.dataDir ?? envStr(source.AGIL_DATA_DIR, '.data'));
  const tokenSecret = envStr(source.AGIL_TOKEN_SECRET, DEFAULT_TOKEN_SECRET);
  const sfuUrl = envStr(source.AGIL_SFU_URL, '');
  const sfuApiKey = envStr(source.AGIL_SFU_API_KEY, '');
  const sfuApiSecret = envStr(source.AGIL_SFU_API_SECRET, '');
  const sfuConfigured = Boolean(sfuUrl && sfuApiKey && sfuApiSecret);
  const egressPlaybackBackend = overrides.egressPlaybackBackend
    ?? envStr(source.AGIL_EGRESS_PLAYBACK_BACKEND, 'auto').toLowerCase();
  if (egressPlaybackBackend !== 'auto' && egressPlaybackBackend !== 'local' && egressPlaybackBackend !== 's3') {
    throw new Error('AGIL_EGRESS_PLAYBACK_BACKEND must be auto, local, or s3');
  }
  // Unset or misspelled values keep the tenant/standard default rather than
  // silently downgrading capacity.
  const sfuProfileRaw = envStr(source.AGIL_SFU_PROFILE, '').toLowerCase();
  const sfuProfile: Env['sfuProfile'] =
    sfuProfileRaw === 'low' || sfuProfileRaw === 'standard' || sfuProfileRaw === 'high' ? sfuProfileRaw : '';
  const sttUrl = envStr(source.AGIL_STT_URL, '');
  const sttProviderRaw = envStr(envFirst(source, ['STT_PROVIDER', 'AGIL_STT_PROVIDER']), '').toLowerCase();
  const sttProvider: Env['sttProvider'] =
    sttProviderRaw === 'local' || sttProviderRaw === 'browser' || sttProviderRaw === 'none' || sttProviderRaw === 'remote'
      ? sttProviderRaw
      : // Unset resolves to `remote`; the endpoint stays 501 when no remote
        // provider is configured.
        'remote';
  const translateProviderRaw = envStr(
    envFirst(source, ['TRANSLATE_PROVIDER', 'AGIL_TRANSLATE_PROVIDER']),
    '',
  ).toLowerCase();
  const translateProvider: Env['translateProvider'] =
    translateProviderRaw === 'local' || translateProviderRaw === 'llm' || translateProviderRaw === 'none'
      ? translateProviderRaw
      : 'none';
  const privacyMode: Env['privacyMode'] =
    envStr(envFirst(source, ['PRIVACY_MODE', 'AGIL_PRIVACY_MODE']), 'standard').toLowerCase() === 'local'
      ? 'local'
      : 'standard';
  const integrityUrl = envStr(source.AGIL_INTEGRITY_URL, '');
  const rawGeo = envStr(source.AGIL_GEO_PROVIDER, 'header').toLowerCase();
  const geoProvider: GeoProvider =
    rawGeo === 'ipapi' || rawGeo === 'none' || rawGeo === 'header' ? rawGeo : 'header';
  const publicOrigin = envOrigin(source.AGIL_PUBLIC_ORIGIN, port);
  // The on-demand TLS hook is proxy-only. An empty env value must not degrade
  // to "allow every IP" (isIpAllowed(…) treats [] as allow-all), so the
  // fallback is loopback; an operator with a remote proxy adds its IP/CIDR.
  const domainAskAllowIpsRaw = parseIpList(source.AGIL_DOMAIN_ASK_ALLOW_IPS);
  const domainAskAllowIps = domainAskAllowIpsRaw.length > 0 ? domainAskAllowIpsRaw : ['127.0.0.1', '::1'];
  // A typo such as `172.17.0.1/33` or a hostname parses to zero rules, and
  // `isIpAllowed()` treats an empty rule set as allow-all. The on-demand TLS
  // gate must never fail open, so refuse to start with a broken allowlist.
  if ((source.AGIL_DOMAIN_ASK_ALLOW_IPS ?? '').trim() !== '' && parseAllowlist(domainAskAllowIps).length === 0) {
    throw new Error(
      'AGIL_DOMAIN_ASK_ALLOW_IPS contains no valid IP/CIDR entries — refusing to start with an open on-demand TLS gate',
    );
  }
  // Dev (Vite) origins are added only in non-production; a real deployment must
  // list its own origins.
  const devWsOrigins = isProduction()
    ? []
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];
  // Leader lease: TTL bounds keep failover detectable (>= 2 s) and the renewal
  // interval always leaves room for at least one retry before expiry.
  const leaderLeaseTtlMs = envNum(source.AGIL_LEADER_LEASE_TTL_MS, 10_000, 2_000, 120_000);
  const leaderRenewIntervalMs = envNum(
    source.AGIL_LEADER_RENEW_INTERVAL_MS,
    Math.max(250, Math.floor(leaderLeaseTtlMs / 3)),
    100,
    Math.max(100, leaderLeaseTtlMs - 100),
  );

  const env: Env = {
    port,
    host: envStr(source.HOST, '0.0.0.0'),
    tokenSecret,
    apiKeys: parseApiKeys(source.AGIL_API_KEYS),
    platformKey: envStr(source.AGIL_PLATFORM_KEY, ''),
    allowAnonymous: envBool(source.AGIL_ALLOW_ANONYMOUS, true),
    publicAbuseDefaultMode: publicAbuseModeSchema.safeParse(source.AGIL_PUBLIC_ABUSE_MODE?.trim().toLowerCase()).data ?? 'off',
    defaultTenantId: envStr(source.AGIL_DEFAULT_TENANT, 'demo'),
    dataDir,
    chatPostgresUrl: envStr(source.AGIL_CHAT_POSTGRES_URL, envStr(source.AGIL_DATABASE_URL, '')),
    staticDir: resolvePath(envStr(source.AGIL_STATIC_DIR, 'agil/websdk/demo/dist')),
    editorDir: resolvePath(envStr(source.AGIL_EDITOR_DIR, 'agil/core/apps/editor/dist')),
    dashboardDir: resolvePath(envStr(source.AGIL_DASHBOARD_DIR, 'agil/core/apps/dashboard/dist')),
    sdkDir: resolvePath(envStr(source.AGIL_SDK_DIR, 'agil/websdk/sdk/dist')),
    widgetDir: resolvePath(envStr(source.AGIL_WIDGET_DIR, 'agil/websdk/widget/dist')),
    docsDir: resolvePath(envStr(source.AGIL_DOCS_DIR, 'agil/core/docs')),
    docsDataDir: envStr(source.AGIL_DOCS_DATA_DIR, ''),
    publicOrigin,
    domainTarget: envStr(source.AGIL_DOMAIN_TARGET, hostOfOrigin(publicOrigin)),
    domainDnsTimeoutMs: envNum(source.AGIL_DOMAIN_DNS_TIMEOUT_MS, 5000, 250, 30000),
    domainAskAllowIps,
    domainAskSecret: envStr(source.AGIL_DOMAIN_ASK_SECRET, ''),
    domainAskHosts: (() => {
      const hosts = parseIpList(source.AGIL_DOMAIN_ASK_HOSTS);
      return hosts.length > 0 ? hosts.map((host) => host.trim().toLowerCase()) : ['127.0.0.1', 'localhost', '::1'];
    })(),
    domainAskRateLimitPerMin: envNum(source.AGIL_DOMAIN_ASK_RATE_LIMIT_PER_MIN, 120, 1, 100000),
    hstsMaxAgeSec: envNum(source.AGIL_HSTS_MAX_AGE_SEC, 15552000, 0, 63072000),
    hstsIncludeSubDomains: envBool(source.AGIL_HSTS_INCLUDE_SUBDOMAINS, true),
    hstsIncludeSubDomainsCustom: envBool(source.AGIL_HSTS_INCLUDE_SUBDOMAINS_CUSTOM, false),
    iceServers: parseIceServers(source.AGIL_ICE_SERVERS),
    coturnRestSecrets: parseCoturnRestSecrets(source.AGIL_COTURN_REST_SECRETS),
    coturnAutoSecrets: parseCoturnRestSecrets(source.AGIL_COTURN_AUTO_SECRETS),
    coturnRestTtlSec: envNum(source.AGIL_COTURN_REST_TTL_SEC, 3600, 300, 86400),
    iceTcpFallback: envBool(source.AGIL_ICE_TCP_FALLBACK, true),
    roomTtlSec: envNum(source.AGIL_ROOM_TTL_SEC, 0, 0, 86400),
    continuityEnabled: envBool(source.AGIL_CONTINUITY, true),
    roomSnapshotDir: resolvePath(
      envStr(source.AGIL_ROOM_SNAPSHOT_DIR, path.join(dataDir, 'rooms')),
    ),
    roomSnapshotStore:
      envStr(source.AGIL_ROOM_SNAPSHOT_STORE, 'file').toLowerCase() === 'redis' ? 'redis' : 'file',
    roomSnapshotFlushMs: envNum(source.AGIL_ROOM_SNAPSHOT_FLUSH_MS, 5_000, 0, 300_000),
    roomSnapshotMaxAgeSec: envNum(source.AGIL_ROOM_SNAPSHOT_MAX_AGE_SEC, 86_400, 60, 30 * 86_400),
    resumeGraceSec: envNum(source.AGIL_RESUME_GRACE_SEC, 20, 0, 300),
    resumeTokenTtlSec: envNum(source.AGIL_RESUME_TOKEN_TTL_SEC, 900, 60, 86_400),
    sfuNodeId: envStr(source.AGIL_SFU_NODE_ID, ''),
    tokenTtlSec: envNum(source.AGIL_TOKEN_TTL_SEC, 14400, 60, 86400),
    trustProxy: envBool(source.AGIL_TRUST_PROXY, false),
    wsOriginEnforce: envBool(source.AGIL_WS_ORIGIN_ENFORCE, true),
    wsAllowedOrigins: [...devWsOrigins, ...parseIpList(source.AGIL_WS_ALLOWED_ORIGINS)],
    geoProvider,
    geoHeaderAllow: envBool(source.AGIL_GEO_HEADER_ALLOW, false),
    ipSalt: envStr(source.AGIL_IP_SALT, 'dev-ip-salt-agil-calls'),
    fileTtlSec: envNum(source.AGIL_FILE_TTL_SEC, 86400, 60, 30 * 86400),
    maxUploadMb: envNum(source.AGIL_MAX_UPLOAD_MB, 25, 1, 200),
    maxRecordingMb: envNum(source.AGIL_MAX_RECORDING_MB, 200, 1, 2048),
    recordingsDir: resolvePath(envStr(source.AGIL_RECORDINGS_DIR, path.join(dataDir, 'recordings'))),
    sfuUrl,
    sfuControlUrl: envStr(source.AGIL_SFU_CONTROL_URL, ''),
    srtIngressSources: overrides.srtIngressSources ?? parseIngressSources(source.AGIL_SRT_INGRESS_SOURCES, 'AGIL_SRT_INGRESS_SOURCES'),
    hlsIngressSources: overrides.hlsIngressSources ?? parseIngressSources(source.AGIL_HLS_INGRESS_SOURCES, 'AGIL_HLS_INGRESS_SOURCES'),
    sfuNodeUrls: overrides.sfuNodeUrls ?? parseSfuNodeUrls(source.AGIL_SFU_NODE_URLS),
    sfuApiKey,
    sfuApiSecret,
    // Enabled by default (auto); real readiness additionally requires a resolvable
    // URL + API key/secret from env or the tenant scale.sfu config.
    sfuEnabled: envBool(source.AGIL_SFU_ENABLED, true),
    sfuProfile,
    e2eeSecret: envStr(source.AGIL_E2EE_SECRET, ''),
    scimToken: envStr(source.AGIL_SCIM_TOKEN, ''),
    adminSessionTtlSec: envNum(source.AGIL_ADMIN_SESSION_TTL_SEC, 900, 120, 86400),
    oidcStateTtlSec: envNum(source.AGIL_OIDC_STATE_TTL_SEC, 600, 1, 3600),
    oidcCookieBinding: envBool(source.AGIL_OIDC_COOKIE_BINDING, true),
    oidcClientSecrets: parseOidcClientSecrets(source),
    oidcTenantSecrets: parseOidcTenantSecrets(source[OIDC_TENANT_SECRETS_ENV]),
    tenantSecretEnv: parseTenantSecretEnv(source),
    egressUrl: envStr(source.AGIL_EGRESS_URL, '').replace(/\/+$/, ''),
    egressApiKey: envStr(source.AGIL_EGRESS_API_KEY, sfuApiKey),
    egressApiSecret: envStr(source.AGIL_EGRESS_API_SECRET, sfuApiSecret),
    egressEnabled: envBool(source.AGIL_EGRESS_ENABLED, true),
    egressHealthUrl: envStr(source.AGIL_EGRESS_HEALTH_URL, '').replace(/\/+$/, ''),
    egressPlaybackEnabled: envBool(source.AGIL_EGRESS_PLAYBACK_ENABLED, true),
    egressPlaybackBackend,
    egressArchiveDeleteEnabled: envBool(source.AGIL_EGRESS_ARCHIVE_DELETE_ENABLED, false),
    egressPlaybackSecret: envStr(source.AGIL_EGRESS_PLAYBACK_SECRET, tokenSecret),
    egressPlaybackTtlSec: envNum(source.AGIL_EGRESS_PLAYBACK_TTL_SEC, 900, 60, 86400),
    egressPlaybackDir: envStr(source.AGIL_EGRESS_PLAYBACK_DIR, ''),
    // The app reads the same bucket egress writes to; `AGIL_EGRESS_S3_*` is
    // preferred over bare `EGRESS_S3_*`, which keeps a single lab `.env` reusable.
    egressS3Endpoint: envStr(source.AGIL_EGRESS_S3_ENDPOINT, envStr(source.EGRESS_S3_ENDPOINT, '')),
    egressS3Region: envStr(source.AGIL_EGRESS_S3_REGION, envStr(source.EGRESS_S3_REGION, 'ru-msk')),
    egressS3Bucket: envStr(source.AGIL_EGRESS_S3_BUCKET, envStr(source.EGRESS_S3_BUCKET, '')),
    egressS3AccessKey: envStr(source.AGIL_EGRESS_S3_ACCESS_KEY, envStr(source.EGRESS_S3_ACCESS_KEY, '')),
    egressS3SecretKey: envStr(source.AGIL_EGRESS_S3_SECRET_KEY, envStr(source.EGRESS_S3_SECRET_KEY, '')),
    egressS3ForcePathStyle:
      source.AGIL_EGRESS_S3_FORCE_PATH_STYLE !== undefined
        ? envBool(source.AGIL_EGRESS_S3_FORCE_PATH_STYLE, true)
        : envBool(source.EGRESS_S3_FORCE_PATH_STYLE, true),
    egressStuckAfterSec: envNum(source.AGIL_EGRESS_STUCK_AFTER_SEC, 14400, 60, 172800),
    // SIP/PSTN is opt-in: `AGIL_SIP_ENABLED=0` by default, and readiness also
    // requires a URL + API key/secret (same LiveKit keys by default).
    sipUrl: envStr(source.AGIL_SIP_URL, '').replace(/\/+$/, ''),
    sipApiKey: envStr(source.AGIL_SIP_API_KEY, sfuApiKey),
    sipApiSecret: envStr(source.AGIL_SIP_API_SECRET, sfuApiSecret),
    sipEnabled: envBool(source.AGIL_SIP_ENABLED, false),
    sttUrl,
    sttKey: envStr(source.AGIL_STT_KEY, ''),
    sttModel: envStr(source.AGIL_STT_MODEL, 'whisper-1'),
    sttProvider,
    sttLocalEngine: (() => {
      const raw = envStr(source.STT_LOCAL_ENGINE, 'auto').toLowerCase();
      return raw === 'whisper-cpp' || raw === 'faster-whisper' ? raw : 'auto';
    })(),
    sttLocalBinary: envStr(source.STT_LOCAL_BINARY, 'whisper-cli'),
    sttLocalModelPath: envStr(source.STT_LOCAL_MODEL_PATH, ''),
    sttLocalModel: envStr(source.STT_LOCAL_MODEL, 'small'),
    sttLocalPython: envStr(source.STT_LOCAL_PYTHON, process.platform === 'win32' ? 'python' : 'python3'),
    sttLocalWorker: envStr(source.STT_LOCAL_WORKER, ''),
    sttLocalThreads: envNum(source.STT_LOCAL_THREADS, 4, 1, 32),
    sttLocalGpu: envBool(source.STT_LOCAL_GPU, false),
    sttLocalTimeoutMs: envNum(source.STT_LOCAL_TIMEOUT_MS, 120000, 5000, 600000),
    sttLocalFfmpeg: envStr(source.STT_LOCAL_FFMPEG, ''),
    localModelsAllowDownload: envBool(source.AGIL_STT_ALLOW_DOWNLOAD, false),
    translateProvider,
    translateLocalEngine: (() => {
      const raw = envStr(source.TRANSLATE_LOCAL_ENGINE, 'auto').toLowerCase();
      return raw === 'opus-mt' || raw === 'marian' || raw === 'nllb' ? raw : 'auto';
    })(),
    translateLocalModelDir: envStr(source.TRANSLATE_LOCAL_MODEL_DIR, ''),
    translateLocalModel: envStr(source.TRANSLATE_LOCAL_MODEL, ''),
    translateLocalPython: envStr(source.TRANSLATE_LOCAL_PYTHON, process.platform === 'win32' ? 'python' : 'python3'),
    translateLocalWorker: envStr(source.TRANSLATE_LOCAL_WORKER, ''),
    translateLocalTimeoutMs: envNum(source.TRANSLATE_LOCAL_TIMEOUT_MS, 60000, 1000, 300000),
    translateLocalGpu: envBool(source.TRANSLATE_LOCAL_GPU, false),
    translateLocalMaxChars: envNum(source.TRANSLATE_LOCAL_MAX_CHARS, 800, 100, 4000),
    translateLlmProvider: (() => {
      const raw = envStr(source.TRANSLATE_LLM_PROVIDER, '').toLowerCase();
      return raw === 'openai-compatible' || raw === 'anthropic' || raw === 'ollama' ? raw : '';
    })(),
    translateLlmUrl: envStr(source.TRANSLATE_LLM_URL, ''),
    translateLlmKey: envStr(source.TRANSLATE_LLM_KEY, ''),
    translateLlmModel: envStr(source.TRANSLATE_LLM_MODEL, ''),
    translateLlmTimeoutMs: envNum(source.TRANSLATE_LLM_TIMEOUT_MS, 20000, 1000, 120000),
    privacyMode,
    transcriptRetentionSec: envNum(
      source.TRANSCRIPT_RETENTION_SEC ?? source.AGIL_TRANSCRIPT_RETENTION_SEC,
      0,
      0,
      30 * 86400,
    ),
    transcriptConsentRequired: envBool(
      source.TRANSCRIPT_CONSENT_REQUIRED ?? source.AGIL_TRANSCRIPT_CONSENT_REQUIRED,
      false,
    ),
    integrityUrl,
    integrityKey: envStr(source.AGIL_INTEGRITY_KEY, ''),
    clamavHost: envStr(source.AGIL_CLAMAV_HOST, ''),
    clamavPort: envNum(source.AGIL_CLAMAV_PORT, 3310, 1, 65535),
    clamavSocket: envStr(source.AGIL_CLAMAV_SOCKET, ''),
    clamavTimeoutMs: envNum(source.AGIL_CLAMAV_TIMEOUT_MS, 10_000, 500, 60_000),
    yaraRules: envStr(source.AGIL_YARA_RULES, ''),
    yaraBin: envStr(source.AGIL_YARA_BIN, 'yara'),
    avConcurrency: envNum(source.AGIL_AV_CONCURRENCY, 1, 1, 4),
    avQueueLimit: envNum(source.AGIL_AV_QUEUE_LIMIT, 50, 1, 1000),
    avQueueDir: resolvePath(envStr(source.AGIL_AV_QUEUE_DIR, path.join(dataDir, 'av-queue'))),
    quarantineDir: resolvePath(envStr(source.AGIL_QUARANTINE_DIR, path.join(dataDir, 'quarantine'))),
    livenessEngine:
      envStr(source.AGIL_LIVENESS_ENGINE, 'challenge').toLowerCase() === 'external' ? 'external' : 'challenge',
    livenessUrl: envStr(source.AGIL_LIVENESS_URL, '').replace(/\/+$/, ''),
    livenessKey: envStr(source.AGIL_LIVENESS_KEY, ''),
    livenessTimeoutMs: envNum(source.AGIL_LIVENESS_TIMEOUT_MS, 5000, 500, 30_000),
    livenessTtlSec: envNum(source.AGIL_LIVENESS_TTL_SEC, 180, 30, 600),
    livenessMaxAttempts: envNum(source.AGIL_LIVENESS_MAX_ATTEMPTS, 2, 1, 10),
    aiAgentHmacSecret: envStr(source.AGIL_AI_AGENT_HMAC_SECRET, ''),
    inCallPolicyPath: envStr(source.AGIL_INCALL_POLICY_PATH, ''),
    inCallPolicyPublicKey: envStr(source.AGIL_INCALL_POLICY_PUBLIC_KEY, ''),
    deepseekApiKey: envStr(source.AGIL_DEEPSEEK_API_KEY, ''),
    deepseekModel: envStr(source.AGIL_DEEPSEEK_MODEL, 'deepseek-chat'),
    deepseekBaseUrl: envStr(source.AGIL_DEEPSEEK_BASE_URL, 'https://api.deepseek.com'),
    deepseekTimeoutMs: envNum(source.AGIL_DEEPSEEK_TIMEOUT_MS, 20000, 1000, 60000),
    webhookTimeoutMs: envNum(source.AGIL_WEBHOOK_TIMEOUT_MS, 5000, 500, 30000),
    webhookRetries: envNum(source.AGIL_WEBHOOK_RETRIES, 2, 0, 10),
    adminRateLimitPerMin: envNum(source.AGIL_ADMIN_RATE_LIMIT_PER_MIN, 120, 1, 100000),
    joinRateLimitPerMin: envNum(source.AGIL_JOIN_RATE_LIMIT_PER_MIN, 300, 1, 100000),
    lobbyTtlSec: envNum(source.AGIL_LOBBY_TTL_SEC, 600, 30, 86400),
    lobbyMax: envNum(source.AGIL_LOBBY_MAX, 50, 1, 500),
    docsEnabled: envBool(source.AGIL_DOCS_ENABLED, !isProduction()),
    docsAllowIps: parseIpList(source.AGIL_DOCS_ALLOW_IPS),
    docsPort: envNum(source.AGIL_DOCS_PORT, 0, 0, 65535),
    docsHost: envStr(source.AGIL_DOCS_HOST, envStr(source.HOST, '0.0.0.0')),
    docsRateLimitPerMin: envNum(source.AGIL_DOCS_RATE_LIMIT_PER_MIN, 120, 1, 100000),
    adminApiEnabled: envBool(source.AGIL_ADMIN_API_ENABLED, true),
    adminAllowIps: parseIpList(source.AGIL_ADMIN_ALLOW_IPS),
    enrollAllowIps: parseIpList(source.AGIL_ENROLL_ALLOW_IPS),
    heartbeatRateLimitPerMin: envNum(source.AGIL_HEARTBEAT_RATE_LIMIT_PER_MIN, 10, 1, 100_000),
    heartbeatIpRateLimitPerMin: envNum(source.AGIL_HEARTBEAT_IP_RATE_LIMIT_PER_MIN, 600, 1, 100_000),
    nodeKeyTtlSec: envNum(source.AGIL_NODE_KEY_TTL_SEC, 0, 0, 7_776_000),
    clusterRole: envStr(source.AGIL_CLUSTER_ROLE, 'leader').toLowerCase() === 'standby' ? 'standby' : 'leader',
    redisUrl: envStr(source.AGIL_REDIS_URL, '').replace(/\/+$/, ''),
    clusterId: envStr(source.AGIL_CLUSTER_ID, ''),
    clusterNodeId: envStr(source.AGIL_CLUSTER_NODE_ID, ''),
    leaderLeaseTtlMs,
    leaderRenewIntervalMs,
    leaderRetryIntervalMs: envNum(source.AGIL_LEADER_RETRY_INTERVAL_MS, 1_500, 100, 60_000),
    redisKeyPrefix: envStr(source.AGIL_REDIS_KEY_PREFIX, 'agil').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 48) || 'agil',
    flowStore: envStr(source.AGIL_FLOW_STORE, 'file').toLowerCase() === 'redis' ? 'redis' : 'file',
    mcpHttpEnabled: envBool(source.AGIL_MCP_HTTP_ENABLED, false),
    mcpHttpPort: envNum(source.AGIL_MCP_HTTP_PORT, 0, 0, 65535),
    mcpHttpToken: envStr(source.AGIL_MCP_HTTP_TOKEN, ''),
    mcpHttpAllowIps: parseIpList(source.AGIL_MCP_HTTP_ALLOW_IPS),
    mcpMode: envStr(source.AGIL_MCP_MODE, 'full').toLowerCase() === 'read' ? 'read' : 'full',
    quiet: envBool(source.AGIL_QUIET, false),
  };

  // Explicit overrides win; `false`/`0`/`''` are applied verbatim.
  for (const key of Object.keys(overrides) as Array<keyof Env>) {
    const value = overrides[key];
    if (value !== undefined) (env as unknown as Record<string, unknown>)[key] = value;
  }
  // Path-ish fields must stay absolute even when overridden with a relative path.
  for (const key of [
    'dataDir',
    'staticDir',
    'editorDir',
    'dashboardDir',
    'sdkDir',
    'widgetDir',
    'docsDir',
    'recordingsDir',
    'quarantineDir',
    'avQueueDir',
    'roomSnapshotDir',
  ] as const) {
    env[key] = resolvePath(env[key]);
  }
  // Optional local playback root: an empty value means "disabled", not ROOT_DIR.
  env.egressPlaybackDir = env.egressPlaybackDir ? resolvePath(env.egressPlaybackDir) : '';
  env.docsDataDir = env.docsDataDir ? resolvePath(env.docsDataDir) : '';
  env.publicOrigin = env.publicOrigin.replace(/\/+$/, '');
  return env;
}

/** Directories created on startup (idempotent). */
export function envDataDirs(env: Env): {
  data: string;
  audit: string;
  files: string;
  recordings: string;
  billing: string;
  quarantine: string;
  avQueue: string;
} {
  return {
    data: env.dataDir,
    audit: path.join(env.dataDir, 'audit'),
    files: path.join(env.dataDir, 'files'),
    recordings: env.recordingsDir,
    billing: path.join(env.dataDir, 'billing'),
    quarantine: env.quarantineDir,
    avQueue: env.avQueueDir,
  };
}
