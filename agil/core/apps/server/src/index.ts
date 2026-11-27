// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * AgilFrame server entry point.
 *
 * Programmatic API (used by tests, scripts/e2e.mjs and scripts/security-audit.mjs):
 *   const server = await createAgilServer({ port: 0, dataDir: tmp });
 *   ...
 *   await server.close();
 *
 * CLI: `node dist/index.js` (or `npm start`) listens on `PORT` and shuts down
 * gracefully on SIGINT/SIGTERM.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { WebSocketServer } from 'ws';
import { loadEnv, envDataDirs, type Env, type EnvOverrides } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { TenantStore } from './tenants.js';
import { DomainRegistry, type DomainDnsResolver } from './domains.js';
import { RoomRegistry, roomConfig } from './rooms.js';
import { closeSfuRoom } from './sfu.js';
import { createServices, type SecurityEngines, type Services, type SttEngines } from './services.js';
import { AnalysisPipeline } from './analysis.js';
import { ProviderRegistry } from './providers.js';
import { ClusterStore } from './cluster.js';
import { LeaderElector, resolveClusterId } from './leader.js';
import { RoomContinuity } from './continuity.js';
import { RedisClient } from './redis-client.js';
import { EgressStartLedger } from './egress-start-ledger.js';
import { createHttpHandler, createRouter, safeAudit, type AppContext } from './http.js';
import { registerPublicRoutes, SERVER_NAME, SERVER_VERSION } from './public-api.js';
import { registerAdminRoutes } from './admin-api.js';
import { registerClusterRoutes } from './cluster-api.js';
import { registerEdgeRoutes } from './edge-api.js';
import { FlowStore } from './flow-store.js';
import { FlowService } from './flows.js';
import { RtmpIngressLifecycle, PullIngressLifecycle } from './ingress-lifecycle.js';
import { IngressOwnershipStore } from './ingress-ownership.js';
import { RtmpIngressClient, PullIngressClient } from './ingress.js';
import { RoutingService, RoutingStore } from './routing.js';
import { registerDocsRoutes } from './openapi.js';
import { registerSipRoutes } from './sip.js';
import { registerVoiceChannelRoutes } from './voice-channels.js';
import { createSignalingServer, WS_PATH, type SignalingServer } from './signaling.js';
import { serveStatic, staticMounts } from './static.js';
import { assertConfigEndpoints, checkEnvExternalUrl } from './url-policy.js';

export { createOpenApiSpec } from './openapi.js';
export { DomainRegistry, parseDomain, hostFromHeader, DomainConflictError } from './domains.js';
export type { DomainDnsResolver, DomainRecord, DomainStatus } from './domains.js';
export type { AppContext, RequestContext } from './http.js';
export type { Env, EnvOverrides } from './env.js';
export type { SignalingServer } from './signaling.js';
export { ClusterStore } from './cluster.js';
export { LeaderElector } from './leader.js';
export type { LeaderSnapshot, LeadershipGate } from './leader.js';
export { RoomContinuity } from './continuity.js';
export type {
  RoomSnapshot,
  RoomSnapshotStore,
  RoomSnapshotMember,
  RestoreResult,
  NodeDrainResult,
} from './continuity.js';

export interface CreateServerOptions extends EnvOverrides {
  /** Custom logger (tests use the silent one). */
  logger?: Logger;
  /** DNS resolver override for custom-domain verification (tests never hit DNS). */
  domainResolver?: DomainDnsResolver;
  /**
   * Injected AV/liveness engines (tests, self-hosted adapters). Omitted = the
   * engines are built from `AGIL_CLAMAV_*` / `AGIL_YARA_RULES` / `AGIL_LIVENESS_*`.
   */
  securityEngines?: SecurityEngines;
  /**
   * Injected local STT/translation engines (tests). Omitted = the engines are
   * built from `STT_PROVIDER` / `TRANSLATE_PROVIDER` and their model paths.
   */
  sttEngines?: SttEngines;
}

export interface AgilServer {
  port: number;
  url: string;
  env: Env;
  server: HttpServer;
  httpServer: HttpServer;
  /** WebSocketServer alias (both names are exposed for convenience). */
  ws: WebSocketServer;
  wss: WebSocketServer;
  registry: RoomRegistry;
  rooms: RoomRegistry;
  tenants: TenantStore;
  /** Verified custom-domain registry (host -> tenant + DNS verification). */
  domains: DomainRegistry;
  services: Services;
  analysis: AnalysisPipeline;
  providers: ProviderRegistry;
  /** Enrollment tokens + node/standby registry (docs/api/cluster.md). */
  cluster: ClusterStore;
  /** Routing baseline: routes, Edge enrollment, room/Edge → stream egress. */
  routing: RoutingService;
  /** Generic media flows: sources → processors → sinks, triggers, fallback. */
  flows: FlowService;
  /** Redis leader lease / failover state machine (docs/ha-leader.md). */
  leader: LeaderElector;
  /** Room snapshot persistence + resume leases (docs/call-continuity.md). */
  continuity: RoomContinuity;
  docsServer?: HttpServer | null;
  docsPort?: number;
  close(): Promise<void>;
}

/** Builds and starts the full server (HTTP + WS + static + admin/docs). */
export async function createAgilServer(options: CreateServerOptions = {}): Promise<AgilServer> {
  const { logger: providedLogger, domainResolver, securityEngines, sttEngines, ...overrides } = options;
  const env = loadEnv(overrides);
  const logger = providedLogger ?? createLogger({ quiet: env.quiet, scope: 'server' });
  const startedAt = Date.now();

  for (const [name, value] of [
    ['AGIL_INTEGRITY_URL', env.integrityUrl],
    ['AGIL_STT_URL', env.sttUrl],
    ['AGIL_LIVENESS_URL', env.livenessEngine === 'external' ? env.livenessUrl : ''],
  ] as const) {
    const warning = value ? checkEnvExternalUrl(env, value, name) : null;
    if (warning) logger.warn('invalid external endpoint in env — feature will not be used', { warning });
  }

  const tenants = new TenantStore({
    dir: path.join(env.dataDir, 'tenants'),
    initialTenants: [...new Set([...Object.values(env.apiKeys), env.defaultTenantId])],
    validateConfig: (config) => assertConfigEndpoints(config, env),
  });
  const domains = new DomainRegistry({
    file: path.join(env.dataDir, 'domains.json'),
    publicHost: env.domainTarget,
    ...(domainResolver ? { resolver: domainResolver } : {}),
    timeoutMs: env.domainDnsTimeoutMs,
  });
  // Seed the domain registry from existing `branding.customDomain` values and
  // keep the mapping in sync with every config write.
  for (const tenantId of tenants.listTenants()) {
    const config = tenants.peekConfig(tenantId);
    const customDomain = config?.branding.customDomain ?? '';
    if (customDomain) domains.syncTenant(tenantId, customDomain);
  }
  tenants.subscribeAll((config, tenantId) => {
    domains.syncTenant(tenantId, config.branding.customDomain);
  });
  // The registry is created before integrations so they can enforce node readiness.
  let onDrainChange: ((change: { tenantId: string; nodeId: string; drain: boolean }) => void) | null = null;
  const cluster = new ClusterStore({
    env,
    dataDir: env.dataDir,
    version: SERVER_VERSION,
    logger: logger.child('cluster'),
    onDrainChange: (change) => {
      try {
        onDrainChange?.(change);
      } catch {
        /* continuity marker is best-effort */
      }
    },
  });
  const services = createServices(env, {
    logger,
    getConfig: (tenantId) => tenants.getConfig(tenantId),
    getConfigIfExists: (tenantId) => tenants.peekConfig(tenantId),
    isManagedNodeAvailable: (tenantId, nodeId, moduleId) =>
      cluster.getNode(tenantId, nodeId)?.availableModules?.includes(moduleId) === true,
    ...(securityEngines ? { securityEngines } : {}),
    ...(sttEngines ? { sttEngines } : {}),
  });
  const rooms = new RoomRegistry({
    defaultTtlSec: env.roomTtlSec,
    maxDurationMs: (room) => roomConfig(room, tenants.getConfig(room.tenantId)).limits.maxDurationMin * 60_000,
    onSfuRoomClose: async ({ tenantId, id: roomId }) => {
      try {
        if (!await closeSfuRoom(env, tenantId, roomId)) {
          logger.warn('LiveKit control endpoint is not configured for room closure', { tenantId, roomId });
        }
      } catch {
        logger.warn('LiveKit room cleanup failed', { tenantId, roomId });
      }
    },
    // Billing metering subscribes to room lifecycle events (create/join/leave/close).
    onRoomEvent: (event) => {
      services.billing.observe(event);
      if (event.type === 'closed') {
        const config = tenants.peekConfig(event.room.tenantId);
        services.conversationReview.closeRoom(event.room,
          Boolean(event.reason !== 'tenant_deleted' && config && !roomConfig(event.room, config).security.e2ee));
      }
      if (event.type === 'closed' && event.reason === 'duration_expired') {
        const { tenantId, id: roomId } = event.room;
        safeAudit(logger, services.audit, {
          type: 'room.closed', severity: 'info', tenantId, roomId,
          message: 'Meeting time limit reached', details: { reason: event.reason },
        });
        services.webhooks.emit('room.closed', { tenantId, roomId }, { reason: event.reason });
      }
    },
  });
  tenants.subscribeAll((config, tenantId) => {
    for (const room of rooms.list(tenantId)) {
      if (config.session.chat.historyStorage !== 'session') room.messages.length = 0;
      const effective = roomConfig(room, config);
      if (effective.security.e2ee || !effective.features.captions) services.conversationReview.configure(room, { enabled: false });
    }
  });
  const analysis = new AnalysisPipeline({ env, logger: logger.child('analysis'), chatHistory: services.chatHistory,
    chatMode: (tenantId) => tenants.getConfig(tenantId).session.chat.historyStorage });
  const analysisRetentionTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.list()) {
      if (room.hasAnalysis) room.pruneAnalysis(roomConfig(room, tenants.getConfig(room.tenantId)).session.aiAgent.retentionMin, now);
      services.conversationReview.sweep(room);
    }
    services.conversationReview.sweep();
  }, 30_000);
  analysisRetentionTimer.unref?.();
  // Generic media flows (`docs/flows.md`): tenant-scoped source→processor→sink
  // graphs with live triggers. Redis can hold definitions across Core disks.
  let leaderRef: LeaderElector | null = null;
  let managedRtmp: RtmpIngressLifecycle | undefined;
  const managedPull: Partial<Record<'srt' | 'hls', PullIngressLifecycle>> = {};
  const flowStore = new FlowStore({
    dir: path.join(env.dataDir, 'flows'),
    ...(env.flowStore === 'redis' ? { shared: () => leaderRef, configuredTenants: () => tenants.listTenants() } : {}),
    ...(env.flowStore === 'file' && env.redisUrl ? { fileLease: () => leaderRef } : {}),
  });
  const flows = new FlowService({
    env,
    logger: logger.child('flows'),
    store: flowStore,
    tenants,
    rooms,
    egress: services.egress,
    leadership: () => leaderRef,
    managedRtmp: () => managedRtmp,
    managedPull: (transport) => managedPull[transport],
    audit: (entry) => {
      try {
        services.audit.append(entry);
      } catch {
        /* flow audit is best-effort */
      }
    },
  });
  // Routing baseline: tenant routes + Edge enrollment are file-backed; room
  // joins trigger room→stream egress idempotently (docs/routing.md). Generic
  // flows are the second selection surface for an Edge join.
  const routingStore = new RoutingStore({
    dir: path.join(env.dataDir, 'routing'),
    ipSalt: env.ipSalt,
    logger: logger.child('routing'),
  });
  const routing = new RoutingService({
    env,
    logger: logger.child('routing'),
    store: routingStore,
    tenants,
    rooms,
    egress: services.egress,
    audit: (entry) => {
      try {
        services.audit.append(entry);
      } catch {
        /* routing audit is best-effort */
      }
    },
    flowEdgeJoin: (input) => flows.joinEdge(input),
    onEdgeOnline: (event) => flows.onEdgeOnline(event),
  });
  rooms.subscribe((event) => routing.onRoomEvent(event));
  rooms.subscribe((event) => flows.onRoomEvent(event));
  // Schedule trigger ticker: due occurrences are evaluated every 30 s in-process
  // and can also be driven explicitly via `POST /v1/admin/flows/tick`.
  const flowTickTimer = setInterval(() => {
    if (leader.isLeader()) void flows.tickAll();
  }, 30_000);
  flowTickTimer.unref?.();
  // Redis-compatible room-snapshot store (opt-in). The file store stays the
  // default and is also used as a write-through mirror when Redis is enabled.
  let snapshotRedis: RedisClient | null = null;
  if (env.continuityEnabled && env.roomSnapshotStore === 'redis' && env.redisUrl) {
    snapshotRedis = new RedisClient({
      url: env.redisUrl,
      onConnectError: () => undefined,
      onDisconnect: () => undefined,
    });
    void snapshotRedis.connect().catch((error: unknown) => {
      logger.warn('room snapshot Redis store unavailable; falling back to the file store', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  // Live-call continuity: persist room/session snapshots and restore them after
  // a Core restart; the same service mints resume tokens (docs/call-continuity.md).
  const continuity = new RoomContinuity({
    env,
    rooms,
    logger: logger.child('continuity'),
    tenants,
    cluster,
    isLeader: () => leaderRef?.isLeader() ?? true,
    ...(snapshotRedis
      ? {
        redis: snapshotRedis,
        snapshotFence: (script, keys, args) => leaderRef!.writeUnderLease(script, keys, args),
      }
      : {}),
  });
  onDrainChange = (change) => {
    const tenantId = change.tenantId;
    const nodeId = change.nodeId;
    const drain = change.drain;
    void continuity
      .markNodeDraining(tenantId, nodeId, drain)
      .then((result) => {
        if (result.affected > 0) {
          safeAudit(logger, services.audit, {
            type: 'room.draining',
            severity: 'warn',
            tenantId,
            message: `SFU node ${nodeId} ${drain ? 'draining' : 'back in service'}: ${result.affected} room(s) marked`,
            details: { nodeId, draining: drain, rooms: result.affected },
          });
        }
      })
      .catch((error: unknown) => {
        logger.warn('room drain marker failed', { error: error instanceof Error ? error.message : String(error) });
      });
  };
  // One leader lease per Core. onPromote re-reads the registry file (a standby
  // may have a stale copy) and restores room snapshots once it owns the lease;
  // onDemote drops in-memory rooms so a demoted Core cannot keep serving calls
  // with stale state, but keeps the snapshots for the next leader.
  let leaderReady = false;
  let restoreTask: Promise<void> | null = null;
  let shuttingDown = false;
  const restoreLeader = (): Promise<void> => {
    if (restoreTask) return restoreTask;
    const task = continuity.restore().then((restored) => {
      if (restoreTask !== task || shuttingDown || !leader.isLeader() || restored.deferred) return;
      leaderReady = true;
      if (restored.restored > 0) logger.info('restored rooms from continuity snapshots', {
        rooms: restored.restored, tenants: restored.tenants, skipped: restored.skipped, store: continuity.storeKind,
      });
    }).catch((error: unknown) => {
      logger.warn('leader readiness is waiting for room snapshot restoration', {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (restoreTask === task) restoreTask = null;
    });
    restoreTask = task;
    return task;
  };
  const leader = new LeaderElector({
    env,
    clusterId: resolveClusterId(env) || cluster.identity().id,
    version: SERVER_VERSION,
    publicOrigin: env.publicOrigin,
    logger: logger.child('leader'),
    onPromote: () => {
      flows.onLeadershipChanged();
      cluster.onPromote();
      void restoreLeader();
    },
    onDemote: () => {
      leaderReady = false;
      restoreTask = null;
      continuity.invalidateRestore();
      flows.onLeadershipChanged();
      try {
        // The previous lease may already belong to another Core.
        rooms.clear('leadership_lost');
      } catch {
        /* best effort during shutdown/failover */
      }
    },
  });
  leaderRef = leader;
  if (env.flowStore === 'redis' && env.redisUrl) {
    managedRtmp = new RtmpIngressLifecycle(new IngressOwnershipStore(leader), new RtmpIngressClient(env));
    for (const transport of ['srt', 'hls'] as const) {
      managedPull[transport] = new PullIngressLifecycle(new IngressOwnershipStore(leader, transport), new PullIngressClient(env, transport));
    }
  }
  continuity.start();
  cluster.setLeadership(leader);
  const providers = new ProviderRegistry({
    env,
    logger: logger.child('providers'),
    services,
    getConfig: (tenantId) => tenants.getConfig(tenantId),
    getRoom: (tenantId, roomId) => {
      const room = rooms.get(roomId);
      return room && room.tenantId === tenantId ? room : undefined;
    },
    listTenants: () => tenants.listTenants(),
    audit: (entry) => {
      try {
        services.audit.append(entry);
      } catch {
        /* provider audit is best-effort */
      }
    },
  });

  // Crash recovery for the durable async AV queue: re-scan every job that was
  // accepted but not finished before the process died. Runs after the providers
  // exist and finishes in the background.
  void services.uploadScan
    .recoverPending({
      removeFile: ({ tenantId, fileId }) => providers.filesRemove({ tenantId, id: fileId }),
    })
    .then((recovered) => {
      if (recovered > 0) logger.info('recovered pending antivirus scans after restart', { count: recovered });
    })
    .catch((error: unknown) => {
      logger.warn('antivirus queue recovery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  const ctx: AppContext = {
    env,
    services,
    tenants,
    domains,
    rooms,
    continuity,
    analysis,
    providers,
    cluster,
    routing,
    flows,
    egressStarts: new EgressStartLedger(path.join(env.dataDir, 'egress-starts'), env.tokenSecret, env.redisUrl ? leader : undefined),
    logger,
    startedAt,
  };

  const router = createRouter();
  router.get('/v1/ready', (request) => {
    request.res.setHeader('cache-control', 'no-store');
    const active = !shuttingDown && leader.isLeader();
    if (active && !leaderReady) void restoreLeader();
    const ready = active && leaderReady;
    request.send(ready ? 200 : 503, { ready });
  });
  registerPublicRoutes(router);
  registerAdminRoutes(router);
  registerClusterRoutes(router);
  registerEdgeRoutes(router);
  registerSipRoutes(router);
  registerVoiceChannelRoutes(router, path.join(env.dataDir, 'voice-channels'), env.redisUrl ? leader : undefined);
  registerDocsRoutes(router);

  const mounts = staticMounts(env);
  const httpServer = createServer(
    createHttpHandler({
      ctx,
      router,
      fallback: (request) => serveStatic(request, { mounts }),
    }),
  );
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = 120_000;

  const signaling = createSignalingServer({
    httpServer,
    cluster,
    env,
    services,
    tenants,
    rooms,
    domains,
    analysis,
    providers,
    logger: logger.child('ws'),
    continuity,
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(env.port, env.host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? (address as AddressInfo).port : env.port;

  // Optional isolated docs/OpenAPI port (microservice-style exposure, §24).
  let docsServer: HttpServer | null = null;
  let docsPort = 0;
  if (env.docsEnabled && env.docsPort > 0 && env.docsPort !== port) {
    const docsRouter = createRouter();
    registerDocsRoutes(docsRouter);
    docsServer = createServer(
      createHttpHandler({
        ctx,
        router: docsRouter,
        surface: 'docs',
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      docsServer?.once('error', onError);
      docsServer?.listen(env.docsPort, env.docsHost, () => {
        docsServer?.off('error', onError);
        resolve();
      });
    });
    const docsAddress = docsServer.address();
    docsPort = typeof docsAddress === 'object' && docsAddress !== null ? (docsAddress as AddressInfo).port : env.docsPort;
  }

  // Start leader election after the HTTP listener is up: in Redis mode the Core
  // starts as standby (fail closed) and becomes leader only after the lease is
  // acquired; without Redis this is a no-op that keeps AGIL_CLUSTER_ROLE.
  try {
    await leader.start();
  } catch (error) {
    logger.error('leader election failed to start; staying standby (fail closed)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const leadership = leader.snapshot();
  logger.info('leadership state', {
    mode: leadership.mode,
    role: leadership.role,
    nodeId: leadership.nodeId,
    clusterId: leadership.clusterId,
    leaseTtlMs: leadership.leaseTtlMs,
    redisConnected: leadership.redisConnected,
  });
  // Restore active rooms only once this Core is the leader (standalone mode is
  // always leader). A standby defers: onPromote runs the same restore later.
  if (leader.isLeader() && !leaderReady) await restoreLeader();

  let closed = false;
  const pollEgressArchive = (): void => {
    void services.egressArchive.poll(() => !closed && leader.isLeader()).catch(() => {
      logger.warn('could not poll egress recording archive');
    });
  };
  const egressArchiveTimer = setInterval(pollEgressArchive, 5000);
  egressArchiveTimer.unref?.();
  pollEgressArchive();
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(egressArchiveTimer);
    shuttingDown = true;
    clearInterval(flowTickTimer);
    clearInterval(analysisRetentionTimer);
    // Snapshot under the current lease before letting another Core take over.
    try {
      if (leader.isLeader()) {
        const saved = await continuity.flushAll();
        if (saved > 0) logger.info('room snapshots flushed for restart', { rooms: saved });
      }
    } catch (error) {
      logger.warn('room snapshot flush on shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await leader.close();
    } catch {
      /* ignore */
    }
    try {
      await signaling.close();
    } catch {
      /* ignore */
    }
    try {
      rooms.clear('server_shutdown');
    } catch {
      /* ignore */
    }
    try {
      await continuity.close();
    } catch {
      /* ignore */
    }
    try {
      snapshotRedis?.close();
    } catch {
      /* ignore */
    }
    try {
      await services.uploadScan.close(1500);
    } catch {
      /* scan drain is best-effort */
    }
    try {
      await services.webhooks.close(1500);
    } catch {
      /* ignore */
    }
    try {
      await services.sttTranslation.close();
    } catch {
      /* optional local engines: never block shutdown */
    }
    try {
      await services.chatHistory.close();
    } catch {
      logger.warn('Chat history storage shutdown failed');
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Node keeps keep-alive sockets open; drop them so close() resolves fast.
      httpServer.closeAllConnections?.();
    });
    if (docsServer) {
      await new Promise<void>((resolve) => {
        docsServer?.close(() => resolve());
        docsServer?.closeAllConnections?.();
      });
    }
  };

  logger.info('AgilFrame server started', {
    port,
    origin: env.publicOrigin,
    anonymous: env.allowAnonymous,
    geoProvider: env.geoProvider,
    trustProxy: env.trustProxy,
    dataDirs: envDataDirs(env),
  });

  return {
    port,
    url: env.publicOrigin,
    env,
    server: httpServer,
    httpServer,
    ws: signaling.wss,
    wss: signaling.wss,
    registry: rooms,
    rooms,
    tenants,
    domains,
    services,
    analysis,
    providers,
    cluster,
    routing,
    flows,
    leader,
    continuity,
    docsServer,
    docsPort,
    close,
  };
}

/** CLI bootstrap: start, log URLs, graceful shutdown on SIGINT/SIGTERM. */
async function bootstrap(): Promise<void> {
  const logger = createLogger({ scope: 'server' });
  const server = await createAgilServer({ logger });
  const { env } = server;
  logger.info('listening', {
    http: `http://localhost:${server.port}`,
    ws: `ws://localhost:${server.port}${WS_PATH}`,
    api: `http://localhost:${server.port}/v1/health`,
    docs: `http://localhost:${server.port}/docs`,
    openapi: `http://localhost:${server.port}/openapi.json`,
    demo: `${env.publicOrigin}/`,
    editor: `${env.publicOrigin}/editor/`,
    dashboard: `${env.publicOrigin}/dashboard/`,
    sdk: `${env.publicOrigin}/sdk/agilframe.js`,
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    void server
      .close()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error('shutdown failed', { error: String(error) });
        process.exit(1);
      });
    // Do not hang forever on stuck sockets.
    const timer = setTimeout(() => process.exit(0), 5000);
    timer.unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry && import.meta.url === entry) {
  bootstrap().catch((error: unknown) => {
    console.error('[agil] fatal startup error:', error);
    process.exit(1);
  });
}
