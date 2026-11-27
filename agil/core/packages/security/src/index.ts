// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * @agil/security — Node-only security services for AgilFrame.
 *
 * Public API (docs/contract.md §12):
 *   hashPassword / verifyPassword      — scrypt room-password hashing
 *   hashIp / resolveClientIp           — IP pseudonymisation + proxy handling
 *   resolveGeo / countryFromHeaders    — geo/VPN resolution (never throws)
 *   createRateLimiter                  — bounded fixed-window limiter
 *   AuditLog                           — JSONL audit trail + in-memory ring
 *   FileStore / RecordingStore         — signed, expiring file storage
 *   MediaIntegrityService              — heuristic anti-deepfake scoring
 *   SttService                         — OpenAI-compatible server STT
 *   ClamAvScanner / YaraScanner / CompositeAvScanner
 *                                      — pluggable malware scanning (local daemons)
 *   QuarantineStore                    — tenant-scoped quarantine for infected uploads
 *   UploadScanService                  — bounded async scan queue + fail-open/closed policy
 *   LivenessService / ChallengeLivenessEngine / HttpLivenessEngine
 *                                      — server-issued liveness challenges (advisory)
 *   signWebhookPayload / verifyWebhookSignature / buildWebhookHeaders
 *                                      — outgoing webhook HMAC signing
 *   SecurityError                      — error with a stable `code`
 *
 * Shared DTOs are re-exported (type-only) from `@agil/protocol`; this package has
 * no runtime dependency on it, so importing the built dist never pulls browser
 * code into the server.
 */
export * from './errors.js';
export * from './password.js';
export * from './ip.js';
export * from './geo.js';
export * from './rate-limit.js';
export * from './audit.js';
export * from './files.js';
export { ensureDir, isMimeAllowed, normalizeMime, readJsonFile, writeJsonAtomic } from './storage.js';
export * from './recordings.js';
export * from './integrity.js';
export * from './stt.js';
export * from './av.js';
export * from './quarantine.js';
export * from './upload-scan.js';
export * from './liveness.js';
export * from './webhooks.js';
export * from './sanitize.js';
export * from './url-validation.js';

export type {
  AuditEntry,
  AuditEventType,
  AuditSeverity,
  FileRecord,
  RecordingRecord,
  SttRequest,
  SttResponse,
  WebhookDeliveryRecord,
  WebhookEndpointConfig,
  WebhookEventType,
  WebhookPayload,
} from '@agil/protocol';
