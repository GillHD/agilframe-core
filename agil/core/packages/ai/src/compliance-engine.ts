/**
 * Deterministic local compliance analysis for transcript segments.
 *
 * Runs entirely offline (no network, no LLM): phrase rules, regex rules and
 * built-in PII detectors. Findings are shaped by `ComplianceFinding` from
 * `@agil/protocol` with `source: 'local'`.
 *
 * Safety notes for regex rules:
 *   - patterns longer than {@link MAX_PATTERN_LENGTH} are ignored;
 *   - compilation is guarded with try/catch (a broken rule never breaks the call);
 *   - JavaScript has no regex timeout, so operators must keep custom regexes
 *     simple (no nested quantifiers / overlapping alternations) to avoid
 *     catastrophic backtracking on adversarial captions.
 */
import { randomUUID } from 'node:crypto';
import type {
  ComplianceAction,
  ComplianceFinding,
  CompliancePolicyRule,
  ComplianceSeverity,
  TranscriptSegment,
} from '@agil/protocol';
import { normalizeText, stemWord } from './text.js';

export interface ComplianceEngineOptions {
  rules: CompliancePolicyRule[];
}

/** Built-in PII detector kinds. */
export type PiiKind = 'email' | 'phone' | 'card' | 'inn';

interface PiiRuleDefaults {
  id: string;
  name: string;
  kind: PiiKind;
  severity: ComplianceSeverity;
  action: ComplianceAction;
}

const PII_DEFAULTS: readonly PiiRuleDefaults[] = [
  { id: 'pii.email', name: 'Email address', kind: 'email', severity: 'warn', action: 'flag' },
  { id: 'pii.phone', name: 'Phone number', kind: 'phone', severity: 'warn', action: 'flag' },
  { id: 'pii.card', name: 'Payment card number', kind: 'card', severity: 'critical', action: 'warn' },
  { id: 'pii.inn', name: 'СНИЛС / ИНН', kind: 'inn', severity: 'critical', action: 'warn' },
];

/**
 * Ready-to-use PII policy rules. A tenant policy can copy these into
 * `session.aiAgent.policyRules` and toggle `enabled` per detector.
 */
export const DEFAULT_PII_RULES: CompliancePolicyRule[] = PII_DEFAULTS.map((d) => ({
  id: d.id,
  name: d.name,
  type: 'pii',
  pattern: d.kind,
  severity: d.severity,
  action: d.action,
  enabled: true,
}));

const MAX_PATTERN_LENGTH = 500;
const MAX_MATCHES_PER_RULE = 3;
const MAX_EXCERPT_LENGTH = 200;
const PHRASE_MAX_GAP = 80;

const PII_RECOMMENDATION: Record<PiiKind, string> = {
  email: 'Email может содержать персональные данные — уточните основание обработки (152-ФЗ).',
  phone: 'Номер телефона относится к персональным данным — проверьте согласие участника.',
  card: 'Номер банковской карты (PCI DSS) не должен попадать в транскрипт и заметки.',
  inn: 'СНИЛС/ИНН — персональные данные; ограничьте их распространение и хранение.',
};

/**
 * Split a phrase rule into per-word stems. Multi-word rules match when every
 * stem is found in order with a small gap (crude morphology support).
 */
function phraseStems(pattern: string): string[] {
  const words = normalizeText(pattern).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  const stems: string[] = [];
  for (const word of words) {
    const stem = stemWord(word);
    if (stem.length > 0) stems.push(stem);
  }
  return stems;
}

interface TextMatch {
  start: number;
  end: number;
}

function findPhraseMatches(text: string, pattern: string): TextMatch[] {
  if (!pattern || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return [];
  const stems = phraseStems(pattern);
  const first = stems[0];
  if (first === undefined) return [];

  const norm = normalizeText(text);
  const out: TextMatch[] = [];

  if (stems.length === 1) {
    let from = 0;
    while (out.length < MAX_MATCHES_PER_RULE) {
      const index = norm.indexOf(first, from);
      if (index < 0) break;
      out.push({ start: index, end: index + first.length });
      from = index + first.length;
    }
    return out;
  }

  let from = 0;
  while (out.length < MAX_MATCHES_PER_RULE) {
    const start = norm.indexOf(first, from);
    if (start < 0) break;
    let cursor = start + first.length;
    let matched = true;
    for (let i = 1; i < stems.length; i++) {
      const stem = stems[i];
      if (stem === undefined) break;
      const found = norm.indexOf(stem, cursor);
      if (found < 0 || found - cursor > PHRASE_MAX_GAP) {
        matched = false;
        break;
      }
      cursor = found + stem.length;
    }
    if (matched) out.push({ start, end: cursor });
    from = start + 1;
  }
  return out;
}

function compileRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return null;
  try {
    return new RegExp(pattern, 'gi');
  } catch {
    return null;
  }
}

/** Quote around a match, ≤200 chars, with ellipses when clipped. */
function excerptAround(text: string, start: number, end: number, max = MAX_EXCERPT_LENGTH): string {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  const matchLength = Math.min(safeEnd - safeStart, max - 60);
  const pad = Math.max(0, Math.floor((max - matchLength) / 2));
  let from = Math.max(0, safeStart - pad);
  let to = Math.min(text.length, from + max);

  if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    if (space > safeEnd) to = space;
  }
  if (from > 0) {
    const space = text.indexOf(' ', from);
    if (space >= 0 && space < safeStart) from = space + 1;
  }

  let out = text.slice(from, to).trim();
  if (from > 0) out = `…${out}`;
  if (to < text.length) out = `${out}…`;
  if (out.length > max) {
    let cut = out.slice(0, max);
    const space = cut.lastIndexOf(' ');
    if (space > max * 0.5) cut = cut.slice(0, space);
    out = `${cut}…`;
    if (out.length > max) out = out.slice(0, max);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PII detectors                                                       */
/* ------------------------------------------------------------------ */

interface PiiMatch extends TextMatch {
  kind: PiiKind;
  value: string;
}

const EMAIL_RE = /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,24}/gu;
const PHONE_CANDIDATE_RE = /[+\d][\d\s().-]{7,20}\d/g;
const CARD_CANDIDATE_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const INN10_RE = /(?<!\d)\d{10}(?!\d)/g;
const INN12_RE = /(?<!\d)\d{12}(?!\d)/g;
const SNILS_RE = /(?<!\d)\d{3}-\d{3}-\d{3}[ -]?\d{2}(?!\d)/g;
const SNILS_LIKE_RE = /^\d{3}-\d{3}-\d{3}[ -]?\d{2}$/;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function detectEmail(text: string): PiiMatch[] {
  const out: PiiMatch[] = [];
  for (const match of text.matchAll(EMAIL_RE)) {
    if (match.index === undefined) continue;
    out.push({ kind: 'email', start: match.index, end: match.index + match[0].length, value: match[0] });
  }
  return out;
}

function detectPhone(text: string): PiiMatch[] {
  const out: PiiMatch[] = [];
  for (const match of text.matchAll(PHONE_CANDIDATE_RE)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) continue;
    const hasSeparators = /[\s().-]/.test(raw);
    const hasPlus = raw.startsWith('+');
    if (!hasSeparators && !hasPlus) {
      // A bare digit run is only a phone when it is an 11-digit RU number.
      if (!(digits.length === 11 && /^[78]/.test(digits))) continue;
    }
    // СНИЛС has its own detector; do not report it as a phone number too.
    if (SNILS_LIKE_RE.test(raw.trim())) continue;
    out.push({ kind: 'phone', start: match.index, end: match.index + raw.length, value: raw });
  }
  return out;
}

function detectCard(text: string): PiiMatch[] {
  const out: PiiMatch[] = [];
  for (const match of text.matchAll(CARD_CANDIDATE_RE)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (/^0+$/.test(digits)) continue;
    if (!luhnValid(digits)) continue;
    out.push({ kind: 'card', start: match.index, end: match.index + raw.length, value: raw });
  }
  return out;
}

function detectInn(text: string): PiiMatch[] {
  const out: PiiMatch[] = [];
  const patterns: readonly RegExp[] = [SNILS_RE, INN12_RE, INN10_RE];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      out.push({ kind: 'inn', start: match.index, end: match.index + match[0].length, value: match[0] });
    }
  }
  return out;
}

const PII_DETECTORS: Record<PiiKind, (text: string) => PiiMatch[]> = {
  email: detectEmail,
  phone: detectPhone,
  card: detectCard,
  inn: detectInn,
};

function detectPii(text: string, kinds: readonly PiiKind[]): PiiMatch[] {
  const out: PiiMatch[] = [];
  for (const kind of kinds) {
    out.push(...PII_DETECTORS[kind](text));
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Map a `type: 'pii'` policy rule to built-in detectors. */
function resolvePiiKinds(rule: CompliancePolicyRule): PiiKind[] {
  const hint = `${rule.id} ${rule.pattern}`.toLowerCase();
  const kinds = (Object.keys(PII_DETECTORS) as PiiKind[]).filter((kind) => hint.includes(kind));
  return kinds.length > 0 ? kinds : (Object.keys(PII_DETECTORS) as PiiKind[]);
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

/**
 * Deterministic local compliance engine.
 *
 * ```ts
 * const engine = new ComplianceEngine({ rules: [...DEFAULT_PII_RULES, customRule] });
 * const findings = engine.analyzeSegments(segments);
 * ```
 */
export class ComplianceEngine {
  private readonly rules: readonly CompliancePolicyRule[];

  constructor(opts: ComplianceEngineOptions) {
    this.rules = Array.isArray(opts?.rules) ? opts.rules.filter((rule) => rule !== null && rule !== undefined) : [];
  }

  /** All configured rules (including disabled ones). */
  getRules(): CompliancePolicyRule[] {
    return [...this.rules];
  }

  analyzeSegment(segment: TranscriptSegment): ComplianceFinding[] {
    if (!segment || typeof segment.text !== 'string' || segment.text.length === 0) return [];
    const text = segment.text;
    const findings: ComplianceFinding[] = [];
    const seen = new Set<string>();

    for (const rule of this.rules) {
      if (!rule || rule.enabled !== true) continue;
      try {
        if (rule.type === 'phrase') {
          for (const match of findPhraseMatches(text, rule.pattern)) {
            this.pushFinding(findings, seen, rule, segment, excerptAround(text, match.start, match.end), 1);
          }
        } else if (rule.type === 'regex') {
          const regex = compileRegex(rule.pattern);
          if (!regex) continue;
          let count = 0;
          for (const match of text.matchAll(regex)) {
            if (match.index === undefined) continue;
            const start = match.index;
            const end = start + match[0].length;
            this.pushFinding(findings, seen, rule, segment, excerptAround(text, start, end), 1);
            count += 1;
            if (count >= MAX_MATCHES_PER_RULE) break;
          }
        } else if (rule.type === 'pii') {
          for (const match of detectPii(text, resolvePiiKinds(rule))) {
            this.pushFinding(
              findings,
              seen,
              rule,
              segment,
              excerptAround(text, match.start, match.end),
              1,
              PII_RECOMMENDATION[match.kind],
            );
          }
        }
        // 'external' rules are handled by the corporate AI agent, not locally.
      } catch {
        // A malformed rule must never break transcript analysis.
        continue;
      }
    }
    return findings;
  }

  /** Analyze a batch of segments (transcript) in order. */
  analyzeSegments(segments: readonly TranscriptSegment[]): ComplianceFinding[] {
    const findings: ComplianceFinding[] = [];
    if (!Array.isArray(segments)) return findings;
    for (const segment of segments) {
      try {
        findings.push(...this.analyzeSegment(segment));
      } catch {
        continue;
      }
    }
    return findings;
  }

  private pushFinding(
    findings: ComplianceFinding[],
    seen: Set<string>,
    rule: CompliancePolicyRule,
    segment: TranscriptSegment,
    excerpt: string,
    confidence: number,
    recommendation?: string,
  ): void {
    if (excerpt.length === 0) return;
    const key = `${rule.id}\u0000${excerpt}`;
    if (seen.has(key)) return;
    seen.add(key);
    const finding: ComplianceFinding = {
      id: randomUUID(),
      ts: segment.ts,
      ruleId: rule.id,
      ruleName: rule.name,
      source: 'local',
      severity: rule.severity,
      action: rule.action,
      excerpt,
      confidence,
    };
    if (segment.participantId) finding.participantId = segment.participantId;
    if (segment.participantName) finding.participantName = segment.participantName;
    if (recommendation) finding.recommendation = recommendation;
    findings.push(finding);
  }
}
