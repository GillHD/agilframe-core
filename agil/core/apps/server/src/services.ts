/**
 * Service container: the single place where @agil/security objects and the
 * outbound integration clients are constructed from {@link Env}.
 *
 * Handlers receive `ctx.services` instead of building their own.
 */
import { join } from 'node:path';
import {
  AuditLog,
  ChallengeLivenessEngine,
  ClamAvScanner,
  CompositeAvScanner,
  FileStore,
  HttpLivenessEngine,
  LivenessService,
  MediaIntegrityService,
  QuarantineStore,
  RecordingStore,
  SttService,
  UploadScanService,
  YaraScanner,
  createRateLimiter,
  resolveGeo,
  type AvScanner,
  type GeoResult,
  type LivenessEngine,
  type MediaIntegrityInput,
  type MediaIntegrityResult,
  type RateLimiter,
} from '@agil/security';
import type { NodeModuleKind, TenantConfig } from '@agil/protocol';
import type { LocalSttEngine, Translator } from '@agil/ai';
import { envDataDirs, type Env } from './env.js';
import { BillingService } from './billing.js';
import { ChatHistory } from './chat-history.js';
import { ConversationReview } from './conversation-review.js';
import { DocsStore } from './docs-cms.js';
import { EgressClient } from './egress.js';
import { EgressRecordingArchive } from './egress-archive.js';
import { EgressPlaybackService } from './egress-playback.js';
import { KnowledgeService } from './knowledge.js';
import { createPublicAbuseGuard, type PublicAbuseGuard } from './public-abuse.js';
import type { Logger } from './logger.js';
import { resolveTenantSecret } from './secret-env.js';
import { SiemDispatcher } from './siem.js';
import { SipClient } from './sip.js';
import { SttTranslationService } from './stt-translation.js';
import { WebhookDispatcher } from './webhooks.js';

export interface ServiceLimiters {
  /** 10 joins per minute per IP+room. */
  join: RateLimiter;
  /** 30 file uploads per minute per tenant. */
  files: RateLimiter;
  /** 30 STT calls per minute per tenant. */
  stt: RateLimiter;
  /** `AGIL_ADMIN_RATE_LIMIT_PER_MIN` admin requests per minute per key. */
  admin: RateLimiter;
  /** 10 knowledge-agent questions per minute per participant. */
  knowledge: RateLimiter;
  /** `AGIL_DOCS_RATE_LIMIT_PER_MIN` docs/OpenAPI requests per minute per IP. */
  docs: RateLimiter;
  /** `AGIL_DOMAIN_ASK_RATE_LIMIT_PER_MIN` on-demand TLS approval calls per IP. */
  domainAsk: RateLimiter;
  /** 10 in-call assistant requests per minute per participant. */
  assistant: RateLimiter;
  /** 20 liveness challenge/verify requests per minute per tenant+participant. */
  liveness: RateLimiter;
  /** 30 OIDC start/callback requests per minute per IP. */
  oidc: RateLimiter;
  /** 10 SIP dial-in attempts per minute per tenant+room+IP. */
  sip: RateLimiter;
  /** 30 SIP list requests per minute per tenant+room+IP (cleanup path). */
  sipList: RateLimiter;
  /** 10 SIP stop attempts per minute per tenant+room+IP (cleanup path). */
  sipStop: RateLimiter;
  /** 120 enrollment attempts (join/register) per minute per IP. */
  enrollment: RateLimiter;
  /**
   * Heartbeats per node per minute, keyed by the authenticated tenant id + node
   * id (node ids are unique per tenant only, so same-id nodes of different
   * tenants must not share a bucket). Charged only after the credential
   * validates, so invalid keys cannot create buckets; the outer IP limiter below
   * covers every attempt instead.
   */
  heartbeat: RateLimiter;
  /**
   * Every heartbeat attempt per client IP per minute, charged **before** the
   * credential is hashed/validated, which bounds a client that sends a fresh
   * bogus key per request. Bounded by `maxKeys` (LRU).
   */
  heartbeatIp: RateLimiter;
}

export interface Services {
  audit: AuditLog;
  chatHistory: ChatHistory;
  conversationReview: ConversationReview;
  files: FileStore;
  recordings: RecordingStore;
  stt: SttService;
  /** Local (on-box) STT + machine translation; never a startup dependency. */
  sttTranslation: SttTranslationService;
  webhooks: WebhookDispatcher;
  knowledge: KnowledgeService;
  /** Admin-editable documentation (bundled overrides + version history). */
  docs: DocsStore;
  /** Optional SIEM audit export (fail-open). */
  siem: SiemDispatcher;
  /** LiveKit Egress Twirp controller (recording/RTMP/HLS). */
  egress: EgressClient;
  /** Signed HLS/MP4 playback links + S3/local object proxy. */
  egressPlayback: EgressPlaybackService;
  /** Completed MP4 catalogue independent of the live room registry. */
  egressArchive: EgressRecordingArchive;
  /** LiveKit SIP Twirp controller (optional PSTN dial-in; disabled by default). */
  sip: SipClient;
  /** Monthly usage metering + quota evaluation (billing baseline, no payments). */
  billing: BillingService;
  /** Tenant-scoped quarantine for infected/fail-closed uploads (payloads are not served). */
  quarantine: QuarantineStore;
  /** Async upload-scan queue (disabled unless an engine + tenant flag exist). */
  uploadScan: UploadScanService;
  /** Server-issued liveness challenges (advisory; disabled unless configured). */
  liveness: LivenessService;
  limiters: ServiceLimiters;
  publicAbuse: PublicAbuseGuard;
  dirs: { data: string; audit: string; files: string; recordings: string; billing: string; quarantine: string; avQueue: string };
}

/**
 * Test/embedding seam: real engines by default, fakes in tests. Passing an
 * engine also bypasses the env parsing, which keeps server tests hermetic.
 */
export interface SecurityEngines {
  avScanner?: AvScanner;
  livenessEngine?: LivenessEngine;
}

/**
 * Test/embedding seam for the on-box STT/translation engines: passing one
 * bypasses binary/Python/model discovery, so tests stay hermetic (no model
 * downloads, no child processes).
 */
export interface SttEngines {
  sttEngine?: LocalSttEngine;
  translator?: Translator;
}

export interface CreateServicesDeps {
  logger: Logger;
  getConfig: (tenantId: string) => TenantConfig;
  /** Optional side-effect-free lookup (used by SIEM so deleted tenants are not resurrected). */
  getConfigIfExists?: (tenantId: string) => TenantConfig | null;
  isManagedNodeAvailable?: (tenantId: string, nodeId: string, moduleId: NodeModuleKind) => boolean;
  /** Optional engine injection (tests / self-hosted adapters). */
  securityEngines?: SecurityEngines;
  /** Optional local STT/translation engine injection (tests). */
  sttEngines?: SttEngines;
}

/**
 * Builds the deployment-wide AV engine from `AGIL_CLAMAV_*` / `AGIL_YARA_RULES`.
 * Returns undefined when nothing is configured.
 */
export function createAvScanner(env: Env): AvScanner | undefined {
  const scanners: AvScanner[] = [];
  if (env.clamavSocket || env.clamavHost) {
    scanners.push(
      new ClamAvScanner({
        host: env.clamavHost,
        port: env.clamavPort,
        socketPath: env.clamavSocket,
        timeoutMs: env.clamavTimeoutMs,
      }),
    );
  }
  if (env.yaraRules) {
    scanners.push(
      new YaraScanner({
        rulesPath: env.yaraRules,
        command: env.yaraBin,
        timeoutMs: env.clamavTimeoutMs,
      }),
    );
  }
  if (scanners.length === 0) return undefined;
  return scanners.length === 1 ? (scanners[0] as AvScanner) : new CompositeAvScanner(scanners);
}

/** Builds the liveness engine: built-in free challenge or a self-hosted HTTP detector. */
export function createLivenessEngine(env: Env): LivenessEngine {
  if (env.livenessEngine === 'external') {
    return new HttpLivenessEngine({
      url: env.livenessUrl,
      key: env.livenessKey,
      timeoutMs: env.livenessTimeoutMs,
    });
  }
  return new ChallengeLivenessEngine();
}

/** Builds every stateful service once per server instance. */
export function createServices(env: Env, deps: CreateServicesDeps): Services {
  const dirs = envDataDirs(env);
  const audit = new AuditLog({ dir: dirs.audit, salt: env.ipSalt });
  const siem = new SiemDispatcher(env, deps.getConfigIfExists ?? deps.getConfig, deps.logger);
  let egressArchive: EgressRecordingArchive;
  const egress = new EgressClient(env, deps.logger, (tenantId) => {
    const nodeId = deps.getConfigIfExists?.(tenantId)?.mediaProcessing.egressNodeId;
    return !nodeId || deps.isManagedNodeAvailable?.(tenantId, nodeId, 'egress') === true;
  }, (input, result, key) => egressArchive.track(input, result, key));
  const egressPlayback = new EgressPlaybackService({
    backend: env.egressPlaybackBackend,
    secret: env.egressPlaybackSecret || env.tokenSecret,
    defaultTtlSec: env.egressPlaybackTtlSec,
    maxTtlSec: 86400,
    ...(env.egressS3Endpoint && env.egressS3Bucket && env.egressS3AccessKey && env.egressS3SecretKey
      ? {
          s3: {
            endpoint: env.egressS3Endpoint,
            region: env.egressS3Region || 'us-east-1',
            bucket: env.egressS3Bucket,
            accessKey: env.egressS3AccessKey,
            secretKey: env.egressS3SecretKey,
            forcePathStyle: env.egressS3ForcePathStyle,
          },
        }
      : {}),
    ...(env.egressPlaybackDir ? { localDir: env.egressPlaybackDir } : {}),
  });
  const sip = new SipClient(env, deps.logger.child('sip'), (tenantId) => {
    const nodeId = deps.getConfigIfExists?.(tenantId)?.scale.sip.nodeId;
    return nodeId ? deps.isManagedNodeAvailable?.(tenantId, nodeId, 'sip') === true : undefined;
  });
  const appendAudit = audit.append.bind(audit);
  audit.append = ((input: Parameters<typeof audit.append>[0]) => {
    const entry = appendAudit(input);
    try {
      siem.ingest(entry);
    } catch {
      /* SIEM must never break the audit trail */
    }
    return entry;
  }) as typeof audit.append;

  const webhooks = new WebhookDispatcher({
    env,
    logger: deps.logger.child('webhooks'),
    getConfig: deps.getConfig,
    ...(deps.getConfigIfExists ? { getConfigIfExists: deps.getConfigIfExists } : {}),
    audit: (entry) => {
      try {
        audit.append(entry);
      } catch {
        /* audit failures must not break webhook bookkeeping */
      }
    },
  });
  egressArchive = new EgressRecordingArchive({
    directory: join(env.dataDir, 'egress-archive'),
    egress,
    playback: egressPlayback,
    bucket: env.egressS3Bucket,
    deletionEnabled: env.egressArchiveDeleteEnabled,
    logger: deps.logger.child('egress-archive'),
    publishReady: (record) => {
      const subscribed = webhooks.endpointsFor(record.tenantId)
        .filter(endpoint => endpoint.enabled && endpoint.events.includes('recording.ready')).length;
      const accepted = webhooks.emit('recording.ready', { tenantId: record.tenantId, roomId: record.roomId }, {
        recordingId: record.id, egressId: record.egressId, source: 'egress', mime: 'video/mp4',
        size: record.size, durationSec: record.durationSec,
      }, { eventId: record.id });
      if (accepted < subscribed) throw new Error('Could not queue all recording.ready deliveries');
    },
  });
  const quarantine = new QuarantineStore({ dir: dirs.quarantine });
  const avScanner = deps.securityEngines?.avScanner ?? createAvScanner(env);
  const avLogger = deps.logger.child('av');
  const uploadScan = new UploadScanService({
    ...(avScanner ? { scanner: avScanner } : {}),
    quarantine,
    // Durable async queue: an accepted scan survives a crash/restart and is
    // recovered on startup (fail-closed is not lost between 200 and the scan).
    spoolDir: dirs.avQueue,
    concurrency: env.avConcurrency,
    queueLimit: env.avQueueLimit,
    timeoutMs: env.clamavTimeoutMs,
    logger: avLogger,
    onScan: ({ outcome, job }) => {
      // `blocked` is the single source of truth for "never serve/share": it is
      // set for infected files and for fail-closed scan errors, even when the
      // live-copy removal failed (defence in depth for the download handler).
      if (outcome.blocked) {
        try {
          quarantine.block({
            tenantId: job.tenantId,
            sourceId: job.fileId,
            ...(job.roomId ? { roomId: job.roomId } : {}),
            fileName: job.fileName,
            reason: outcome.status === 'infected' ? 'infected' : 'scan_error',
            archived: outcome.quarantined,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          });
        } catch (error) {
          avLogger.warn('quarantine block marker failed', {
            fileId: job.fileId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        audit.append({
          type: 'file.scanned',
          severity: outcome.status === 'error' ? 'warn' : 'info',
          tenantId: job.tenantId,
          roomId: job.roomId ?? '',
          message: `Upload scan: ${outcome.status}${outcome.engine ? ` (${outcome.engine})` : ''}`,
          details: {
            fileId: job.fileId,
            engine: outcome.engine,
            status: outcome.status,
            ...(outcome.signature ? { signature: outcome.signature } : {}),
            quarantined: outcome.quarantined,
            removed: outcome.removed,
            blocked: outcome.blocked,
          },
        });
      } catch {
        /* auditing must never break the scan pipeline */
      }
      // `file.shared` contract: exactly one delivery, and only once the file is
      // known not to be blocked. For AV-disabled tenants the handler emits it
      // immediately (no scan callback at all); for `async` this runs after the
      // verdict, so an infected file never gets a share event.
      if (!outcome.blocked) {
        try {
          webhooks.emit(
            'file.shared',
            { tenantId: job.tenantId, ...(job.roomId ? { roomId: job.roomId } : {}) },
            {
              fileId: job.fileId,
              name: job.fileName,
              mime: job.mime,
              size: job.size ?? job.data.length,
              ...(job.uploadedBy ? { uploadedBy: job.uploadedBy } : {}),
            },
          );
        } catch {
          /* webhooks are best-effort */
        }
      }
    },
    onScanUnavailable: ({ job, scan, outcome, recovered }) => {
      // A fail-closed scan could not run because this process has no engine —
      // typically a job accepted before a restart. This critical signal marks
      // the "scanner absent" bypass explicitly instead of leaving it implied.
      try {
        audit.append({
          type: 'file.scan_unavailable',
          severity: 'critical',
          tenantId: job.tenantId,
          roomId: job.roomId ?? '',
          message: `Upload scan unavailable${recovered ? ' (recovered job after restart)' : ''}: ${
            scan.detail ?? 'no antivirus engine'
          }`,
          details: {
            fileId: job.fileId,
            reason: 'scan_error',
            recovered,
            engine: scan.engine,
            blocked: outcome.blocked,
            quarantined: outcome.quarantined,
            removed: outcome.removed,
          },
        });
      } catch {
        /* auditing must never break the scan pipeline */
      }
      try {
        webhooks.emit(
          'security.event',
          { tenantId: job.tenantId, ...(job.roomId ? { roomId: job.roomId } : {}) },
          {
            kind: 'scan_unavailable',
            fileId: job.fileId,
            reason: 'scan_error',
            recovered,
            engine: scan.engine,
            blocked: outcome.blocked,
            quarantined: outcome.quarantined,
            removed: outcome.removed,
            ...(scan.detail ? { detail: scan.detail } : {}),
          },
        );
      } catch {
        /* webhooks are best-effort */
      }
    },
    onQuarantined: ({ record, scan }) => {
      try {
        audit.append({
          type: 'file.quarantined',
          severity: 'critical',
          tenantId: record.tenantId,
          roomId: record.roomId,
          message: `Upload quarantined (${
            record.reason === 'infected' ? `infected: ${record.signature ?? 'unknown'}` : `scan error: ${scan.detail ?? 'unknown'}`
          })`,
          details: {
            quarantineId: record.id,
            fileId: record.sourceId,
            engine: record.engine,
            reason: record.reason,
            ...(record.signature ? { signature: record.signature } : {}),
            size: record.size,
            sha256: record.sha256,
          },
        });
      } catch {
        /* auditing must never break the scan pipeline */
      }
      try {
        webhooks.emit(
          'security.event',
          { tenantId: record.tenantId, ...(record.roomId ? { roomId: record.roomId } : {}) },
          {
            kind: 'file.quarantined',
            fileId: record.sourceId,
            quarantineId: record.id,
            reason: record.reason,
            engine: record.engine,
            ...(record.signature ? { signature: record.signature } : {}),
            sha256: record.sha256,
          },
        );
      } catch {
        /* webhooks are best-effort */
      }
    },
    onQuarantineFailed: ({ job, scan, reason, archived, quarantineId, blockPersisted, error, removeError }) => {
      // The live copy could not be removed (and maybe not archived either):
      // this is the highest-severity upload event, since infected/unscanned
      // bytes may still be on disk while the download route denies the file id.
      try {
        audit.append({
          type: 'file.quarantine_failed',
          severity: 'critical',
          tenantId: job.tenantId,
          roomId: job.roomId ?? '',
          message: `Quarantine FAILED: live copy could not be removed (${
            reason === 'infected' ? `infected: ${scan.signature ?? 'unknown'}` : `scan error: ${scan.detail ?? 'unknown'}`
          })`,
          details: {
            fileId: job.fileId,
            ...(quarantineId ? { quarantineId } : {}),
            reason,
            archived,
            removed: false,
            blocked: true,
            blockPersisted,
            engine: scan.engine,
            ...(scan.signature ? { signature: scan.signature } : {}),
            ...(error ? { error } : {}),
            ...(removeError ? { removeError } : {}),
          },
        });
      } catch {
        /* auditing must never break the scan pipeline */
      }
      try {
        webhooks.emit(
          'security.event',
          { tenantId: job.tenantId, ...(job.roomId ? { roomId: job.roomId } : {}) },
          {
            kind: 'file.quarantine_failed',
            fileId: job.fileId,
            ...(quarantineId ? { quarantineId } : {}),
            reason,
            archived,
            removed: false,
            blocked: true,
            blockPersisted,
            ...(scan.signature ? { signature: scan.signature } : {}),
            ...(error ? { error } : {}),
            ...(removeError ? { removeError } : {}),
          },
        );
      } catch {
        /* webhooks are best-effort */
      }
    },
  });
  const liveness = new LivenessService({
    engine: deps.securityEngines?.livenessEngine ?? createLivenessEngine(env),
    policy: { ttlSec: env.livenessTtlSec, maxAttempts: env.livenessMaxAttempts },
  });

  return {
    audit,
    chatHistory: new ChatHistory(join(dirs.data, 'chat-history'), env.chatPostgresUrl, deps.logger),
    conversationReview: new ConversationReview(),
    siem,
    egress,
    egressPlayback,
    egressArchive,
    sip,
    quarantine,
    uploadScan,
    liveness,
    billing: new BillingService({ dir: dirs.billing }),
    files: new FileStore({
      dir: dirs.files,
      secret: env.tokenSecret,
      baseUrl: env.publicOrigin,
      ttlSec: env.fileTtlSec,
      maxSizeMb: env.maxUploadMb,
    }),
    docs: new DocsStore({ env }),
    recordings: new RecordingStore({
      dir: dirs.recordings,
      secret: env.tokenSecret,
      baseUrl: env.publicOrigin,
      ttlSec: env.fileTtlSec,
      maxSizeMb: env.maxRecordingMb,
    }),
    stt: new SttService({ url: env.sttUrl, key: env.sttKey, model: env.sttModel }),
    sttTranslation: new SttTranslationService({
      env,
      logger: deps.logger.child('stt'),
      getConfig: deps.getConfig,
      ...(deps.sttEngines?.sttEngine ? { engineImpl: deps.sttEngines.sttEngine } : {}),
      ...(deps.sttEngines?.translator ? { translatorImpl: deps.sttEngines.translator } : {}),
    }),
    webhooks,
    knowledge: new KnowledgeService({ env, logger: deps.logger.child('knowledge') }),
    publicAbuse: createPublicAbuseGuard(),
    limiters: {
      join: createRateLimiter({ windowMs: 60_000, max: env.joinRateLimitPerMin, maxKeys: 20_000 }),
      files: createRateLimiter({ windowMs: 60_000, max: 30, maxKeys: 10_000 }),
      stt: createRateLimiter({ windowMs: 60_000, max: 30, maxKeys: 10_000 }),
      admin: createRateLimiter({ windowMs: 60_000, max: env.adminRateLimitPerMin, maxKeys: 10_000 }),
      knowledge: createRateLimiter({ windowMs: 60_000, max: 10, maxKeys: 20_000 }),
      docs: createRateLimiter({ windowMs: 60_000, max: env.docsRateLimitPerMin, maxKeys: 20_000 }),
      domainAsk: createRateLimiter({ windowMs: 60_000, max: env.domainAskRateLimitPerMin, maxKeys: 20_000 }),
      assistant: createRateLimiter({ windowMs: 60_000, max: 10, maxKeys: 20_000 }),
      liveness: createRateLimiter({ windowMs: 60_000, max: 20, maxKeys: 20_000 }),
      oidc: createRateLimiter({ windowMs: 60_000, max: 30, maxKeys: 20_000 }),
      sip: createRateLimiter({ windowMs: 60_000, max: 10, maxKeys: 20_000 }),
      sipList: createRateLimiter({ windowMs: 60_000, max: 30, maxKeys: 20_000 }),
      sipStop: createRateLimiter({ windowMs: 60_000, max: 10, maxKeys: 20_000 }),
      enrollment: createRateLimiter({ windowMs: 60_000, max: 120, maxKeys: 10_000 }),
      heartbeat: createRateLimiter({
        windowMs: 60_000,
        max: env.heartbeatRateLimitPerMin,
        maxKeys: 20_000,
      }),
      heartbeatIp: createRateLimiter({
        windowMs: 60_000,
        max: env.heartbeatIpRateLimitPerMin,
        maxKeys: 20_000,
      }),
    },
    dirs,
  };
}

/** Resolves geo data for a request; always resolves, never throws. */
export function resolveRequestGeo(env: Env, ip: string, headerCountry?: string): Promise<GeoResult> {
  if (env.geoProvider === 'none') return Promise.resolve({ vpn: false, source: 'none' });
  return resolveGeo(ip, {
    provider: env.geoProvider,
    headerCountry,
    timeoutMs: 1200,
  });
}

/** Evaluates media-integrity signals against the tenant's current policy. */
export function evaluateIntegrity(config: TenantConfig, input: MediaIntegrityInput): MediaIntegrityResult {
  const service = new MediaIntegrityService(config.security.mediaIntegrity);
  return service.evaluate(input);
}

/** True when the tenant has an AI endpoint configured (used by /v1/health). */
export function aiAgentConfigured(config: TenantConfig): boolean {
  const { aiAgent } = config.session;
  if (!aiAgent.enabled) return false;
  return aiAgent.mode !== 'local' && aiAgent.endpoint.trim().length > 0;
}

/** True when the tenant has a knowledge-agent endpoint configured. */
export function knowledgeAgentConfigured(config: TenantConfig): boolean {
  const agent = config.session.knowledgeAgent;
  return agent.enabled && agent.endpoint.trim().length > 0;
}

/**
 * Distinguishes "not configured" (501 knowledge_not_configured, actionable
 * message for the dashboard) from "not allowed for this role" (403).
 * Returns a human-readable reason when the external knowledge agent is missing
 * its endpoint or its API-key environment variable, otherwise null.
 */
export function knowledgeConfigurationIssue(
  config: TenantConfig,
  env: Pick<Env, 'tenantSecretEnv'>,
): string | null {
  const agent = config.session.knowledgeAgent;
  if (!agent.enabled) {
    return 'Ассистент знаний не настроен: включите его в /v1/admin/knowledge-agent.';
  }
  if (!agent.endpoint.trim()) {
    return 'Ассистент знаний не настроен: укажите endpoint в /v1/admin/knowledge-agent.';
  }
  const secretRef = resolveTenantSecret(env, agent.apiKeyEnv, 'integration');
  if (!secretRef.allowed) {
    return `Ассистент знаний не настроен: недопустимое имя переменной окружения (${secretRef.ref}); разрешены только AGIL_INTEGRATION_*.`;
  }
  if (secretRef.ref && !secretRef.value) {
    return `Ассистент знаний не настроен: не задан ключ (${agent.apiKeyEnv}).`;
  }
  return null;
}
