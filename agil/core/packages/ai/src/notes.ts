/**
 * Extract-only meeting notes ("заметки") without an LLM.
 *
 * Everything here is deterministic and offline:
 *   - `summary` is built by ranking transcript segments (term frequency,
 *     position, length) — it is a concatenation of original segments, not a
 *     paraphrase;
 *   - `excerpts` are verbatim quotes (`excerpt.text` is always a real substring
 *     of the source segment) with timecodes, speaker and a reason (`note`);
 *   - `actionItems` come from RU/EN cue phrases with a speaker owner and a due
 *     date extracted by regexes;
 *   - `decisions`/`risks` are derived from the matching excerpts;
 *   - `topics` are the top-8 content words, `sentiment` is a small RU/EN
 *     lexicon score.
 *
 * This is the offline fallback path for `session.aiAgent.mode: 'local'`.
 */
import { randomUUID } from 'node:crypto';
import type { ActionItem, ExcerptKind, MeetingNotes, TranscriptExcerpt, TranscriptSegment } from '@agil/protocol';
import {
  clampVerbatim,
  detectLanguage,
  normalizeText,
  splitSentences,
  stemWord,
  wordTokens,
} from './text.js';
import type { SentenceSpan } from './text.js';

export interface ExtractNotesOptions {
  locale?: 'ru' | 'en';
  maxExcerpts?: number;
  maxActionItems?: number;
}

const DEFAULT_MAX_EXCERPTS = 8;
const DEFAULT_MAX_ACTION_ITEMS = 10;
const MAX_EXCERPT_CHARS = 600;
const MAX_SUMMARY_CHARS = 4000;
const MAX_SUMMARY_PART_CHARS = 280;
const MAX_TOPICS = 8;
const SUMMARY_MIN_SENTENCES = 3;
const SUMMARY_MAX_SENTENCES = 6;

/* ------------------------------------------------------------------ */
/* Stop words and sentiment lexicons                                   */
/* ------------------------------------------------------------------ */

const RU_STOPWORDS = new Set(
  (
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот ' +
    'от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять ' +
    'уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без ' +
    'будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти ' +
    'мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше ' +
    'тот через эти нас про всего них какая много разве три эту моя впрочем свою этой перед иногда лучше чуть том ' +
    'нельзя такой им более всегда конечно всю между это также наш очень кстати значит вообще просто типа такая ' +
    'такие таких этим этих этой этом вот ладно окей давайте сегодня вчера завтра потом сначала дальше надо ли бы'
  ).split(/\s+/),
);

const EN_STOPWORDS = new Set(
  (
    "the a an and or but if then so of to in on at for with from by about as is are was were be been being am do " +
    "does did have has had will would can could should may might must i you he she it we they me him her us them my " +
    "your his its our their this that these those there here what which who whom whose when where why how not no yes " +
    "just very really also too only more most some any all each every both few many much other another such than into " +
    "over under again further once during before after above below up down out off own same doing done get got make " +
    "made like well okay ok going gonna want know think see look say said tell let lets were we're we'll i'm i'll " +
    "don't doesn't didn't isn't aren't won't can't couldn't shouldn't wouldn't yeah right thing things kind sort lot"
  ).split(/\s+/),
);

const POSITIVE_STEMS: readonly string[] = [
  'хорош', 'отличн', 'здоров', 'спасиб', 'супер', 'класс', 'замечательн', 'прекрасн', 'рад', 'радост',
  'успешн', 'успех', 'довольн', 'круто', 'полезн', 'эффективн', 'удобн', 'соглас', 'молодц', 'улучш',
  'позитивн', 'надежн', 'прогресс', 'плюс', 'рекоменд', 'воодушев',
];

const NEGATIVE_STEMS: readonly string[] = [
  'плох', 'проблем', 'риск', 'ужасн', 'провал', 'срыв', 'ошибк', 'недовольн', 'сложн', 'тяжел', 'трудно',
  'неясн', 'непонятн', 'сожален', 'отказ', 'задержк', 'срочн', 'стресс', 'негативн', 'конфликт', 'неуспева',
  'потер', 'штраф', 'авари', 'минус', 'деградац', 'инцидент', 'блокер', 'угроз', 'опасн', 'раздража',
];

const POSITIVE_EN_STEMS: readonly string[] = [
  'good', 'great', 'excellen', 'awesom', 'happy', 'thank', 'agree', 'nice', 'perfect', 'succes', 'improv',
  'useful', 'effectiv', 'love', 'glad', 'positiv', 'reliab', 'helpful', 'progress', 'benefit', 'win',
];

const NEGATIVE_EN_STEMS: readonly string[] = [
  'bad', 'problem', 'issue', 'risk', 'terribl', 'awful', 'fail', 'error', 'bug', 'concern', 'worr', 'difficult',
  'delay', 'late', 'blocker', 'block', 'stress', 'negativ', 'conflict', 'loss', 'lost', 'penalt', 'crash',
  'broken', 'incident', 'unclear',
];

function isStopword(word: string): boolean {
  return word.length <= 2 || RU_STOPWORDS.has(word) || EN_STOPWORDS.has(word);
}

/* ------------------------------------------------------------------ */
/* Cue phrases                                                         */
/* ------------------------------------------------------------------ */

interface CueSpec {
  kind: ExcerptKind;
  weight: number;
  ru: readonly string[];
  en: readonly string[];
}

const ACTION_RU: readonly string[] = [
  'сдела', 'нужн', 'надо', 'необходим', 'дедлайн', 'подготов', 'провер', 'отправ', 'займ', 'напиш',
  'позвон', 'созвон', 'срок', 'поруч', 'выполн', 'запланир',
];

const ACTION_EN: readonly string[] = [
  'i will', "i'll", 'we will', "we'll", 'action item', 'need to', 'needs to', 'must', 'deadline',
  'follow up', 'take care', 'prepare', 'assign', 'will do', 'will send',
];

const DECISION_SPEC: CueSpec = {
  kind: 'decision',
  weight: 90,
  ru: ['решил', 'решен', 'реши', 'договор', 'итог', 'постановил', 'согласовал', 'утвердил'],
  en: ['we decided', 'decided', 'agreed', 'agreement', 'decision', 'we will go with'],
};

const RISK_SPEC: CueSpec = {
  kind: 'risk',
  weight: 70,
  ru: ['риск', 'проблем', 'опасн', 'угроз', 'срыв', 'неуспева', 'провал', 'инцидент', 'авари', 'задерж', 'штраф', 'конфликт'],
  en: ['risk', 'problem', 'issue', 'concern', 'danger', 'threat', 'delay', 'blocker', 'fail', 'failure'],
};

const ACTION_SPEC: CueSpec = {
  kind: 'action_item',
  weight: 65,
  ru: ACTION_RU,
  en: ACTION_EN,
};

const QUESTION_SPEC: CueSpec = {
  kind: 'question',
  weight: 40,
  ru: ['вопрос', 'неясн', 'уточн', 'непонятн'],
  en: ['question', 'clarify', 'unclear'],
};

const KEY_POINT_SPEC: CueSpec = {
  kind: 'key_point',
  weight: 0,
  ru: ['важно', 'ключев', 'главн', 'основн', 'факт', 'внимание', 'вывод'],
  en: ['important', 'key point', 'main point', 'critical point', 'takeaway', 'conclusion'],
};

/** Priority order when a single segment matches several cue families. */
const CUE_SPECS: readonly CueSpec[] = [DECISION_SPEC, RISK_SPEC, ACTION_SPEC, QUESTION_SPEC, KEY_POINT_SPEC];

function matchCue(normalizedText: string, spec: CueSpec): string | null {
  const words = wordTokens(normalizedText);
  for (const list of [spec.ru, spec.en]) {
    for (const cue of list) {
      if (cue.includes(' ') || cue.includes("'")) {
        if (normalizedText.includes(cue)) return cue;
      } else if (words.some((word) => word.startsWith(cue))) {
        return cue;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Due-date extraction                                                 */
/* ------------------------------------------------------------------ */

const DUE_PATTERNS: readonly RegExp[] = [
  /(?:(?:до|к|by)\s+)?\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/i,
  /(?:(?:до|к|в|by|on)\s+)(?:понедельник[а-яё]*|вторник[а-яё]*|сред[а-яё]*|четверг[а-яё]*|пятниц[а-яё]*|суббот[а-яё]*|воскресень[а-яё]*|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  /\b(?:завтра|послезавтра|сегодня|на следующей неделе|на этой неделе|до конца (?:дня|недели|месяца)|к концу (?:дня|недели|месяца)|tomorrow|today|tonight|next week|this week|end of (?:day|week|month)|eod)\b/i,
];

function findDue(text: string): string | undefined {
  for (const pattern of DUE_PATTERNS) {
    const match = pattern.exec(text);
    const raw = match?.[0];
    if (raw) {
      const due = raw.trim().replace(/\s+/g, ' ').slice(0, 64);
      if (due.length > 0) return due;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Internal segment analysis                                           */
/* ------------------------------------------------------------------ */

interface Token {
  stem: string;
  display: string;
}

interface KeywordStat {
  stem: string;
  count: number;
  displays: Map<string, number>;
}

interface SegmentInfo {
  segment: TranscriptSegment;
  text: string;
  tokens: Token[];
  sentences: SentenceSpan[];
}

function isUsableSegment(segment: TranscriptSegment | null | undefined): segment is TranscriptSegment {
  if (segment === null || segment === undefined) return false;
  return typeof segment.text === 'string' && segment.text.trim().length > 0;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const word of wordTokens(text)) {
    if (isStopword(word)) continue;
    tokens.push({ stem: stemWord(word), display: word });
  }
  return tokens;
}

function collectSegmentInfo(segments: readonly TranscriptSegment[]): SegmentInfo[] {
  const infos: SegmentInfo[] = [];
  for (const segment of segments) {
    if (!isUsableSegment(segment)) continue;
    const text = segment.text;
    infos.push({
      segment,
      text,
      tokens: tokenize(text),
      sentences: splitSentences(text),
    });
  }
  infos.sort((a, b) => a.segment.start - b.segment.start);
  return infos;
}

function buildKeywordStats(infos: readonly SegmentInfo[]): Map<string, KeywordStat> {
  const stats = new Map<string, KeywordStat>();
  for (const info of infos) {
    for (const token of info.tokens) {
      let stat = stats.get(token.stem);
      if (!stat) {
        stat = { stem: token.stem, count: 0, displays: new Map<string, number>() };
        stats.set(token.stem, stat);
      }
      stat.count += 1;
      stat.displays.set(token.display, (stat.displays.get(token.display) ?? 0) + 1);
    }
  }
  return stats;
}

function bestDisplay(stat: KeywordStat): string {
  let best = '';
  let bestCount = -1;
  for (const [display, count] of stat.displays) {
    if (count > bestCount || (count === bestCount && display.length > best.length)) {
      best = display;
      bestCount = count;
    }
  }
  return best;
}

function topTopics(stats: Map<string, KeywordStat>, limit: number): string[] {
  return [...stats.values()]
    .sort((a, b) => b.count - a.count || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0))
    .slice(0, limit)
    .map((stat) => bestDisplay(stat).slice(0, 120))
    .filter((topic) => topic.length > 0);
}

function keywordScore(tokens: readonly Token[], stats: Map<string, KeywordStat>): number {
  if (tokens.length === 0) return 0;
  let sum = 0;
  for (const token of tokens) {
    sum += Math.log(1 + (stats.get(token.stem)?.count ?? 0));
  }
  return sum / Math.sqrt(tokens.length);
}

function positionBonus(index: number, total: number): number {
  if (total <= 1) return 1;
  return (1 - index / total) * 2;
}

function lengthBonus(tokens: readonly Token[]): number {
  return Math.min(2, tokens.length / 10);
}

/* ------------------------------------------------------------------ */
/* Excerpts / summary / actions                                        */
/* ------------------------------------------------------------------ */

interface SegmentCue {
  kind: ExcerptKind;
  cue: string;
  sentence: SentenceSpan;
  weight: number;
}

function classifySegment(info: SegmentInfo): SegmentCue | null {
  for (const spec of CUE_SPECS) {
    for (const sentence of info.sentences) {
      const cue = matchCue(normalizeText(sentence.text), spec);
      if (cue !== null) return { kind: spec.kind, cue, sentence, weight: spec.weight };
    }
  }
  for (const sentence of info.sentences) {
    if (sentence.text.includes('?')) return { kind: 'question', cue: '?', sentence, weight: QUESTION_SPEC.weight };
  }
  return null;
}

function bestSentence(info: SegmentInfo): SentenceSpan | null {
  let best: SentenceSpan | null = null;
  let bestScore = -1;
  for (const sentence of info.sentences) {
    const score = tokenize(sentence.text).length;
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  return best;
}

function excerptNote(cue: SegmentCue, locale: 'ru' | 'en'): string {
  const labels: Record<ExcerptKind, { ru: string; en: string }> = {
    decision: { ru: 'принятое решение', en: 'decision' },
    action_item: { ru: 'задача / поручение', en: 'action item' },
    risk: { ru: 'риск', en: 'risk' },
    question: { ru: 'открытый вопрос', en: 'open question' },
    key_point: { ru: 'ключевой тезис', en: 'key point' },
  };
  const label = labels[cue.kind][locale];
  return locale === 'en'
    ? `Selected by cue "${cue.cue}" (${label}).`
    : `Выбрано по cue-фразе «${cue.cue}» (${label}).`;
}

interface ExcerptCandidate {
  segmentId: string;
  excerpt: TranscriptExcerpt;
  score: number;
  start: number;
}

function buildExcerptCandidates(infos: readonly SegmentInfo[], stats: Map<string, KeywordStat>, locale: 'ru' | 'en'): ExcerptCandidate[] {
  const candidates: ExcerptCandidate[] = [];
  infos.forEach((info, index) => {
    const cue = classifySegment(info);
    const score =
      (cue?.weight ?? 0) +
      keywordScore(info.tokens, stats) +
      positionBonus(index, infos.length) +
      lengthBonus(info.tokens);

    let kind: ExcerptKind = 'key_point';
    let text: string;
    let note: string;
    if (cue !== null) {
      kind = cue.kind;
      text = clampVerbatim(cue.sentence.text, MAX_EXCERPT_CHARS);
      note = excerptNote(cue, locale);
    } else {
      const sentence = bestSentence(info);
      text = clampVerbatim(sentence ? sentence.text : info.text.trim(), MAX_EXCERPT_CHARS);
      note =
        locale === 'en'
          ? 'Key point selected by term frequency and position.'
          : 'Ключевой тезис: частотность терминов и позиция в разговоре.';
    }
    if (text.length === 0) return;

    const excerpt: TranscriptExcerpt = {
      id: randomUUID(),
      kind,
      text,
      participantId: info.segment.participantId,
      start: info.segment.start,
      end: info.segment.end,
      note,
    };
    if (info.segment.participantName) excerpt.participantName = info.segment.participantName;
    candidates.push({ segmentId: info.segment.id, excerpt, score, start: info.segment.start });
  });
  return candidates;
}

function selectExcerpts(candidates: readonly ExcerptCandidate[], maxExcerpts: number): ExcerptCandidate[] {
  const seen = new Set<string>();
  const unique: ExcerptCandidate[] = [];
  for (const candidate of candidates) {
    const key = normalizeText(candidate.excerpt.text);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  unique.sort((a, b) => b.score - a.score || a.start - b.start || a.segmentId.localeCompare(b.segmentId));
  return unique.slice(0, maxExcerpts).sort((a, b) => a.start - b.start);
}

function buildSummary(infos: readonly SegmentInfo[], stats: Map<string, KeywordStat>): string {
  if (infos.length === 0) return '';
  const wanted = Math.min(
    infos.length,
    Math.max(SUMMARY_MIN_SENTENCES, Math.min(SUMMARY_MAX_SENTENCES, Math.ceil(infos.length * 0.4))),
  );
  const ranked = infos
    .map((info, index) => ({
      info,
      index,
      score: keywordScore(info.tokens, stats) + positionBonus(index, infos.length) + lengthBonus(info.tokens),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, wanted)
    .sort((a, b) => a.index - b.index);

  const parts: string[] = [];
  for (const item of ranked) {
    const part = clampVerbatim(item.info.text.trim(), MAX_SUMMARY_PART_CHARS);
    if (part.length > 0) parts.push(part);
  }
  let summary = parts.join(' ');
  if (summary.length > MAX_SUMMARY_CHARS) summary = clampVerbatim(summary, MAX_SUMMARY_CHARS);
  return summary;
}

function extractActionItems(
  infos: readonly SegmentInfo[],
  excerptIdBySegment: Map<string, string>,
  maxActionItems: number,
): ActionItem[] {
  const items: ActionItem[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    for (const sentence of info.sentences) {
      const cue = matchCue(normalizeText(sentence.text), ACTION_SPEC);
      if (cue === null) continue;
      const text = clampVerbatim(sentence.text, MAX_EXCERPT_CHARS);
      if (text.length === 0) continue;
      const key = normalizeText(text);
      if (seen.has(key)) continue;
      seen.add(key);

      const item: ActionItem = {
        id: randomUUID(),
        text,
        sourceTs: info.segment.ts,
      };
      if (info.segment.participantName) item.owner = info.segment.participantName;
      else if (info.segment.participantId) item.owner = info.segment.participantId;
      const due = findDue(sentence.text) ?? findDue(info.text);
      if (due) item.due = due;
      const excerptId = excerptIdBySegment.get(info.segment.id);
      if (excerptId) item.excerptId = excerptId;
      items.push(item);
      if (items.length >= maxActionItems) return items;
    }
  }
  return items;
}

function collectByKind(excerpts: readonly TranscriptExcerpt[], kind: ExcerptKind): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const excerpt of excerpts) {
    if (excerpt.kind !== kind) continue;
    const key = normalizeText(excerpt.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clampVerbatim(excerpt.text, 600));
  }
  return out;
}

function sentimentOf(infos: readonly SegmentInfo[]): 'positive' | 'neutral' | 'negative' {
  let positive = 0;
  let negative = 0;
  for (const info of infos) {
    for (const word of wordTokens(info.text)) {
      if (word.length < 3) continue;
      if (POSITIVE_STEMS.some((stem) => word.startsWith(stem)) || POSITIVE_EN_STEMS.some((stem) => word.startsWith(stem))) {
        positive += 1;
      } else if (
        NEGATIVE_STEMS.some((stem) => word.startsWith(stem)) ||
        NEGATIVE_EN_STEMS.some((stem) => word.startsWith(stem))
      ) {
        negative += 1;
      }
    }
  }
  if (positive + negative === 0) return 'neutral';
  const ratio = (positive - negative) / (positive + negative);
  if (ratio >= 0.25) return 'positive';
  if (ratio <= -0.25) return 'negative';
  return 'neutral';
}

function clampCount(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/* ------------------------------------------------------------------ */
/* Public extractor                                                    */
/* ------------------------------------------------------------------ */

/**
 * Deterministic extractive meeting-notes extractor.
 *
 * ```ts
 * const extractor = new LocalNotesExtractor();
 * const notes = extractor.extract(segments, { locale: 'ru', maxExcerpts: 8 });
 * ```
 */
export class LocalNotesExtractor {
  extract(segments: readonly TranscriptSegment[], opts: ExtractNotesOptions = {}): MeetingNotes {
    const input = Array.isArray(segments) ? segments : [];
    const infos = collectSegmentInfo(input);
    const locale = opts.locale ?? detectLanguage(infos.map((info) => info.text).join(' '));
    const stats = buildKeywordStats(infos);

    const candidates = buildExcerptCandidates(infos, stats, locale);
    const maxExcerpts = clampCount(opts.maxExcerpts, DEFAULT_MAX_EXCERPTS, 1, 50);
    const selected = selectExcerpts(candidates, maxExcerpts);
    const excerpts = selected.map((candidate) => candidate.excerpt);

    const excerptIdBySegment = new Map<string, string>();
    for (const candidate of selected) {
      if (!excerptIdBySegment.has(candidate.segmentId)) {
        excerptIdBySegment.set(candidate.segmentId, candidate.excerpt.id);
      }
    }

    const maxActionItems = clampCount(opts.maxActionItems, DEFAULT_MAX_ACTION_ITEMS, 1, 50);
    const actionItems = extractActionItems(infos, excerptIdBySegment, maxActionItems);

    return {
      summary: buildSummary(infos, stats),
      excerpts,
      actionItems,
      decisions: collectByKind(selected.map((candidate) => candidate.excerpt), 'decision'),
      risks: collectByKind(selected.map((candidate) => candidate.excerpt), 'risk'),
      topics: topTopics(stats, MAX_TOPICS),
      sentiment: sentimentOf(infos),
      source: 'local',
      segmentsAnalyzed: infos.length,
      createdAt: Date.now(),
      language: locale,
    };
  }
}
