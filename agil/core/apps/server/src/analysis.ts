/**
 * Transcript analysis pipeline (contract §13).
 *
 *   captions/segments → local ComplianceEngine rules (always available, offline)
 *                    → optional corporate AI agent (external/hybrid modes, HMAC-signed)
 *                    → findings + meeting notes (verbatim excerpts) → room + audit
 *
 * External output is untrusted: the AiAgentClient validates it with zod and
 * merges only known fields. Any failure degrades to local-only analysis — the
 * pipeline never breaks a call.
 */
import { randomUUID } from 'node:crypto';
import { AiAgentClient, ComplianceEngine, LocalNotesExtractor, buildAiAgentRequest } from '@agil/ai';
import type { AiAgentResponse } from '@agil/ai';
import type {
  AiAgentConfig,
  AuditEntry,
  ComplianceFinding,
  ComplianceReport,
  MeetingNotes,
  ServerMessage,
  TenantConfig,
  TranscriptSegment,
  WebhookEventType,
} from '@agil/protocol';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import type { NotificationEvent } from './providers.js';
import type { Room } from './rooms.js';
import { resolveTenantSecret } from './secret-env.js';
import type { ChatHistory } from './chat-history.js';

export interface AnalysisResult {
  findings: ComplianceFinding[];
  notes: MeetingNotes | null;
  report: ComplianceReport | null;
  provider?: string;
  externalAttempted: boolean;
  externalError?: string;
}

/** Provider error details for audit must never contain raw HTML/body. */
export function summarizeExternalError(error: string | undefined): string | null {
  if (!error) return null;
  const text = String(error);
  const status = /HTTP\s*(\d{3})/i.exec(text)?.[1];
  if (status) return `http_${status}`;
  if (/timeout|aborted/i.test(text)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(text)) return 'dns_error';
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(text)) return 'network_error';
  if (/parse|invalid|json/i.test(text)) return 'invalid_response';
  return 'provider_error';
}

export interface RunAnalysisOptions {
  /** Analyse the whole transcript again instead of only segments newer than the last run. */
  full?: boolean;
}

export interface AnalysisPipelineOptions {
  env: Env;
  logger: Logger;
  chatHistory: ChatHistory;
  chatMode: (tenantId: string) => TenantConfig['session']['chat']['historyStorage'];
}

const MAX_EXTERNAL_SEGMENTS = 200;
const MAX_EXTERNAL_CHAT = 200;

function externalFindings(config: AiAgentConfig, response: AiAgentResponse): ComplianceFinding[] {
  const now = Date.now();
  return response.findings.map((finding) => {
    const mapped: ComplianceFinding = {
      id: randomUUID(),
      ts: now,
      ruleId: finding.ruleId,
      ruleName: finding.ruleName,
      source: 'external',
      severity: finding.severity,
      action: finding.action,
      excerpt: finding.excerpt,
    };
    if (finding.participantId) mapped.participantId = finding.participantId;
    if (finding.confidence !== undefined) mapped.confidence = finding.confidence;
    if (finding.recommendation) mapped.recommendation = finding.recommendation;
    return mapped;
  });
}

function mergeNotes(
  config: AiAgentConfig,
  local: MeetingNotes | null,
  external: AiAgentResponse['notes'],
  segmentsAnalyzed: number,
  locale: 'ru' | 'en',
): MeetingNotes | null {
  if (!external) return local;
  const notes: MeetingNotes = {
    summary: external.summary ?? local?.summary ?? '',
    excerpts: external.excerpts ?? local?.excerpts ?? [],
    actionItems: external.actionItems ?? local?.actionItems ?? [],
    decisions: external.decisions ?? local?.decisions ?? [],
    risks: external.risks ?? local?.risks ?? [],
    topics: external.topics ?? local?.topics ?? [],
    source: config.mode === 'hybrid' ? 'hybrid' : 'external',
    segmentsAnalyzed,
    createdAt: Date.now(),
    language: local?.language ?? locale,
  };
  if (external.sentiment !== undefined) notes.sentiment = external.sentiment;
  else if (local?.sentiment !== undefined) notes.sentiment = local.sentiment;
  return notes;
}

export class AnalysisPipeline {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly chatHistory: ChatHistory;
  private readonly chatMode: AnalysisPipelineOptions['chatMode'];

  constructor(options: AnalysisPipelineOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.chatHistory = options.chatHistory;
    this.chatMode = options.chatMode;
  }

  /** Runs local rules and (when configured) the corporate AI agent. Never throws. */
  async analyze(room: Room, config: TenantConfig, options: RunAnalysisOptions = {}): Promise<AnalysisResult> {
    const aiAgent = config.session.aiAgent;
    const sinceTs = options.full ? 0 : room.analysisUpdatedAt;
    const segments = room.finalSegments().filter((segment) => segment.ts > sinceTs);
    const result: AnalysisResult = {
      findings: [],
      notes: null,
      report: null,
      externalAttempted: false,
    };

    if (segments.length === 0) {
      result.notes = room.notes;
      result.report = room.report;
      return result;
    }

    let localFindings: ComplianceFinding[] = [];
    try {
      if (aiAgent.policyRules.length > 0) {
        const engine = new ComplianceEngine({ rules: aiAgent.policyRules });
        localFindings = engine.analyzeSegments(segments);
      }
    } catch (error) {
      this.logger.warn('local compliance engine failed', { error: (error as Error).message });
    }

    let notes: MeetingNotes | null = null;
    try {
      notes = new LocalNotesExtractor().extract(segments, {
        locale: config.session.defaultLocale,
        maxExcerpts: 10,
      });
    } catch (error) {
      this.logger.warn('local notes extractor failed', { error: (error as Error).message });
    }

    const findings: ComplianceFinding[] = [...localFindings];
    let provider = 'local';

    const externalSegments = aiAgent.sendTranscripts ? segments.slice(-MAX_EXTERNAL_SEGMENTS) : [];
    const externalEnabled = aiAgent.enabled && aiAgent.mode !== 'local' && aiAgent.endpoint.trim().length > 0;
    const mode = this.chatMode(room.tenantId);
    const externalChat = !externalEnabled || !aiAgent.sendChat || mode === 'off' ? []
      : mode === 'session' ? room.messages.slice(-MAX_EXTERNAL_CHAT)
      : await this.chatHistory.recent(mode, { tenantId: room.tenantId, roomId: room.id, roomInstanceId: room.chatHistoryInstanceId }, MAX_EXTERNAL_CHAT)
        .catch(() => {
          this.logger.warn('Chat history unavailable for meeting analysis', { roomId: room.id });
          return [];
        });
    if (this.chatMode(room.tenantId) !== mode) externalChat.length = 0;
    const wantsExternal = externalEnabled
      && (externalSegments.length > 0 || externalChat.length > 0);
    if (wantsExternal) {
      result.externalAttempted = true;
      // Use-time allowlist + startup snapshot. A config naming e.g.
      // `AGIL_TOKEN_SECRET` must not make the analysis pipeline send a
      // server-wide secret to the tenant endpoint.
      const secretRef = resolveTenantSecret(this.env, aiAgent.apiKeyEnv, 'integration');
      if (!secretRef.allowed) {
        result.externalError = 'secret_env_not_allowed';
        this.logger.warn('ai agent apiKeyEnv is outside AGIL_INTEGRATION_*; external analysis skipped', {
          roomId: room.id,
        });
      } else {
        try {
          const client = new AiAgentClient({
            endpoint: aiAgent.endpoint,
            apiKey: secretRef.value,
            hmacSecret: this.env.aiAgentHmacSecret || undefined,
            timeoutMs: aiAgent.timeoutMs,
            maxRetries: 1,
          });
          if (client.isConfigured()) {
            const request = buildAiAgentRequest({
              tenantId: room.tenantId,
              roomId: room.id,
              roomName: room.name,
              locale: config.session.defaultLocale,
              participants: room.participants().map((participant) => ({
                id: participant.id,
                name: participant.name,
                role: participant.role,
                verified: participant.verified,
                ...(participant.country ? { country: participant.country } : {}),
              })),
              segments: externalSegments,
              chat: externalChat.map((message) => ({
                id: message.id,
                fromName: message.from.name,
                text: message.text,
                ts: message.ts,
              })),
              policy: { rules: aiAgent.policyRules, policyText: aiAgent.policyText },
              meetingContext: {
                startedAt: room.createdAt,
                ...(room.participants().find((participant) => participant.role === 'host')?.name
                  ? { hostName: room.participants().find((participant) => participant.role === 'host')?.name }
                  : {}),
              },
            });
            const answer = await client.analyze(request);
            if (answer.ok) {
              findings.push(...externalFindings(aiAgent, answer.response));
              notes = mergeNotes(aiAgent, notes, answer.response.notes, segments.length, config.session.defaultLocale);
              provider = answer.provider || 'external';
            } else {
              result.externalError = answer.error;
              this.logger.warn('ai agent call failed; continuing with local analysis', {
                roomId: room.id,
                error: summarizeExternalError(answer.error),
                retryable: answer.retryable,
              });
            }
          }
        } catch (error) {
          result.externalError = (error as Error).message;
          this.logger.warn('ai agent pipeline error; continuing with local analysis', {
            roomId: room.id,
            error: summarizeExternalError((error as Error).message),
          });
        }
      }
    }

    const report: ComplianceReport = {
      id: randomUUID(),
      roomId: room.id,
      tenantId: room.tenantId,
      createdAt: Date.now(),
      segmentsAnalyzed: segments.length,
      findings,
      ...(notes ? { summary: notes.summary, notes } : {}),
      provider,
    };

    result.findings = findings;
    result.notes = notes;
    result.report = report;
    result.provider = provider;
    return result;
  }

  /** Stores a fresh analysis result. Reusing the previous report does not extend its lifetime. */
  persist(room: Room, result: AnalysisResult): void {
    if (result.provider && result.report) room.setAnalysis({ report: result.report, notes: result.notes });
  }
}

/** Severity-aware excerpt used in the broadcast message / audit details. */
export function summarizeAnalysis(result: AnalysisResult): { critical: number; warn: number; info: number } {
  let critical = 0;
  let warn = 0;
  let info = 0;
  for (const finding of result.findings) {
    if (finding.severity === 'critical') critical += 1;
    else if (finding.severity === 'warn') warn += 1;
    else info += 1;
  }
  return { critical, warn, info };
}

/** Builds the `analysis` signaling message for a set of findings. */
export function analysisMessage(room: Room, findings: ComplianceFinding[], summary?: string): ServerMessage {
  return {
    type: 'analysis',
    roomId: room.id,
    findings,
    ...(summary ? { summary } : {}),
    ts: Date.now(),
  };
}

export interface RoomAnalysisDeps {
  room: Room;
  getConfig: () => TenantConfig;
  pipeline: AnalysisPipeline;
  trigger: 'batch' | 'request' | 'admin';
  logger: Logger;
  /** Audit sink; failures must not break the call. */
  audit: (entry: Omit<AuditEntry, 'id' | 'ts'>) => void;
  webhooks?: {
    emit(type: WebhookEventType, context: { tenantId: string; roomId?: string }, data: Record<string, unknown>): number;
  };
  /** Best-effort outbound notification (never blocks the call). */
  notify?: (event: NotificationEvent) => void;
}

/**
 * Runs the pipeline for a room and publishes the outcome: stores findings/notes
 * on the room, delivers findings according to room policy, writes audit entries and fires
 * `analysis.ready` / `compliance.finding` webhooks. Shared by the signaling
 * server and the admin API so both paths behave identically.
 */
export async function runRoomAnalysis(deps: RoomAnalysisDeps): Promise<AnalysisResult> {
  const { room, getConfig, pipeline, trigger, logger } = deps;
  const config = getConfig();
  const empty = { findings: [], notes: null, report: null, externalAttempted: false };
  if (config.security.e2ee || room.closed) return empty;
  room.pruneAnalysis(config.session.aiAgent.retentionMin);
  const result = await pipeline.analyze(room, config, { full: trigger === 'admin' });
  if (getConfig().security.e2ee || room.closed) return empty;
  if (result.findings.length === 0 && !result.report && !result.notes) return result;

  pipeline.persist(room, result);
  const summary = result.notes?.summary;
  const notesMessage = analysisMessage(room, [], summary);
  const moderationMessage = analysisMessage(room, result.findings, summary);
  const { retentionMin, notifyModerators } = getConfig().session.aiAgent;
  room.pruneAnalysis(retentionMin);
  for (const participant of room.participants()) {
    const receivesFindings = notifyModerators
      && (participant.role === 'host' || participant.role === 'moderator')
      && participant.permissions?.includes('aiCompliance');
    room.sendTo(participant.id, receivesFindings ? moderationMessage : notesMessage);
  }

  const safeAudit = (entry: Omit<AuditEntry, 'id' | 'ts'>): void => {
    try {
      deps.audit(entry);
    } catch (error) {
      logger.warn('analysis audit failed', { error: (error as Error).message });
    }
  };

  for (const finding of result.findings) {
    if (finding.severity === 'info') continue;
    safeAudit({
      type: 'admin.action',
      severity: finding.severity === 'critical' ? 'critical' : 'warn',
      tenantId: room.tenantId,
      roomId: room.id,
      participantId: finding.participantId,
      message: `Compliance finding (${finding.severity}): ${finding.ruleName}`,
      details: {
        kind: 'compliance.finding',
        source: finding.source,
        ruleId: finding.ruleId,
        action: finding.action,
      },
    });
  }
  safeAudit({
    type: 'admin.action',
    severity: 'info',
    tenantId: room.tenantId,
    roomId: room.id,
    message: `Analysis run (${trigger}): ${result.findings.length} findings, ${result.report?.segmentsAnalyzed ?? 0} segments`,
    details: {
      kind: 'analysis.run',
      trigger,
      provider: result.provider,
      externalError: summarizeExternalError(result.externalError),
    },
  });

  deps.webhooks?.emit('analysis.ready', { tenantId: room.tenantId, roomId: room.id }, {
    findings: result.findings.length,
    summary: result.notes?.summary ?? '',
    provider: result.provider ?? 'local',
  });
  for (const finding of result.findings) {
    if (finding.severity === 'info') continue;
    deps.webhooks?.emit('compliance.finding', { tenantId: room.tenantId, roomId: room.id }, {
      finding,
    });
  }
  try {
    deps.notify?.({
      type: 'analysis.ready',
      tenantId: room.tenantId,
      roomId: room.id,
      message: `Analysis ready: ${result.findings.length} findings`,
      data: {
        findings: result.findings.length,
        segmentsAnalyzed: result.report?.segmentsAnalyzed ?? 0,
        provider: result.provider ?? 'local',
      },
    });
  } catch {
    /* notifications are best-effort */
  }
  return result;
}
