// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * `@agil/ai` — Node-only corporate AI integration for AgilFrame.
 *
 *   - {@link ComplianceEngine} — deterministic local phrase/regex/PII rules;
 *   - {@link LocalNotesExtractor} — extractive notes, verbatim excerpts;
 *   - {@link AiAgentClient} — signed HTTPS webhook to a corporate AI agent;
 *   - {@link KnowledgeAgentClient} — signed HTTPS webhook to a corporate
 *     wiki/RAG knowledge agent (contract §18);
 *   - {@link InCallAssistantClient} — signed HTTPS webhook to an external
 *     in-call assistant ("any LLM behind a proxy", docs/in-call-agent.md);
 *   - {@link UniversalLlmClient} — one `chat()` API over OpenAI-compatible,
 *     Anthropic and Ollama providers (docs/llm-integrations.md);
 *   - {@link buildAiAgentRequest} — validated `AiAgentRequest` payload builder.
 *
 * Types live in `@agil/protocol` (`compliance.ts`, `assistant.ts`) and are
 * re-exported here for convenience. This package is Node-only (uses
 * `node:crypto` and `fetch`); never import it into browser bundles.
 */
export { ComplianceEngine, DEFAULT_PII_RULES } from './compliance-engine.js';
export type { ComplianceEngineOptions, PiiKind } from './compliance-engine.js';

export { LocalNotesExtractor } from './notes.js';
export type { ExtractNotesOptions } from './notes.js';

export { AiAgentClient } from './agent-client.js';
export type { AiAgentClientOptions, AiAgentClientResult } from './agent-client.js';

export { KnowledgeAgentClient, clampAnswerLength } from './knowledge-client.js';
export type { KnowledgeAgentClientOptions, KnowledgeAgentClientResult } from './knowledge-client.js';

export { InCallAssistantClient } from './in-call-assistant-client.js';
export type { InCallAssistantClientOptions, InCallAssistantClientResult } from './in-call-assistant-client.js';

export { UniversalLlmClient, LlmError } from './universal-llm.js';
export type {
  LlmChatRequest,
  LlmChatResult,
  LlmErrorCode,
  LlmMessage,
  LlmProvider,
  LlmUsage,
  UniversalLlmClientOptions,
} from './universal-llm.js';

export { buildAiAgentRequest } from './request-builder.js';
export type {
  AiAgentChatInput,
  AiAgentMeetingContextInput,
  AiAgentParticipantInput,
  AiAgentParticipantRole,
  AiAgentPolicyInput,
  BuildAiAgentRequestInput,
} from './request-builder.js';

export type {
  ActionItem,
  AiAgentConfig,
  AiAgentRequest,
  AiAgentResponse,
  AssistantAction,
  AssistantReply,
  AssistantSpotlight,
  AssistantTool,
  ComplianceAction,
  ComplianceFinding,
  CompliancePolicyRule,
  ComplianceReport,
  ComplianceRuleType,
  ComplianceSeverity,
  ComplianceSource,
  ExcerptKind,
  InCallAssistantRequest,
  InCallAssistantResponse,
  KnowledgeCitation,
  KnowledgeQueryRequest,
  KnowledgeQueryResponse,
  MeetingNotes,
  TranscriptExcerpt,
  TranscriptSegment,
} from '@agil/protocol';

export { ASSISTANT_PROMPTS, promptForRole } from './prompts.js';
export type { AssistantPrompt } from './prompts.js';

export { assessChange, deepMerge } from './guard.js';
export type { GuardContext } from './guard.js';

export { localAssistantReply } from './dashboard-assistant.js';

/* ------------------------------------------------------------------ */
/* Local (on-box) STT + machine translation — docs/stt-translation-local.md */
/* ------------------------------------------------------------------ */

export {
  FakeSttEngine,
  FasterWhisperEngine,
  WhisperCppEngine,
  createLocalSttEngine,
  describeEngine,
  fasterWhisperRepoId,
  fasterWhisperWorkerArgs,
  resolveFasterWhisperModel,
} from './local-stt.js';
export type {
  FakeSttOptions,
  LocalModelResolution,
  LocalSttEngine,
  LocalSttEngineName,
  LocalSttEnginePreference,
  LocalSttOptions,
  LocalSttRequest,
  LocalSttResult,
  LocalSttSegment,
  SttAvailability,
  SttLanguage,
} from './local-stt.js';

export {
  FakeTranslator,
  LlmTranslator,
  OpusMtTranslator,
  TranslationError,
  createLocalTranslator,
  detectLanguage,
  opusPairSnapshotState,
  opusWorkerArgs,
  translateInChunks,
  translateSegments,
} from './local-translate.js';
export type {
  FakeTranslatorOptions,
  LocalTranslateOptions,
  TranslateEnginePreference,
  TranslationEngineName,
  TranslationErrorCode,
  TranslationLanguage,
  TranslationProviderMode,
  TranslationProviderName,
  TranslationRequest,
  TranslationResult,
  Translator,
  TranslatorAvailability,
} from './local-translate.js';

export { chunkText, findHfCachedModel, hasTransformersWeights, huggingFaceCacheDirs } from './local-support.js';
