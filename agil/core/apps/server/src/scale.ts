/**
 * Scale-out status, validation and TURN/ICE helpers (docs/scaling.md §2-§3, §9).
 *
 * IMPORTANT: this module implements the *contract* only: Redis pub/sub
 * multi-node orchestration, SFU integration and RTMP/HLS egress are declared as
 * configuration + status flags, not executed here. The implemented parts are the
 * generated `welcome.iceServers` (STUN + the tenant TURN pool with credentials
 * from env) and the per-room `mediaMode`/`maxParticipants` defaults.
 */
import {
  DEFAULT_SCALE,
  SFU_CAPACITY_PROFILES,
  describeTenantSecretEnv,
  effectiveMediaMode,
  iceServersFromScale,
  isAllowedTenantSecretEnv,
  isE164,
  type ClusterRegistryStatus,
  type ClusterStatusResponse,
  type IceServerConfig,
  type MediaMode,
  type NodeSummary,
  type ScaleConfig,
  type ScaleStatusResponse,
  type TenantConfig,
  type TenantSecretEnvKind,
  type TurnNodeState,
  type TurnServerConfig,
} from '@agil/protocol';
import { createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Env } from './env.js';
import { HttpError } from './http.js';
import { mediaProcessingStatus } from './media-processing.js';
import { resolveTenantSecret } from './secret-env.js';
import { applySfuCapacityProfile, effectiveSfuCapacityProfile, roomCapacityInfo, sfuConfigured as sfuReady } from './sfu.js';
import { isSecureMode, validateNetworkEndpoint } from './url-policy.js';

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,99}$/;

export interface ScaleValidationIssue {
  path: string;
  message: string;
}

/**
 * Resolves a TURN credential reference (`turn[].credentialEnv`) without ever
 * exposing it. Uses the startup snapshot and the `AGIL_TURN_*` allowlist, so a
 * tenant cannot name an arbitrary server variable.
 */
export function resolveEnvSecret(env: Env, envName: string | undefined): string | undefined {
  return resolveTenantSecret(env, envName, 'turn').value;
}

/**
 * Adds a `?transport=tcp` fallback next to every UDP `turn:` URL; `turns:` (TLS)
 * already is TCP and is left untouched.
 */
export function withTurnTcpFallback(servers: IceServerConfig[], enabled = true): IceServerConfig[] {
  if (!enabled) return servers.map((server) => ({ ...server, urls: Array.isArray(server.urls) ? [...server.urls] : server.urls }));
  const result: IceServerConfig[] = [];
  for (const server of servers) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).map(String);
    const expanded: string[] = [];
    for (const url of urls) {
      if (expanded.includes(url)) continue;
      expanded.push(url);
      if (!/^turn:/i.test(url) || /[?&]transport=tcp/i.test(url)) continue;
      const tcp = /[?&]transport=udp/i.test(url)
        ? url.replace(/([?&]transport=)udp/i, '$1tcp')
        : `${url}${url.includes('?') ? '&' : '?'}transport=tcp`;
      if (!expanded.includes(tcp)) expanded.push(tcp);
    }
    result.push({ ...server, urls: expanded.length === 1 ? expanded[0]! : expanded });
  }
  return result;
}

/** Public ICE discovery carries only STUN URLs, including entries with mixed URL arrays. */
export function resolvePublicStunServers(env: Env): IceServerConfig[] {
  return env.iceServers.flatMap((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .map((url) => url.trim())
      .filter((url) => /^stuns?:/i.test(url));
    if (urls.length === 0) return [];
    return [{ urls: urls.length === 1 ? urls[0]! : urls }];
  });
}

function coturnSigningKey(secrets: Env['coturnRestSecrets'], tenantId: string, relayId: string): string | undefined {
  if (!Object.hasOwn(secrets, tenantId)) return undefined;
  const relays = secrets[tenantId];
  return relays && Object.hasOwn(relays, relayId) ? relays[relayId] : undefined;
}

const TURN_NODE_REFRESH_MS = 15_000;

/** A private, per-node signing key opts the enrolled node into automatic publication. */
function automaticTurnRelays(env: Env, scale: ScaleConfig, tenantId: string,
  readNode: (nodeId: string) => NodeSummary | null): TurnServerConfig[] {
  if (!Object.hasOwn(env.coturnAutoSecrets, tenantId)) return [];
  const configured = new Set(scale.turn.flatMap(({ id, nodeId }) => nodeId ? [id, nodeId] : [id]));
  return Object.keys(env.coturnAutoSecrets[tenantId] ?? {}).flatMap((nodeId) => {
    if (configured.has(nodeId)) return [];
    const node = readNode(nodeId);
    const endpoint = node?.status === 'online' && node.turnReady && node.automaticTurnVerified ? node.turnEndpoint : undefined;
    const urls: string[] = [];
    if (endpoint?.credentialMode === 'rest') {
      urls.push(`turn:${endpoint.ip}:${endpoint.port}`, `turn:${endpoint.ip}:${endpoint.port}?transport=tcp`);
      if (endpoint.tlsHostname && endpoint.tlsPort) urls.push(`turns:${endpoint.tlsHostname}:${endpoint.tlsPort}?transport=tcp`);
    }
    return [{ id: nodeId, nodeId, urls, credentialMode: 'rest', username: '', credentialEnv: '', region: node?.region ?? '', weight: 100 }];
  });
}

/** STUN and TURN for a joined participant, with coturn-compatible temporary credentials where configured. */
export function resolveParticipantIce(
  env: Env,
  scale: ScaleConfig | undefined,
  identity: { tenantId: string; roomId: string; participantId: string },
  now = Date.now(),
  isTurnNodeAvailable?: (tenantId: string, nodeId: string) => boolean,
  readNode?: (tenantId: string, nodeId: string) => NodeSummary | null,
): { iceServers: IceServerConfig[]; refreshAt?: number } {
  const result = withTurnTcpFallback(env.iceServers, env.iceTcpFallback);
  if (!scale) return { iceServers: result };
  const endpointKey = (url: string, groupTransports = false): string | undefined => {
    const endpoint = parseTurnEndpoint(url);
    if (!endpoint || !/^turns?:/i.test(url.trim())) return undefined;
    const transport = groupTransports && endpoint.protocol !== 'tls' ? 'plain' : endpoint.protocol;
    return `${transport}/${endpoint.host.toLowerCase()}/${endpoint.port}`;
  };
  const automatic = readNode ? automaticTurnRelays(env, scale, identity.tenantId, (id) => readNode(identity.tenantId, id)) : [];
  const automaticIds = new Set(automatic.map(({ id }) => id));
  const bound = [...scale.turn.filter((relay) => relay.nodeId !== undefined), ...automatic];
  const boundEndpoints = new Set(bound.flatMap((relay) => relay.urls.map((url) => endpointKey(url, true))));
  boundEndpoints.delete(undefined);
  const filterUnboundUrls = (urls: string[]) => urls.filter((url) => !boundEndpoints.has(endpointKey(url, true)));
  const relays = scale.turn.flatMap((relay) => {
    if (relay.nodeId !== undefined) return isTurnNodeAvailable?.(identity.tenantId, relay.nodeId) ? [relay] : [];
    const urls = filterUnboundUrls(relay.urls);
    return urls.length > 0 ? [{ ...relay, urls }] : [];
  });
  relays.push(...automatic.filter(({ urls }) => urls.length > 0));
  const rest = relays.filter((relay) => relay.credentialMode === 'rest');
  const restEndpoints = new Set(
    withTurnTcpFallback(rest, env.iceTcpFallback)
      .flatMap((server) => [server.urls].flat().map((url) => endpointKey(url))),
  );
  restEndpoints.delete(undefined);
  const staticPool = iceServersFromScale({ ...scale, turn: relays.filter((relay) => relay.credentialMode !== 'rest') },
    [], (envName) => resolveEnvSecret(env, envName));
  const restPool = iceServersFromScale({ ...scale, turn: rest }, [], undefined, (relay) => {
    const secrets = automaticIds.has(relay.id) ? env.coturnAutoSecrets : env.coturnRestSecrets;
    const key = coturnSigningKey(secrets, identity.tenantId, relay.id);
    if (!key) return undefined;
    const pseudonym = createHmac('sha256', key)
      .update(JSON.stringify([identity.tenantId, identity.roomId, identity.participantId]))
      .digest('hex').slice(0, 24);
    const username = `${Math.floor(now / 1000) + env.coturnRestTtlSec}:${pseudonym}`;
    return { username, credential: createHmac('sha1', key).update(username).digest('base64') };
  });
  const withoutSupersededTurn = (server: IceServerConfig, unbound: boolean): IceServerConfig[] => {
    const original = [server.urls].flat();
    const urls = (unbound ? filterUnboundUrls(original) : original).filter((url) => !restEndpoints.has(endpointKey(url)));
    if (urls.length === 0) return [];
    if (urls.length === original.length) return [server];
    const survivingUrls = urls.length === 1 ? urls[0]! : urls;
    return urls.some((url) => /^turns?:/i.test(url.trim()))
      ? [{ ...server, urls: survivingUrls }]
      : [{ urls: survivingUrls }];
  };
  const combined = result.flatMap((server) => withoutSupersededTurn(server, true));
  const staticServers = withTurnTcpFallback(staticPool, env.iceTcpFallback)
    .flatMap((server) => withoutSupersededTurn(server, false));
  const refreshDelays = [
    ...(restPool.length > 0 ? [env.coturnRestTtlSec * 500] : []),
    ...(bound.length > 0 ? [TURN_NODE_REFRESH_MS] : []),
  ];
  for (const server of [...staticServers, ...withTurnTcpFallback(restPool, env.iceTcpFallback)]) {
    const key = JSON.stringify(server.urls);
    if (!combined.some((existing) => JSON.stringify(existing.urls) === key)) combined.push(server);
  }
  return {
    iceServers: combined,
    ...(refreshDelays.length > 0 ? { refreshAt: now + Math.min(...refreshDelays) } : {}),
  };
}

function nodeStatus(scale: ScaleConfig): ScaleStatusResponse['cluster']['nodes'] {
  return scale.signaling.nodes.map((node) => ({
    id: node.id,
    url: node.url,
    region: node.region,
    weight: node.weight,
    healthy: node.healthy ?? null,
    note: 'node registry only: health probing and ownership are not implemented in the single-node MVP',
  }));
}

/** Builds the admin scale status (no secrets, only configured flags). */
export function scaleStatus(
  env: Env,
  config: TenantConfig,
  getTurnNodeState?: (nodeId: string) => TurnNodeState,
  readNode?: (nodeId: string) => NodeSummary | null,
): ScaleStatusResponse & {
  mediaProcessing: {
    mode: string; serverProcessingActive: boolean; sfuForwardingOnly: boolean;
    egressConfigured: boolean; misconfigured: boolean; e2eeConfigured: boolean; e2eeActive: boolean;
  };
} {
  const scale = config.scale ?? DEFAULT_SCALE;
  const automatic = readNode ? automaticTurnRelays(env, scale, config.tenantId, readNode) : [];
  const automaticIds = new Set(automatic.map(({ id }) => id));
  const turn = [...scale.turn, ...automatic].map((server) => {
    const discovered = automaticIds.has(server.id);
    const reported = server.nodeId ? getTurnNodeState?.(server.nodeId) : undefined;
    const nodeState = discovered && reported === 'ready' && !server.urls.length ? 'turn_endpoint_missing' : reported;
    return {
      id: server.id,
      ...(discovered ? { automatic: true } : {}),
      ...(server.nodeId ? { nodeId: server.nodeId } : {}),
      ...(nodeState ? { nodeState, nodeAvailable: nodeState === 'ready' } : {}),
      urls: server.urls,
      region: server.region,
      weight: server.weight,
      credentialMode: server.credentialMode ?? 'static',
      usernameConfigured: server.credentialMode === 'rest' || server.username.trim().length > 0,
      credentialConfigured: Boolean(server.credentialMode === 'rest'
        ? coturnSigningKey(discovered ? env.coturnAutoSecrets : env.coturnRestSecrets, config.tenantId, server.id)
        : resolveEnvSecret(env, server.credentialEnv)),
    };
  });
  // Real readiness: env (AGIL_SFU_*) or tenant scale config + resolvable keys.
  const sfuConfigured = sfuReady(env, config);
  // Effective client capacity profile: env wins over `scale.sfu.capacityProfile`.
  const sfuProfile = effectiveSfuCapacityProfile(env, config);
  const sfuCapacity = SFU_CAPACITY_PROFILES[sfuProfile];
  const mediaMode = effectiveMediaMode(scale);
  // Room creation/join cap for a default group room: min(scale.maxParticipants,
  // profile participants, sfu.maxParticipants), so the status never promises
  // more seats than the media plane can carry.
  const capacity = roomCapacityInfo(env, config, mediaMode, scale.maxParticipants);
  const media = mediaProcessingStatus(config, env);
  const limitations = [
    'cluster: Redis leader lease/elect is implemented; room-state replication, pub/sub broadcast, per-room ownership and sticky redirect are not (docs/ha-leader.md)',
    'sfu: LiveKit-compatible media sessions are issued for sfu/broadcast modes; the media server itself is deployed separately',
    'webinar: broadcast mode is config/UI-gated only (no receive-only media enforcement)',
    'streaming: room RTMP/HLS output requires a separate Egress worker; WHEP playback requires a configured WebRTC endpoint',
    'turn: pool is advertised to clients; allocation health is not probed automatically',
    'sip: optional LiveKit SIP control plane; trunks/DIDs/dispatch rules and the PSTN carrier are deployed separately',
    `large rooms: effective room cap = min(room.maxParticipants, scale.maxParticipants, capacity profile participants, sfu.maxParticipants) = ${capacity.effectiveMaxParticipants} for a default room (binding limit: ${capacity.limit}). Gallery pagination supports up to 200 participants, but a client subscribes an adaptive video budget (all visible videos up to 8 participants, then the capacity profile budget — profile=${sfuProfile}, ${sfuCapacity.remoteVideosPerClient} remote videos — with pinned + active speaker first), capped by scale.maxVideoSubscriptions (default 36). The profile (AGIL_SFU_PROFILE or scale.sfu.capacityProfile) describes the deployed SFU; 200 simultaneous HD videos are not supported — size the SFU node per docs/large-rooms.md`,
  ];
  return {
    // Surface the effective profile in the config the status returns.
    config: applySfuCapacityProfile(env, config).scale,
    mediaMode,
    effectiveMaxParticipants: capacity.effectiveMaxParticipants,
    capacity,
    cluster: {
      nodeId: scale.signaling.nodeId,
      nodes: nodeStatus(scale),
      strategy: scale.loadBalancer.strategy,
      redisConfigured: Boolean(scale.signaling.redisUrl.trim()),
      stickySessions: scale.signaling.stickySessions,
    },
    turn,
    sfuConfigured,
    sfuProfile,
    sfuCapacity,
    mediaProcessing: {
      mode: media.policy.mode,
      serverProcessingActive: media.serverProcessingActive,
      sfuForwardingOnly: media.sfuForwardingOnly,
      egressConfigured: media.egressConfigured,
      misconfigured: media.misconfigured,
      e2eeConfigured: media.e2eeConfigured,
      e2eeActive: media.e2eeActive,
    },
    webinarEnabled: scale.webinar.enabled,
    streamingProvider: scale.streaming.enabled ? scale.streaming.provider : 'none',
    limitations,
  };
}

/**
 * Cluster status: the tenant's configured signaling nodes plus, when provided,
 * the enrollment registry (cluster identity, enrolled nodes, standby Cores).
 * `multiNodeActive` stays false: multi-node pub/sub is not implemented.
 */
export function clusterStatus(
  env: Env,
  config: TenantConfig,
  registry?: ClusterRegistryStatus,
): ClusterStatusResponse {
  const scale = config.scale ?? DEFAULT_SCALE;
  void env;
  const base: ClusterStatusResponse = {
    nodeId: scale.signaling.nodeId,
    nodes: nodeStatus(scale),
    strategy: scale.loadBalancer.strategy,
    redisConfigured: Boolean(scale.signaling.redisUrl.trim()),
    stickySessions: scale.signaling.stickySessions,
    multiNodeActive: false,
  };
  return registry ? { ...base, ...registry } : base;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function checkNetworkUrl(
  raw: string,
  path: string,
  schemes: readonly string[],
  options: { secure: boolean; applyHostPolicy: boolean },
  issues: ScaleValidationIssue[],
): void {
  const value = raw.trim();
  if (!value) return;
  const result = validateNetworkEndpoint(value, {
    secure: options.secure,
    schemes,
    applyHostPolicy: options.applyHostPolicy,
  });
  if (!result.ok) issues.push({ path, message: result.reason });
}

function checkEnvName(
  raw: string,
  path: string,
  kind: TenantSecretEnvKind,
  issues: ScaleValidationIssue[],
  optional = true,
): void {
  const value = raw.trim();
  if (!value) {
    if (!optional) issues.push({ path, message: 'Environment variable name is required' });
    return;
  }
  if (!ENV_NAME_RE.test(value) || !isAllowedTenantSecretEnv(value, kind)) {
    issues.push({
      path,
      message: `Must be an environment variable name in the ${describeTenantSecretEnv(kind)} namespace`,
    });
  }
}

/** Validates a (merged) scale config before it is persisted. Throws 400. */
export function validateScale(env: Env, scale: ScaleConfig): void {
  const issues: ScaleValidationIssue[] = [];
  const secure = isSecureMode(env);

  for (const [index, node] of scale.signaling.nodes.entries()) {
    if (!node.url.trim()) issues.push({ path: `signaling.nodes.${index}.url`, message: 'URL is required' });
    checkNetworkUrl(node.url, `signaling.nodes.${index}.url`, ['https:', 'http:'], { secure, applyHostPolicy: true }, issues);
    if (!node.id.trim()) issues.push({ path: `signaling.nodes.${index}.id`, message: 'Node id is required' });
  }
  if (scale.signaling.redisUrl.trim()) {
    checkNetworkUrl(scale.signaling.redisUrl, 'signaling.redisUrl', ['redis:', 'rediss:'], { secure, applyHostPolicy: true }, issues);
  }
  checkEnvName(scale.sfu.apiKeyEnv, 'sfu.apiKeyEnv', 'sfu', issues);
  checkEnvName(scale.sfu.apiSecretEnv, 'sfu.apiSecretEnv', 'sfu', issues);
  checkNetworkUrl(scale.sfu.url, 'sfu.url', ['https:', 'wss:', 'http:', 'ws:'], { secure, applyHostPolicy: true }, issues);
  for (const [index, server] of scale.turn.entries()) {
    if (!server.id.trim()) issues.push({ path: `turn.${index}.id`, message: 'TURN server id is required' });
    checkEnvName(server.credentialEnv, `turn.${index}.credentialEnv`, 'turn', issues);
    if (server.urls.length === 0) issues.push({ path: `turn.${index}.urls`, message: 'At least one URL is required' });
    for (const [urlIndex, rawUrl] of server.urls.entries()) {
      if (!rawUrl.trim()) {
        issues.push({ path: `turn.${index}.urls.${urlIndex}`, message: 'URL is required' });
        continue;
      }
      checkNetworkUrl(
        rawUrl,
        `turn.${index}.urls.${urlIndex}`,
        server.credentialMode === 'rest' ? ['turn:', 'turns:'] : ['turn:', 'turns:', 'stun:', 'stuns:'],
        // TURN endpoints are advertised to browsers, never fetched by the server,
        // so private/corporate TURN hosts are intentionally allowed.
        { secure, applyHostPolicy: false },
        issues,
      );
    }
  }
  checkNetworkUrl(scale.streaming.rtmpUrl, 'streaming.rtmpUrl', ['rtmp:', 'rtmps:'], { secure, applyHostPolicy: false }, issues);
  checkNetworkUrl(scale.streaming.hlsUrl, 'streaming.hlsUrl', ['https:', 'http:'], { secure, applyHostPolicy: true }, issues);
  checkNetworkUrl(scale.streaming.whepUrl, 'streaming.whepUrl', ['https:', 'http:'], { secure, applyHostPolicy: true }, issues);
  if (scale.streaming.enabled && scale.streaming.playbackProtocol === 'whep' && !scale.streaming.whepUrl.trim()) {
    issues.push({ path: 'streaming.whepUrl', message: 'A WHEP playback URL is required when WHEP is selected' });
  }
  checkNetworkUrl(scale.cdn.baseUrl, 'cdn.baseUrl', ['https:', 'http:'], { secure, applyHostPolicy: true }, issues);
  // SIP: httpUrl is called by this server (apply the SSRF host policy); wsUrl is
  // advertised to clients (a private/corporate SFU is legitimate), TLS still
  // required in production mode.
  checkNetworkUrl(scale.sip.wsUrl, 'sip.wsUrl', ['https:', 'wss:', 'http:', 'ws:'], { secure, applyHostPolicy: false }, issues);
  checkNetworkUrl(scale.sip.httpUrl, 'sip.httpUrl', ['https:', 'http:'], { secure, applyHostPolicy: true }, issues);
  if (scale.sip.trunkId.trim() && !/^[A-Za-z0-9._-]{1,120}$/.test(scale.sip.trunkId.trim())) {
    issues.push({ path: 'sip.trunkId', message: 'Must contain only letters, digits, dot, dash or underscore' });
  }
  if (scale.sip.enabled && !scale.sip.trunkId.trim()) {
    issues.push({ path: 'sip.trunkId', message: 'Trunk id is required when SIP is enabled' });
  }
  for (const [index, number] of scale.sip.dialInNumbers.entries()) {
    if (!isE164(number)) issues.push({ path: `sip.dialInNumbers.${index}`, message: 'Must be an E.164 number (+<country><number>)' });
  }
  if (scale.sip.callerId.trim() && !isE164(scale.sip.callerId.trim())) {
    issues.push({ path: 'sip.callerId', message: 'Must be an E.164 number (+<country><number>)' });
  }

  if (issues.length > 0) {
    throw new HttpError(400, 'validation_failed', 'Invalid scale configuration', issues);
  }
}

/** Deep merge for a partial ScaleConfig (arrays replace, objects merge). */
export function mergeScale(base: ScaleConfig, patch: unknown): ScaleConfig {
  const patchRecord = patch && typeof patch === 'object' && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
  const merged = deepMerge(base as unknown as Record<string, unknown>, patchRecord);
  return merged as unknown as ScaleConfig;
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (Array.isArray(value)) {
      result[key] = value;
    } else if (value && typeof value === 'object' && current && typeof current === 'object' && !Array.isArray(current)) {
      result[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* TURN test (configuration check, no real allocate)                   */
/* ------------------------------------------------------------------ */

export interface TurnTestResponse {
  id: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

/** Configuration-level TURN check: URL scheme, username and credential env. */
const TURN_PROBE_TIMEOUT_MS = 900;

function stunBindingRequest(): Buffer {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0); // Binding Request
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(0x2112a442, 4); // magic cookie
  randomBytes(12).copy(request, 8); // transaction id
  return request;
}

interface TurnProbeResult {
  url: string;
  protocol: 'udp' | 'tcp' | 'tls';
  ok: boolean;
  latencyMs: number;
  detail: string;
}

function probeTurnUdp(host: string, port: number): Promise<TurnProbeResult> {
  return new Promise((resolve) => {
    const url = `${host}:${port}`;
    const started = Date.now();
    const socket = createSocket('udp4');
    let finished = false;
    const finish = (ok: boolean, detail: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve({ url, protocol: 'udp', ok, latencyMs: Date.now() - started, detail });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), TURN_PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.once('error', (error) => finish(false, error.message));
    socket.once('message', () => finish(true, 'STUN response'));
    socket.send(stunBindingRequest(), port, host, (error) => {
      if (error) finish(false, error.message);
    });
  });
}

function probeTurnTcp(host: string, port: number, secure: boolean): Promise<TurnProbeResult> {
  return new Promise((resolve) => {
    const url = `${host}:${port}`;
    const started = Date.now();
    let finished = false;
    const socket = secure
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: false })
      : netConnect({ host, port });
    const finish = (ok: boolean, detail: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ url, protocol: secure ? 'tls' : 'tcp', ok, latencyMs: Date.now() - started, detail });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), TURN_PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      try { socket.write(stunBindingRequest()); } catch { /* connect itself proves reachability */ }
      finish(true, secure ? 'TLS connect' : 'TCP connect');
    });
    socket.once('error', (error) => finish(false, error.message));
  });
}

function parseTurnEndpoint(url: string): { host: string; port: number; protocol: 'udp' | 'tcp' | 'tls' } | null {
  // `new URL()` cannot parse the opaque turn:/turns: scheme, so parse it manually.
  const match = /^(turns?|stuns?):(\[[0-9a-f:]+\]|[^:?/\s]+)(?::(\d{1,5}))?(\?[^\s]*)?$/i.exec(url.trim());
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.replace(/^\[|\]$/g, '');
  const port = match[3] ? Number(match[3]) : scheme.endsWith('s') ? 5349 : 3478;
  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) return null;
  const transport = /[?&]transport=([a-z]+)/i.exec(match[4] ?? '')?.[1]?.toLowerCase();
  const protocol: 'udp' | 'tcp' | 'tls' = scheme === 'turns' || scheme === 'stuns' ? 'tls' : transport === 'tcp' ? 'tcp' : 'udp';
  return { host, port, protocol };
}

/**
 * TURN test: validates configuration, then probes all configured URLs over the
 * real network (STUN Binding over UDP, TCP connect, TLS handshake) with a short
 * timeout. Full relay allocation requires the TURN long-term credentials and is
 * left to the media plane; this check still proves the relay is reachable and
 * that the TCP fallback works.
 */
export async function testTurnServer(env: Env, config: TenantConfig, id: string): Promise<TurnTestResponse> {
  const scale = config.scale ?? DEFAULT_SCALE;
  const server = scale.turn.find((candidate) => candidate.id === id);
  if (!server) throw new HttpError(404, 'not_found', 'TURN server not found');
  const started = Date.now();
  const problems: string[] = [];
  const secure = isSecureMode(env);
  const endpoints: Array<{ url: string; host: string; port: number; protocol: 'udp' | 'tcp' | 'tls' }> = [];
  for (const [index, url] of server.urls.entries()) {
    const endpoint = parseTurnEndpoint(url);
    if (!endpoint) {
      problems.push(`urls[${index}] is malformed or unsupported`);
      continue;
    }
    if (secure && endpoint.protocol !== 'tls') {
      problems.push(`urls[${index}] should use turns: (TLS) in production mode`);
    }
    endpoints.push({ url, ...endpoint });
  }
  if (server.credentialMode === 'rest') {
    if (!coturnSigningKey(env.coturnRestSecrets, config.tenantId, server.id)) problems.push('No coturn signing key is configured for this tenant and relay');
  } else {
    if (!server.username.trim()) problems.push('username is empty (anonymous TURN is rarely allowed)');
    if (!server.credentialEnv.trim()) problems.push('credentialEnv is not set');
    else if (!resolveEnvSecret(env, server.credentialEnv)) problems.push(`credential env ${server.credentialEnv} is not set`);
  }
  if (endpoints.length === 0) problems.push('no probeable turn:/turns: URLs');

  const probes: TurnProbeResult[] = [];
  if (problems.length === 0) {
    for (const endpoint of endpoints) {
      const probe =
        endpoint.protocol === 'udp'
          ? await probeTurnUdp(endpoint.host, endpoint.port)
          : await probeTurnTcp(endpoint.host, endpoint.port, endpoint.protocol === 'tls');
      probes.push({ ...probe, url: `${endpoint.protocol.toUpperCase()} ${endpoint.url}` });
    }
  }
  const failed = probes.filter((probe) => !probe.ok);
  const ok = problems.length === 0 && probes.length > 0 && failed.length === 0;
  const latencyMs = probes.length > 0 ? Math.max(...probes.map((probe) => probe.latencyMs)) : Date.now() - started;
  const details = problems.length > 0
    ? problems.join('; ')
    : probes.map((probe) => `${probe.url}: ${probe.ok ? 'ok' : 'failed'} ${probe.latencyMs}ms (${probe.detail})`).join('; ');
  return {
    id: server.id,
    ok,
    latencyMs,
    detail: ok
      ? `TURN relay reachable: ${details}`
      : problems.length > 0
        ? details
        : `TURN relay probe failed: ${details}`,
  };
}
/** Effective media mode helper re-exported for the server modules. */
export function roomMediaMode(scale: ScaleConfig | undefined, roomMode: 'direct' | 'group' | undefined): MediaMode {
  return effectiveMediaMode(scale ?? DEFAULT_SCALE, roomMode);
}
