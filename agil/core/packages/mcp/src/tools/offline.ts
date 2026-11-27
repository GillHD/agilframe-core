/**
 * Offline MCP tools — these work with no AGIL server and no network at all.
 *
 * The model can learn the config schema, generate themes, validate configs,
 * audit contrast, explain effective permissions, build embed snippets and
 * analyze transcripts (local extractive notes + deterministic compliance rules).
 */
import { z } from 'zod';
import {
  applyBrandColor,
  auditTheme,
  bestTextColor,
  contrastRatio,
  deepMerge,
  defaultConfig,
  describeAccess,
  generatePalette,
  isHexColor,
  isAssistantToolAllowed,
  normalizeHex,
  resolveAccess,
  resolveKnowledgeAgentAccess,
  resolveTheme,
  tenantConfigSchema,
  themeFromBrandColor,
  themePresetNames,
  themePresets,
  toCssVars,
  type ComplianceFinding,
  type CompliancePolicyRule,
  type FeatureKey,
  type MeetingNotes,
  type Role,
  type TenantConfig,
  type ThemeAuditIssue,
  type ThemePatch,
  type ThemePresetName,
  type ThemeTokens,
  type TranscriptSegment,
} from '@agil/protocol';
import { ComplianceEngine, LocalNotesExtractor } from '@agil/ai';
import { configJsonSchema, configMarkdown, demoDefaultConfig, sectionJsonSchema, type ConfigSection } from '../config-doc.js';
import { BETA_FEATURES, DEFAULT_COMPLIANCE_RULES, LOW_BANDWIDTH_PROFILES, ROADMAP_FEATURES } from '../constants.js';
import { diffConfigs, summarizeChanges } from '../diff.js';
import { buildEmbedSnippet } from '../embed.js';
import { DOCS } from '../docs.js';
import { explainProvidersMarkdown } from '../providers-doc.js';
import { explainScalingMarkdown } from '../scaling-doc.js';
import { explainRolesMarkdown } from '../roles-doc.js';
import {
  assistantToolInfos,
  explainFeatureMarkdown,
  explainSpotlightMarkdown,
  SPOTLIGHT_TARGETS,
} from '../assistant-doc.js';
import {
  defineTool,
  formatZodIssues,
  isPlainObject,
  jsonOutcome,
  ToolError,
  type AnyToolSpec,
} from '../tool-kit.js';
import {
  FEATURE_KEYS,
  configInputSchema,
  configSectionSchema,
  docTopicSchema,
  featureKeySchema,
  featureOverridesSchema,
  lowBandwidthScenarioSchema,
  parseConfigInput,
  presetSchema,
  providerSlotNameSchema,
  roleSchema,
  rulesInputSchema,
  schemeSchema,
  segmentsInputSchema,
  themeInputSchema,
  type ParseConfigResult,
} from '../schemas.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const THEME_HINT =
  'Hint: theme is a JSON object; pass a deep-partial of ThemeTokens (e.g. {"colors":{"primary":"#0b5fff"}}). ' +
  'Call agil_get_config_schema with section:"theme" to see every token.';

const CONFIG_HINT =
  'Hint: pass a full TenantConfig or a deep-partial patch. Call agil_get_config_schema to inspect every field, type and default.';

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ToolError(`\`${field}\` must be a JSON object.`, THEME_HINT);
  }
  return value;
}

function requireBrandColor(value: string): string {
  if (!isHexColor(value)) {
    throw new ToolError(
      `Invalid brand color "${value}".`,
      'Pass a hex color like "#0b5fff" (#rgb, #rrggbb or #rrggbbaa).',
    );
  }
  return normalizeHex(value);
}

function resolveThemeInput(raw: unknown, base?: ThemeTokens): ThemeTokens {
  const patch = requireObject(raw, 'theme');
  try {
    const merged = base ? deepMerge(structuredClone(base), patch) : patch;
    const scheme = (merged as { scheme?: 'light' | 'dark' | 'auto' }).scheme ?? 'auto';
    return resolveTheme(merged as ThemePatch, scheme);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ToolError(`Invalid theme:\n${formatZodIssues(error).join('\n')}`, THEME_HINT);
    }
    throw error;
  }
}

function roundedRatio(a: string, b: string): number {
  try {
    return Math.round(contrastRatio(a, b) * 100) / 100;
  } catch {
    return 1;
  }
}

export interface AuditIssueView {
  level: 'error' | 'warn';
  code: string;
  message: string;
  tokens: string[];
  currentRatio?: number;
  suggestedForeground?: string;
  suggestedRatio?: number;
}

function viewAuditIssues(issues: readonly ThemeAuditIssue[]): AuditIssueView[] {
  return issues.map((issue) => {
    const foreground = issue.tokens[0];
    const background = issue.tokens[1];
    const current = foreground && background ? { currentRatio: roundedRatio(foreground, background) } : {};
    let suggestion: Pick<AuditIssueView, 'suggestedForeground' | 'suggestedRatio'> = {};
    if (background) {
      const suggested = bestTextColor(background);
      suggestion = { suggestedForeground: suggested, suggestedRatio: roundedRatio(suggested, background) };
    }
    return {
      level: issue.level,
      code: issue.code,
      message: issue.message,
      tokens: [...issue.tokens],
      ...current,
      ...suggestion,
    };
  });
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function renderNotesMarkdown(notes: MeetingNotes): string {
  const lines: string[] = [];
  lines.push('# Meeting notes (offline extractor)');
  lines.push('');
  lines.push(`**Summary:** ${notes.summary}`);
  lines.push('');
  lines.push(
    `Segments analyzed: ${notes.segmentsAnalyzed} · source: ${notes.source}${notes.language ? ` · language: ${notes.language}` : ''}`,
  );
  if (notes.excerpts.length > 0) {
    lines.push('', `## Excerpts (${notes.excerpts.length})`, '');
    for (const excerpt of notes.excerpts) {
      const speaker = excerpt.participantName ?? 'unknown speaker';
      lines.push(`- **[${formatTime(excerpt.start)}] ${speaker}** (${excerpt.kind}): “${excerpt.text}”`);
    }
  }
  if (notes.actionItems.length > 0) {
    lines.push('', '## Action items', '');
    for (const item of notes.actionItems) {
      const meta = [item.owner, item.due].filter(Boolean).join(', ');
      lines.push(`- [ ] ${item.text}${meta ? ` (${meta})` : ''}`);
    }
  }
  if (notes.decisions.length > 0) {
    lines.push('', '## Decisions', '');
    for (const decision of notes.decisions) lines.push(`- ${decision}`);
  }
  if (notes.risks.length > 0) {
    lines.push('', '## Risks', '');
    for (const risk of notes.risks) lines.push(`- ${risk}`);
  }
  if (notes.topics.length > 0) {
    lines.push('', '## Topics', '');
    lines.push(notes.topics.map((topic) => `\`${topic}\``).join(', '));
  }
  if (notes.sentiment) {
    lines.push('', `**Sentiment:** ${notes.sentiment}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Pure implementations (unit-tested and reused by the tools)          */
/* ------------------------------------------------------------------ */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  themeAudit: { errors: number; warnings: number; issues: AuditIssueView[] };
}

function unknownTopLevelKeys(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const known = new Set(Object.keys(tenantConfigSchema.shape));
  return Object.keys(raw).filter((key) => !known.has(key));
}

/** Zod-level + semantic validation of a TenantConfig or patch. Fully offline. */
export function validateConfig(
  raw: unknown,
  opts: { tenantId?: string; expectedTenantId?: string } = {},
): ValidationResult {
  const parsed: ParseConfigResult = parseConfigInput(raw);
  if (!parsed.ok) {
    return {
      valid: false,
      errors: parsed.errors,
      warnings: [],
      themeAudit: { errors: 0, warnings: 0, issues: [] },
    };
  }
  const config = parsed.config;
  const auditIssues = auditTheme(config.theme);
  const warnings: string[] = [];

  for (const issue of viewAuditIssues(auditIssues)) {
    warnings.push(`theme.${issue.code}: ${issue.message} (tokens: ${issue.tokens.join(' / ')})`);
  }
  for (const key of unknownTopLevelKeys(raw)) {
    warnings.push(`Unknown top-level key "${key}" will be ignored (stripped by zod validation).`);
  }
  if (opts.expectedTenantId && config.tenantId !== opts.expectedTenantId) {
    warnings.push(
      `config.tenantId is "${config.tenantId}" but the MCP server works with tenant "${opts.expectedTenantId}"; online tools will target the MCP tenant.`,
    );
  }
  for (const feature of ROADMAP_FEATURES) {
    if (config.features[feature]) {
      warnings.push(`features.${feature} is a roadmap flag: accepted by the API, not implemented in the current widget.`);
    }
  }
  for (const feature of BETA_FEATURES) {
    if (config.features[feature]) {
      warnings.push(`features.${feature} is implemented but still marked beta.`);
    }
  }
  const geo = config.security.geo;
  if (geo.enabled && geo.allowedCountries.length === 0 && geo.blockedCountries.length === 0) {
    warnings.push('security.geo.enabled is true but both country lists are empty: all countries are allowed.');
  }
  for (const [list, codes] of [
    ['allowedCountries', geo.allowedCountries],
    ['blockedCountries', geo.blockedCountries],
  ] as const) {
    for (const code of codes) {
      if (!/^[A-Z]{2}$/.test(code)) {
        warnings.push(`security.geo.${list} contains "${code}": use uppercase ISO-3166 alpha-2 codes (e.g. "RU").`);
      }
    }
  }
  const overlap = geo.allowedCountries.filter((code) => geo.blockedCountries.includes(code));
  if (overlap.length > 0) {
    warnings.push(`security.geo: countries both allowed and blocked: ${overlap.join(', ')}; blocked wins.`);
  }
  if (config.security.passwordRequired) {
    warnings.push(
      'security.passwordRequired is true: a password is set per room at creation (POST /v1/admin/rooms) and stored only as a scrypt hash. It is not part of the tenant config.',
    );
  }
  if (!config.security.requireToken && !config.security.waitingRoom) {
    warnings.push('security.requireToken=false without a waiting room: anyone with the room link can join.');
  }
  if (config.security.sessionBinding.enabled) {
    warnings.push('security.sessionBinding is a legacy configuration block. Core does not enforce IP or device binding.');
  }

  const policy = config.security.accessPolicy;
  if (policy.mode === 'strict' && Object.keys(policy.userOverrides).length === 0) {
    warnings.push(
      'security.accessPolicy.mode="strict" with no userOverrides: only explicit token permissions grant features.',
    );
  }
  if (policy.mode === 'role-defaults' && policy.roleDefaults.guest.length === 0) {
    warnings.push('security.accessPolicy.roleDefaults.guest is empty: guests will see no functionality.');
  }
  const deniedInDefaults = policy.deniedFeatures.filter(
    (key) =>
      policy.roleDefaults.host.includes(key) ||
      policy.roleDefaults.moderator.includes(key) ||
      policy.roleDefaults.guest.includes(key),
  );
  if (deniedInDefaults.length > 0) {
    warnings.push(`security.accessPolicy.deniedFeatures also granted by roleDefaults (denial wins): ${deniedInDefaults.join(', ')}`);
  }

  const lowBandwidth = config.fallback.lowBandwidth;
  if (config.features.lowBandwidthFallback && !lowBandwidth.enabled) {
    warnings.push('features.lowBandwidthFallback is on but fallback.lowBandwidth.enabled is false: no degradation policy runs.');
  }
  if (lowBandwidth.restoreThreshold.rttMs >= lowBandwidth.enterThreshold.rttMs) {
    warnings.push(
      'fallback.lowBandwidth.restoreThreshold.rttMs must be lower than enterThreshold.rttMs, otherwise quality flaps.',
    );
  }
  if (lowBandwidth.strategy === 'audio-only' && config.video.simulcast) {
    warnings.push(
      'fallback.lowBandwidth.strategy="audio-only" with video.simulcast=true: simulcast layers are wasted; consider disabling.',
    );
  }

  const session = config.session;
  if (!config.video.codecs.includes(config.video.preferredCodec)) {
    warnings.push(
      `video.preferredCodec "${config.video.preferredCodec}" is not in video.codecs (${config.video.codecs.join(', ')}); the browser cannot honor it.`,
    );
  }
  if (!config.audio.codecs.includes(config.audio.preferredCodec)) {
    warnings.push(
      `audio.preferredCodec "${config.audio.preferredCodec}" is not in audio.codecs (${config.audio.codecs.join(', ')}); the browser cannot honor it.`,
    );
  }
  if (session.recording.enabled && !session.recording.consentRequired) {
    warnings.push(
      'session.recording.enabled with consentRequired=false is legally risky: recording consent is required in many jurisdictions.',
    );
  }
  if (session.transcription.enabled && session.transcription.provider === 'off') {
    warnings.push('session.transcription.enabled with provider="off": transcription will never start.');
  }
  const agent = session.aiAgent;
  if (agent.enabled && agent.mode !== 'local' && !agent.endpoint) {
    warnings.push(`session.aiAgent.mode="${agent.mode}" requires a non-empty endpoint.`);
  }
  if (agent.enabled && agent.policyRules.length === 0) {
    warnings.push('session.aiAgent.enabled with no policyRules: only PII defaults of the external agent would apply.');
  }
  const knowledge = session.knowledgeAgent;
  if (knowledge.enabled && !knowledge.endpoint) {
    warnings.push('session.knowledgeAgent.enabled but endpoint is empty: resolveKnowledgeAgentAccess() reports not_configured.');
  }
  if (knowledge.enabled && knowledge.allowedRoles.length === 0) {
    warnings.push('session.knowledgeAgent.allowedRoles is empty: nobody can ask the corporate knowledge agent.');
  }
  if (knowledge.enabled && knowledge.requirePermission && !config.features.knowledgeAgent) {
    warnings.push(
      'session.knowledgeAgent.requirePermission=true but features.knowledgeAgent is disabled: nobody passes the permission check.',
    );
  }
  if (!knowledge.enabled && config.features.knowledgeAgent) {
    warnings.push('features.knowledgeAgent is on but session.knowledgeAgent.enabled is false: the assistant UI will report "disabled".');
  }
  if (session.locales.length === 1 && session.allowLocaleSwitch) {
    warnings.push('session.allowLocaleSwitch=true but only one locale is configured.');
  }
  if (config.branding.logoUrl && config.theme.logo.url && config.branding.logoUrl !== config.theme.logo.url) {
    warnings.push('branding.logoUrl differs from theme.logo.url; the widget renders theme.logo.url in the call UI.');
  }
  if (config.limits.maxParticipants > 20) {
    warnings.push('limits.maxParticipants > 20: mesh WebRTC scales poorly above ~12-20 participants; consider SFU.');
  }
  if (config.features.recording && !session.recording.enabled) {
    warnings.push('features.recording is on but session.recording.enabled is false: the record button will be hidden.');
  }
  if (config.features.fileShare && !session.fileShare.enabled) {
    warnings.push('features.fileShare is on but session.fileShare.enabled is false: uploads will be rejected.');
  }
  if (config.features.screenShare && !session.screenShare.enabled) {
    warnings.push('features.screenShare is on but session.screenShare.enabled is false: screen sharing will be rejected.');
  }

  const integrations = config.integrations;
  if (integrations.identity.mode === 'oidc') {
    const identity = integrations.identity;
    const discovery = identity.discovery === true || Boolean(identity.discoveryUrl.trim());
    if (!identity.jwksUrl.trim() && !discovery) {
      warnings.push('integrations.identity.mode="oidc" requires jwksUrl (or discovery:true): identity tokens and the dashboard SSO id_token are verified against it.');
    }
    if (!identity.issuer.trim()) {
      warnings.push('integrations.identity.mode="oidc" requires issuer: verification fails closed (501 identity_not_configured) without it.');
    }
    if (!identity.audience.trim() && !identity.clientId.trim()) {
      warnings.push('integrations.identity.mode="oidc" must set audience (API tokens) or clientId (dashboard SSO) so `aud` is checked.');
    }
    const ssoConfigured = Boolean(
      identity.clientId.trim() &&
        (discovery ||
          (identity.authorizationEndpoint.trim() &&
            identity.tokenEndpoint.trim() &&
            identity.redirectUri.trim())),
    );
    if (ssoConfigured && !identity.clientSecretEnv.trim()) {
      warnings.push('Dashboard SSO is configured without clientSecretEnv: the code exchange will answer 501 until the env-var name for the client secret is set.');
    }
    if (!identity.clientSecretEnv.trim() && !ssoConfigured) {
      warnings.push('integrations.identity.mode="oidc": set discovery (or authorizationEndpoint/tokenEndpoint)/clientId/redirectUri/clientSecretEnv to enable «Войти через SSO» in the dashboard.');
    }
  }
  for (const endpoint of integrations.webhooks) {
    if (!/^https:\/\//i.test(endpoint.url)) {
      warnings.push(`integrations.webhooks["${endpoint.id}"].url should be HTTPS: webhook payloads contain meeting data.`);
    }
    if (!endpoint.enabled) {
      warnings.push(`integrations.webhooks["${endpoint.id}"] is disabled: events will not be delivered to it.`);
    }
  }
  if (integrations.allowedOrigins.includes('*')) {
    warnings.push('integrations.allowedOrigins contains "*": any website may embed the call UI.');
  }

  return {
    valid: true,
    errors: [],
    warnings,
    themeAudit: {
      errors: auditIssues.filter((issue) => issue.level === 'error').length,
      warnings: auditIssues.filter((issue) => issue.level === 'warn').length,
      issues: viewAuditIssues(auditIssues),
    },
  };
}

export interface GeneratedThemeResult {
  theme: ThemeTokens;
  cssVars: Record<string, string>;
  contrastIssues: AuditIssueView[];
  accessible: boolean;
  preset: ThemePresetName;
  scheme: 'light' | 'dark' | 'auto';
  tokenCount: number;
  primary: string;
  palette: ReturnType<typeof generatePalette>;
}

/** Generates a coherent theme from a single brand color. */
export function generateTheme(input: {
  brandColor: string;
  preset?: ThemePresetName;
  scheme?: 'light' | 'dark' | 'auto';
}): GeneratedThemeResult {
  const brandColor = requireBrandColor(input.brandColor);
  const requestedScheme = input.scheme;
  const requestedPreset: ThemePresetName = input.preset ?? (requestedScheme === 'dark' ? 'dark' : 'light');
  const presetIsDark = requestedPreset === 'dark' || requestedPreset === 'night';

  let effectivePreset: ThemePresetName = requestedPreset;
  if (requestedScheme === 'light' && presetIsDark) effectivePreset = 'light';
  if (requestedScheme === 'dark' && !presetIsDark) effectivePreset = 'dark';

  const generated = themeFromBrandColor(brandColor, effectivePreset);
  const scheme: 'light' | 'dark' | 'auto' = requestedScheme ?? generated.scheme;
  const theme = resolveTheme(generated as ThemePatch, scheme);
  const contrastIssues = viewAuditIssues(auditTheme(theme));
  const paletteScheme = (scheme === 'auto' ? 'light' : scheme) as 'light' | 'dark';
  return {
    theme,
    cssVars: toCssVars(theme),
    contrastIssues,
    accessible: !contrastIssues.some((issue) => issue.level === 'error'),
    preset: effectivePreset,
    scheme,
    tokenCount: Object.keys(theme.colors).length,
    primary: theme.colors.primary,
    palette: generatePalette(brandColor, paletteScheme),
  };
}

export interface ApplyThemeResult {
  config: TenantConfig;
  theme: ThemeTokens;
  changes: ReturnType<typeof diffConfigs>;
  changeSummary: string;
  cssVars: Record<string, string>;
  audit: AuditIssueView[];
}

/** Applies a brand color / theme patch / preset and returns a new validated config. */
export function applyThemeToConfig(input: {
  config: unknown;
  brandColor?: string;
  themePatch?: unknown;
  preset?: ThemePresetName;
}): ApplyThemeResult {
  const parsed = parseConfigInput(input.config);
  if (!parsed.ok) {
    throw new ToolError(`Invalid config:\n${parsed.errors.join('\n')}`, CONFIG_HINT);
  }
  const base = parsed.config;
  let theme = input.preset ? structuredClone(themePresets[input.preset]) : structuredClone(base.theme);
  if (input.themePatch !== undefined) {
    theme = resolveThemeInput(input.themePatch, theme);
  }
  if (input.brandColor !== undefined) {
    theme = applyBrandColor(theme, requireBrandColor(input.brandColor));
  }
  let next: TenantConfig;
  try {
    next = tenantConfigSchema.parse({ ...base, theme });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ToolError(`Theme cannot be applied:\n${formatZodIssues(error).join('\n')}`, THEME_HINT);
    }
    throw error;
  }
  const changes = diffConfigs(base, next);
  return {
    config: next,
    theme,
    changes,
    changeSummary: summarizeChanges(changes),
    cssVars: toCssVars(theme),
    audit: viewAuditIssues(auditTheme(theme)),
  };
}

export interface AccessibilityAuditResult {
  passed: boolean;
  counts: { errors: number; warnings: number };
  issues: AuditIssueView[];
  theme: ThemeTokens;
  cssVars: Record<string, string>;
}

/** WCAG-ish contrast audit for a theme (full or patch). */
export function auditAccessibility(input: { theme: unknown }): AccessibilityAuditResult {
  const theme = resolveThemeInput(input.theme);
  const issues = viewAuditIssues(auditTheme(theme));
  return {
    passed: issues.length === 0,
    counts: {
      errors: issues.filter((issue) => issue.level === 'error').length,
      warnings: issues.filter((issue) => issue.level === 'warn').length,
    },
    issues,
    theme,
    cssVars: toCssVars(theme),
  };
}

export interface LowBandwidthProfileResult {
  scenario: LowBandwidthScenarioName;
  patch: { fallback: { lowBandwidth: Record<string, unknown> } };
  notes: string[];
  validated: boolean;
  applyHint: string;
}

type LowBandwidthScenarioName = keyof typeof LOW_BANDWIDTH_PROFILES;

/** Low-bandwidth fallback patch for a network scenario. */
export function suggestLowBandwidthProfile(input: { scenario: LowBandwidthScenarioName }): LowBandwidthProfileResult {
  const profile = LOW_BANDWIDTH_PROFILES[input.scenario];
  const lowBandwidth = {
    enabled: true,
    strategy: profile.strategy,
    chatOverSignaling: true,
    enterThreshold: { ...profile.enterThreshold },
    restoreThreshold: { ...profile.restoreThreshold },
    autoReconnect: { ...profile.autoReconnect },
    iceRestartOnFailure: profile.iceRestartOnFailure,
  };
  const patch = { fallback: { lowBandwidth } };
  const check = parseConfigInput(patch);
  if (!check.ok) {
    throw new ToolError(
      `Internal error: generated profile rejected by schema: ${check.errors.join('; ')}`,
      'This is a bug in the MCP server, please report it.',
    );
  }
  return {
    scenario: input.scenario,
    patch,
    notes: [...profile.notes],
    validated: true,
    applyHint:
      'Send this patch directly via agil_update_config({patch, dryRun:true}) — it is already validated, no theme merge is involved.',
  };
}

export interface MeetingSummaryResult {
  notes: MeetingNotes;
  markdown: string;
}

/** Extractive meeting notes from transcript segments (offline, no model). */
export function summarizeMeeting(input: {
  segments: readonly TranscriptSegment[];
  locale?: 'ru' | 'en';
  maxExcerpts?: number;
}): MeetingSummaryResult {
  const extractor = new LocalNotesExtractor();
  let notes: MeetingNotes;
  try {
    notes = extractor.extract(input.segments, {
      ...(input.locale ? { locale: input.locale } : {}),
      maxExcerpts: input.maxExcerpts ?? 5,
    });
  } catch (error) {
    throw new ToolError(
      `Could not build meeting notes: ${error instanceof Error ? error.message : String(error)}`,
      'Pass final transcript segments (isFinal: true) with non-empty text and sane start/end seconds.',
    );
  }
  return { notes, markdown: renderNotesMarkdown(notes) };
}

export interface ComplianceAnalysisResult {
  segmentsAnalyzed: number;
  rulesApplied: number;
  findings: ComplianceFinding[];
  summary: {
    total: number;
    bySeverity: Record<string, number>;
    byRule: Record<string, number>;
    byAction: Record<string, number>;
    participants: string[];
  };
  recommendations: string[];
}

/** Deterministic local compliance analysis over transcript segments (offline). */
export function analyzeCompliance(input: {
  segments: TranscriptSegment[];
  rules?: CompliancePolicyRule[];
}): ComplianceAnalysisResult {
  const rules = input.rules && input.rules.length > 0 ? input.rules : DEFAULT_COMPLIANCE_RULES;
  const engine = new ComplianceEngine({ rules });
  const findings: ComplianceFinding[] = [];
  try {
    for (const segment of input.segments) findings.push(...engine.analyzeSegment(segment));
  } catch (error) {
    throw new ToolError(
      `Compliance analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      'Check policy rule patterns (invalid regex) and segment text lengths.',
    );
  }
  const bySeverity: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const participants = new Set<string>();
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
    byAction[finding.action] = (byAction[finding.action] ?? 0) + 1;
    if (finding.participantName) participants.add(finding.participantName);
  }
  const recommendations: string[] = [];
  if ((bySeverity.critical ?? 0) > 0) {
    recommendations.push(
      'Critical findings detected: notify the moderator and review the quoted excerpts before the next call.',
    );
  }
  if (findings.length === 0) {
    recommendations.push('No policy violations matched. This is a deterministic local check, not a legal guarantee.');
  }
  return {
    segmentsAnalyzed: input.segments.length,
    rulesApplied: rules.length,
    findings,
    summary: { total: findings.length, bySeverity, byRule, byAction, participants: [...participants] },
    recommendations,
  };
}

const ACCESS_ROLES: Role[] = ['host', 'moderator', 'guest'];

const ACCESS_SOURCE_EXPLANATION: Record<string, string> = {
  'role-defaults': 'role defaults from security.accessPolicy.roleDefaults',
  'user-override': 'a per-user override from security.accessPolicy.userOverrides[userId]',
  token: 'pinned token permissions (the token issuer decides)',
  strict: 'strict mode: only explicit grants (token permissions / user overrides) apply',
};

export interface ExplainAccessResult {
  role: Role;
  userId?: string;
  source: string;
  sourceExplanation: string;
  description: string;
  allowed: FeatureKey[];
  denied: FeatureKey[];
  counts: { allowed: number; denied: number };
  byRole: Record<Role, { allowed: FeatureKey[]; denied: FeatureKey[]; source: string }>;
  knowledgeAgent: ReturnType<typeof resolveKnowledgeAgentAccess>;
  notes: string[];
}

/** Explains the effective permissions of a participant, fully offline. */
export function explainAccess(input: {
  role: Role;
  userId?: string;
  tokenPermissions?: FeatureKey[];
  config?: unknown;
}): ExplainAccessResult {
  let config: TenantConfig;
  if (input.config === undefined) {
    config = defaultConfig({ tenantId: 'demo' });
  } else {
    const parsed = parseConfigInput(input.config);
    if (!parsed.ok) throw new ToolError(`Invalid config:\n${parsed.errors.join('\n')}`, CONFIG_HINT);
    config = parsed.config;
  }
  const accessContext = {
    config,
    role: input.role,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.tokenPermissions ? { tokenPermissions: input.tokenPermissions } : {}),
  };
  const resolution = resolveAccess(accessContext);
  const knowledgeAgent = resolveKnowledgeAgentAccess(accessContext);
  const byRole = Object.fromEntries(
    ACCESS_ROLES.map((role) => {
      const roleResolution = resolveAccess({
        config,
        role,
        ...(input.userId ? { userId: input.userId } : {}),
      });
      return [
        role,
        {
          allowed: roleResolution.allowed,
          denied: roleResolution.denied,
          source: roleResolution.source,
        },
      ];
    }),
  ) as Record<Role, { allowed: FeatureKey[]; denied: FeatureKey[]; source: string }>;

  const notes: string[] = [];
  const policy = config.security.accessPolicy;
  if (policy.mode === 'strict') {
    notes.push(
      'Policy mode is "strict": role defaults are ignored, only explicit token permissions or userOverrides grant features.',
    );
  }
  if (input.userId && !(input.userId in policy.userOverrides)) {
    notes.push(`No userOverride is configured for userId "${input.userId}".`);
  }
  if (input.tokenPermissions && input.tokenPermissions.length === 0) {
    notes.push('tokenPermissions was an empty array: it is ignored and normal policy resolution applies.');
  }
  notes.push(
    'Effective features = policy grant ∩ enabled features. The same list is sent to the widget on join (welcome.self.permissions).',
  );
  return {
    role: input.role,
    ...(input.userId ? { userId: input.userId } : {}),
    source: resolution.source,
    sourceExplanation: ACCESS_SOURCE_EXPLANATION[resolution.source] ?? resolution.source,
    description: describeAccess(resolution),
    allowed: resolution.allowed,
    denied: resolution.denied,
    counts: { allowed: resolution.allowed.length, denied: resolution.denied.length },
    byRole,
    knowledgeAgent,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

const PRESET_DESCRIPTIONS: Record<ThemePresetName, string> = {
  light: 'Neutral light UI with a blue accent; follows the OS dark mode by default (scheme=auto).',
  dark: 'Default dark UI with a blue accent; good for evening/streaming contexts.',
  corporate: 'Compact corporate blue on light surfaces, tighter radii; typical for B2B portals.',
  night: 'Purple-tinted dark theme with cyan accent; suits entertainment/evening events.',
  minimal: 'Monochrome minimal light theme, sharp corners, fast motion; for minimal-brand products.',
};

export function offlineToolSpecs(): AnyToolSpec[] {
  return [
    defineTool({
      name: 'agil_get_config_schema',
      title: 'Get TenantConfig schema',
      description:
        'Return the authoritative schema of AgilFrame TenantConfig (all sections: branding, theme, features, audio, video, limits, fallback, security [incl. accessPolicy], layout, session [incl. knowledgeAgent], room, integrations). ' +
        'Use it BEFORE editing any config so you know every field, type, constraint and default. ' +
        'format="markdown" (default) returns a readable field list with defaults; format="json" returns JSON Schema (draft-07). ' +
        'section restricts the result to one top-level section. Offline — no server needed.',
      inputSchema: z.object({
        format: z.enum(['markdown', 'json']).default('markdown').describe('Output format'),
        section: configSectionSchema.default('all').describe('Top-level config section or "all"'),
        includeDefaults: z
          .boolean()
          .default(false)
          .describe('For format="json": also return the resolved default value of the selected section'),
      }),
      handler: (args) => {
        const section = args.section as ConfigSection | 'all';
        if (args.format === 'markdown') {
          return { text: configMarkdown(section) };
        }
        const schema = section === 'all' ? configJsonSchema() : sectionJsonSchema(section);
        const payload: Record<string, unknown> = { format: 'json-schema', section, schema };
        if (args.includeDefaults) {
          const defaults = demoDefaultConfig();
          payload.defaults =
            section === 'all' ? defaults : (defaults as unknown as Record<string, unknown>)[section];
        }
        return jsonOutcome(payload);
      },
    }),

    defineTool({
      name: 'agil_validate_config',
      title: 'Validate tenant config',
      description:
        'Validate a TenantConfig (or a deep-partial patch) fully offline: zod schema validation, theme contrast audit and semantic warnings ' +
        '(roadmap flags, access-policy inconsistencies, knowledge/AI-agent misconfiguration, webhook/identity pitfalls, contradictory media settings). ' +
        'Returns {valid, errors[], warnings[], themeAudit}. Errors block saving; warnings are recommendations. ' +
        'Use after every config edit and before agil_update_config. Offline — no server needed.',
      inputSchema: z.object({
        config: configInputSchema,
        includeResolved: z
          .boolean()
          .default(false)
          .describe('Also return the fully resolved config (large) when validation succeeds'),
      }),
      handler: (args, ctx) => {
        const result = validateConfig(args.config, {
          tenantId: ctx.env.tenantId,
          expectedTenantId: ctx.env.tenantId,
        });
        const payload: Record<string, unknown> = {
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
          tenantId: ctx.env.tenantId,
          themeAudit: result.themeAudit,
        };
        if (args.includeResolved) {
          const parsed = parseConfigInput(args.config);
          if (parsed.ok) payload.resolvedConfig = parsed.config;
        }
        return jsonOutcome(payload);
      },
    }),

    defineTool({
      name: 'agil_generate_theme',
      title: 'Generate theme from brand color',
      description:
        'Generate a complete, validated 36-token theme from ONE brand color (hex). ' +
        'Derives hover/active/on-primary/on-accent/focus-ring colors, keeps the chosen preset layout and audits WCAG contrast. ' +
        'Returns {theme, cssVars, contrastIssues, palette, accessible}. Use this as the first step of branding. ' +
        'Then call agil_apply_theme_to_config or send {theme} to agil_update_config. Offline — no server needed.',
      inputSchema: z.object({
        brandColor: z.string().min(3).max(9).describe('Brand color in hex, e.g. "#0b5fff"'),
        preset: presetSchema.optional(),
        scheme: schemeSchema.optional(),
      }),
      handler: (args) => jsonOutcome(generateTheme(args)),
    }),

    applyThemeTool('agil_apply_theme_to_config', false),
    applyThemeTool('agil_apply_theme', true),

    defineTool({
      name: 'agil_list_theme_presets',
      title: 'List theme presets',
      description:
        'List the five built-in theme presets (light, dark, corporate, night, minimal) with their scheme, primary/accent/background colors, ' +
        'density and a short description of when to use each. Use it to pick a preset for agil_generate_theme or for a quick config theme. Offline.',
      inputSchema: z.object({}),
      handler: () => {
        const presets = themePresetNames.map((name) => {
          const theme = themePresets[name];
          return {
            name,
            scheme: theme.scheme,
            primary: theme.colors.primary,
            accent: theme.colors.accent,
            background: theme.colors.background,
            surface: theme.colors.surface,
            density: theme.spacing.density,
            radiusMd: theme.shape.radiusMd,
            description: PRESET_DESCRIPTIONS[name],
          };
        });
        return jsonOutcome({
          count: presets.length,
          presets,
          colorTokensPerTheme: Object.keys(themePresets.light.colors).length,
        });
      },
    }),

    defineTool({
      name: 'agil_audit_accessibility',
      title: 'Audit theme contrast',
      description:
        'Audit a theme (full ThemeTokens or a partial patch) against WCAG contrast requirements: body text 4.5:1, secondary/large text and UI 3:1. ' +
        'Returns {passed, counts, issues[]} with the current ratio and a suggested accessible foreground color for every failing pair. ' +
        'Run it after customizing colors. Offline — no server needed.',
      inputSchema: z.object({
        theme: themeInputSchema,
      }),
      handler: (args) => jsonOutcome(auditAccessibility(args)),
    }),

    defineTool({
      name: 'agil_suggest_lowbandwidth_profile',
      title: 'Suggest low-bandwidth profile',
      description:
        'Return a ready `fallback.lowBandwidth` patch tuned for a network scenario: mobile-3g, satellite, office-wifi or audio-only. ' +
        'Includes enter/restore thresholds, reconnect backoff, degradation strategy and rationale. ' +
        'The patch is validated against the TenantConfig schema; send it directly to agil_update_config. Offline — no server needed.',
      inputSchema: z.object({
        scenario: lowBandwidthScenarioSchema,
      }),
      handler: (args) => jsonOutcome(suggestLowBandwidthProfile(args)),
    }),

    defineTool({
      name: 'agil_get_embed_snippet',
      title: 'Get embed snippet',
      description:
        'Generate copy-paste HTML/JS for embedding an AgilFrame room. Supports SDK mode (AGILCalls.mount with /sdk/agil-calls.js) ' +
        'and iframe mode (/embed.html?...). Supports §22 layout overrides: chrome (full|compact|none), minimized mini-window ' +
        '(bar|bubble, position, self-view, controls) and persistAcrossPages (+ AGILCalls.resume()). ' +
        'Values are HTML/JS escaped; token injection is noted. Returns {snippet, sdkHtml, iframeHtml, iframeUrl, layout, notes}. Offline.',
      inputSchema: z.object({
        room: z.string().min(1).max(120).describe('Room id or slug, e.g. "team-sync"'),
        token: z.string().max(4096).optional().describe('Optional short-lived join token (JWT)'),
        serverUrl: z.string().max(300).optional().describe('AGIL server origin; defaults to AGIL_SERVER_URL'),
        tenantId: z.string().max(64).optional().describe('Tenant id; defaults to AGIL_TENANT_ID'),
        participantName: z.string().max(120).optional(),
        role: roleSchema.optional(),
        locale: z.enum(['ru', 'en']).optional(),
        theme: themeInputSchema.optional(),
        features: featureOverridesSchema.optional().describe('Local feature overrides, e.g. {"chat":true}'),
        chrome: z
          .enum(['full', 'compact', 'none'])
          .optional()
          .describe('§22 chrome: full UI, compact bar, or none (embed as part of the company page)'),
        minimized: z
          .object({
            enabled: z.boolean().optional(),
            mode: z.enum(['bar', 'bubble']).optional(),
            position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(),
            showSelfView: z.boolean().optional(),
            keepControls: z.boolean().optional(),
          })
          .optional()
          .describe('§22 mini-mode: floating call window that survives page navigation'),
        persistAcrossPages: z
          .boolean()
          .optional()
          .describe('§22: keep {room, token, tenant, name, theme} in sessionStorage for AGILCalls.resume()'),
        inheritHostStyles: z
          .boolean()
          .optional()
          .describe('§22: inherit host page fonts/colors for tokens that are not set'),
        mode: z
          .enum(['sdk', 'iframe'])
          .default('sdk')
          .describe('Which snippet to return as `snippet` (both are always included)'),
      }),
      handler: (args, ctx) => {
        if (args.features) {
          const unknown = Object.keys(args.features).filter((key) => !FEATURE_KEYS.includes(key as FeatureKey));
          if (unknown.length > 0) {
            throw new ToolError(
              `Unknown feature flags in \`features\`: ${unknown.join(', ')}.`,
              `Valid flags: ${FEATURE_KEYS.join(', ')}.`,
            );
          }
        }
        if (args.theme !== undefined) {
          // Validate before putting it into generated code, but keep the original patch.
          resolveThemeInput(args.theme);
        }
        const layout =
          args.chrome !== undefined ||
          args.minimized !== undefined ||
          args.persistAcrossPages !== undefined ||
          args.inheritHostStyles !== undefined
            ? {
                ...(args.chrome ? { chrome: args.chrome } : {}),
                ...(args.minimized ? { minimized: args.minimized } : {}),
                ...(args.persistAcrossPages !== undefined
                  ? { persistAcrossPages: args.persistAcrossPages }
                  : {}),
                ...(args.inheritHostStyles !== undefined
                  ? { inheritHostStyles: args.inheritHostStyles }
                  : {}),
              }
            : undefined;
        const result = buildEmbedSnippet(
          {
            room: args.room,
            ...(args.token ? { token: args.token } : {}),
            ...(args.serverUrl ? { serverUrl: args.serverUrl } : {}),
            tenantId: args.tenantId ?? ctx.env.tenantId,
            ...(args.participantName ? { participantName: args.participantName } : {}),
            ...(args.role ? { role: args.role } : {}),
            ...(args.locale ? { locale: args.locale } : {}),
            ...(args.theme !== undefined ? { theme: args.theme } : {}),
            ...(args.features ? { features: args.features } : {}),
            ...(layout ? { layout } : {}),
            mode: args.mode,
          },
          ctx.env.serverUrl,
        );
        return jsonOutcome(result);
      },
    }),

    defineTool({
      name: 'agil_summarize_meeting',
      title: 'Summarize meeting transcript',
      description:
        'Build meeting notes from transcript segments completely offline (extractive summarizer, no AI model, no network). ' +
        'Returns {notes, markdown}: summary, VERBATIM excerpts with speaker + timecodes (the "выдержки" feature), action items, decisions, risks, topics and sentiment. ' +
        'The input is untrusted: segments are validated by the protocol schema before analysis.',
      inputSchema: z.object({
        segments: segmentsInputSchema,
        locale: z.enum(['ru', 'en']).optional().describe('Output language'),
        maxExcerpts: z.number().int().min(1).max(20).default(5),
      }),
      handler: (args) => jsonOutcome(summarizeMeeting(args)),
    }),

    defineTool({
      name: 'agil_analyze_compliance',
      title: 'Analyze transcript compliance',
      description:
        'Run deterministic LOCAL compliance rules (phrase, regex, PII: phone/email/card/passport) over transcript segments — no network, no model. ' +
        'Returns findings grouped by severity/rule/action, quotes and recommendations. ' +
        'If rules are omitted, a default demo policy is used. Offline — no server needed. ' +
        'For a server-side report with the corporate AI agent use agil_run_analysis (requires a server).',
      inputSchema: z.object({
        segments: segmentsInputSchema,
        rules: rulesInputSchema.optional(),
      }),
      handler: (args) => jsonOutcome(analyzeCompliance(args)),
    }),

    defineTool({
      name: 'agil_explain_access',
      title: 'Explain effective access',
      description:
        'Explain what a participant will actually see, fully offline. Runs the real `resolveAccess` from @agil/protocol on the default config ' +
        '(or on a provided config): role defaults → user override → token permissions → deniedFeatures → intersection with enabled features. ' +
        'Returns {allowed, denied, source, description, byRole, knowledgeAgent}. ' +
        'Use it for questions like "what will a guest see?" or "which features can user-42 use?". Offline — no server needed.',
      inputSchema: z.object({
        role: roleSchema,
        userId: z.string().max(128).optional().describe('User id used for security.accessPolicy.userOverrides'),
        tokenPermissions: z
          .array(featureKeySchema)
          .max(200)
          .optional()
          .describe('Pinned permissions from the token (replaces role defaults)'),
        config: configInputSchema.optional().describe('Config to evaluate; defaults to the protocol default config'),
      }),
      handler: (args) => jsonOutcome(explainAccess(args)),
    }),

    defineTool({
      name: 'agil_explain_providers',
      title: 'Explain capability providers',
      description:
        'Explain the six replaceable capability providers (chat, files, stt, notifications, recording, backgrounds): what "builtin" means, ' +
        'which external systems can replace it, the slot contract (mode/endpoint/apiKeyEnv/fallback/options), fallback semantics and the chat routing split. ' +
        'Returns markdown with examples and a pointer to docs/extensibility.md. Optionally focus on one slot. Offline — no server needed.',
      inputSchema: z.object({
        slot: providerSlotNameSchema.optional().describe('Focus on one slot; omit to explain all six'),
      }),
      handler: (args) => ({ text: explainProvidersMarkdown(args.slot) }),
    }),

    defineTool({
      name: 'agil_get_assistant_tools',
      title: 'List in-call assistant tools',
      description:
        'List the 18 tools of the in-call AI assistant (start_recording, toggle_mic, open_chat, request_fullscreen, …) with the permission each one requires ' +
        '(`assistantToolRequirements`: feature flag and/or roles), the spotlight target it highlights and whether the builtin offline (local) assistant understands it. ' +
        'Optionally pass role/permissions to see allowed/denied for a specific participant. ' +
        'Memory: the assistant acts strictly with the user permissions; the server re-checks and audits. Offline — no server needed.',
      inputSchema: z.object({
        role: roleSchema.optional().describe('Participant role to evaluate (uses the default config policy)'),
        permissions: z
          .array(featureKeySchema)
          .max(60)
          .optional()
          .describe('Explicit effective feature permissions (overrides role resolution)'),
      }),
      handler: (args) => {
        const tools = assistantToolInfos();
        const payload: Record<string, unknown> = {
          count: tools.length,
          tools,
          spotlightTargets: SPOTLIGHT_TARGETS,
          docs: 'agil/core/docs/in-call-agent.md',
          note:
            'Assistant actions are filtered by isAssistantToolAllowed() on the client and re-checked on the server; ' +
            'spotlight is UX-only and never changes state. local mode works offline (deterministic intent rules).',
        };
        if (args.role || args.permissions) {
          const role = args.role ?? 'guest';
          const config = defaultConfig({ tenantId: 'demo' });
          const permissions = args.permissions ?? resolveAccess({ config, role }).allowed;
          const context = { role, permissions: [...permissions] };
          payload.effectivePermissions = [...permissions];
          payload.allowed = tools.filter((tool) => isAssistantToolAllowed(tool.tool, context)).map((tool) => tool.tool);
          payload.denied = tools.filter((tool) => !isAssistantToolAllowed(tool.tool, context)).map((tool) => ({
            tool: tool.tool,
            requiredFeature: tool.requiredFeature,
            requiredRoles: tool.requiredRoles,
          }));
        }
        return jsonOutcome(payload);
      },
    }),

    defineTool({
      name: 'agil_explain_spotlight',
      title: 'Explain assistant spotlight',
      description:
        'Explain the in-call assistant spotlight ("where do I press?"): the 14 logical targets (mic, camera, screen, chat, files, participants, notes, settings, ' +
        'blur, recording, minimize, fullscreen, newtab, invite), where each control is, which assistant tools use it, required feature/role, multi-step tours and a11y. ' +
        'Returns markdown; pass `target` to focus on one control. Offline — no server needed.',
      inputSchema: z.object({
        target: z.enum(SPOTLIGHT_TARGETS).optional().describe('One logical target; omit to list all 14'),
      }),
      handler: (args) => ({ text: explainSpotlightMarkdown(args.target) }),
    }),

    defineTool({
      name: 'agil_explain_feature',
      title: 'Explain a feature with spotlight hints',
      description:
        'Explain a feature flag/capability: where it is enabled (features.*, accessPolicy, token permissions) and — crucially — its in-call assistant spotlight hint: ' +
        'which logical control the assistant highlights for "how do I …" requests, which tools it uses and how the tour works. ' +
        'Returns markdown. Offline — no server needed.',
      inputSchema: z.object({
        feature: z
          .string()
          .min(1)
          .max(60)
          .describe('Feature flag or capability name, e.g. recording, chat, screenShare, backgroundBlur, meetingNotes'),
      }),
      handler: (args) => ({ text: explainFeatureMarkdown(args.feature) }),
    }),

    defineTool({
      name: 'agil_explain_scaling',
      title: 'Explain scaling topology',
      description:
        'Offline guide to scaling AgilFrame: media modes mesh/sfu/broadcast, when you need Redis + multi-node signaling, an SFU (LiveKit/mediasoup), ' +
        'a TURN pool, webinar/broadcast mode, streaming egress and a CDN; capacity expectations and — honestly — what is implemented in the MVP vs roadmap. ' +
        'Includes ready JSON recipes for "webinar for 5000" and "add a TURN pool". References docs/scaling.md §4–§9. Offline — no server needed.',
      inputSchema: z.object({}),
      handler: () => ({ text: explainScalingMarkdown() }),
    }),

    defineTool({
      name: 'agil_explain_roles',
      title: 'Explain the roles model',
      description:
        'Offline guide to the permission model: three built-in roles (host/moderator/guest) vs up to 30 company-defined custom roles, ' +
        'exact precedence (token permissions → user override → custom role → strict → role defaults → deniedFeatures → enabled features), ' +
        'how to create/update/delete custom roles and issue a token with roleId, with ready examples for "оператор", "стример", "наблюдатель". ' +
        'References docs/api-guide.md §3 and docs/contract.md §18. Offline — no server needed.',
      inputSchema: z.object({}),
      handler: () => ({ text: explainRolesMarkdown() }),
    }),

    defineTool({
      name: 'agil_get_docs',
      title: 'Get AgilFrame documentation',
      description:
        'Return built-in markdown documentation: theming (tokens/presets/CSS vars), api (REST endpoints incl. access policy, knowledge agent, webhooks, OpenAPI), ' +
        'embedding (SDK, iframe, postMessage), security (keys, passwords, geo, audit, media integrity), mcp (this server: env, tools, recommended flow), ' +
        'ai-agent (local rules, notes, external agent). Use it to answer "how do I…" questions without reading the repository. Offline.',
      inputSchema: z.object({
        topic: docTopicSchema,
      }),
      handler: (args) => ({ text: DOCS[args.topic] }),
    }),
  ];
}

function applyThemeTool(name: string, alias: boolean): AnyToolSpec {
  return defineTool({
    name,
    title: alias ? 'Apply theme to config (alias)' : 'Apply theme to config',
    description:
      (alias ? 'Alias of agil_apply_theme_to_config (kept for compatibility with the contract naming). ' : '') +
      'Return a NEW validated TenantConfig with a theme applied. Accepts a config (full or patch), an optional brandColor, ' +
      'an optional deep-partial themePatch and/or a preset. Returns {config, theme, changes[], cssVars, audit}. ' +
      'Nothing is saved to the server — use agil_update_config for that. Offline — no server needed.',
    inputSchema: z.object({
      config: configInputSchema,
      brandColor: z.string().min(3).max(9).optional().describe('Brand color in hex; overrides primary/accent/etc.'),
      themePatch: themeInputSchema.optional().describe('Deep-partial theme patch'),
      preset: presetSchema.optional().describe('Start from this preset instead of the config theme'),
    }),
    handler: (args) => {
      const result = applyThemeToConfig(args);
      return jsonOutcome({
        config: result.config,
        theme: result.theme,
        changes: result.changes,
        changeSummary: result.changeSummary,
        cssVars: result.cssVars,
        audit: result.audit,
      });
    },
  });
}
