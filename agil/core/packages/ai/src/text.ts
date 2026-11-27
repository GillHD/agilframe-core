/**
 * Internal text utilities shared by the local compliance engine and the
 * extractive notes extractor.
 *
 * Everything here is deterministic and dependency-free: crude normalization,
 * crude RU/EN stemming (enough for substring cue matching), sentence splitting
 * and verbatim clamping (never paraphrases, so `excerpt.text` stays a real
 * substring of the transcript segment).
 */

/** Lowercase + `ё → е`. Length-preserving on purpose: match indexes stay valid. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

export function hasCyrillic(word: string): boolean {
  return /[а-яё]/i.test(word);
}

const RU_ENDINGS: readonly string[] = [
  'ованиями', 'ованиям', 'ования', 'ование', 'овании',
  'ениями', 'ениям', 'ения', 'ению', 'ение', 'ении',
  'иями', 'ями', 'ами', 'ость', 'ности', 'ность',
  'ились', 'ылись', 'илась', 'ылась', 'ился', 'ылся', 'илось', 'ылось',
  'ать', 'ять', 'ить', 'еть', 'уть', 'ыть',
  'ают', 'яют', 'уют', 'ает', 'яет', 'ует', 'аем', 'яем', 'уем',
  'ал', 'ала', 'али', 'ало', 'ил', 'ила', 'или', 'ило', 'ел', 'ела', 'ели', 'ело',
  'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ие', 'ые', 'ых', 'их', 'ую', 'юю',
  'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ой', 'ей', 'ом', 'ем',
  'ам', 'ям', 'ах', 'ях', 'ии', 'ия', 'ию', 'ием',
  'ов', 'ев', 'ёв', 'ся', 'сь',
  'а', 'е', 'и', 'й', 'о', 'у', 'ы', 'ь', 'я', 'ю',
];

const RU_ENDINGS_SORTED: readonly string[] = [...RU_ENDINGS].sort((a, b) => b.length - a.length);

const EN_ENDINGS: readonly string[] = [
  'ingly', 'edly', 'ation', 'ments', 'ment', 'ness', 'ities', 'ity', 'ies', 'ing', 'ied', 'ed', 'es', 'ly', 's',
];

/** Crude Russian stem: strip the longest known ending while keeping ≥3 chars. */
export function stemRu(word: string): string {
  for (const ending of RU_ENDINGS_SORTED) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

/** Crude English stem (plural/gerund/past suffixes). */
export function stemEn(word: string): string {
  for (const ending of EN_ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

export function stemWord(word: string): string {
  return hasCyrillic(word) ? stemRu(word) : stemEn(word);
}

/** Lowercased letter words (no punctuation, no numbers). */
export function wordTokens(text: string): string[] {
  return normalizeText(text).match(/\p{L}+/gu) ?? [];
}

export interface SentenceSpan {
  /** Verbatim (trimmed) slice of the original text. */
  text: string;
  start: number;
  end: number;
}

/** Split text into sentence-ish spans without losing verbatim substrings. */
export function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  // A terminator only ends a sentence when followed by whitespace/end: this
  // keeps dates and decimals ("до 15.03", "3.5%") inside one sentence.
  const boundary = /[.!?…]+(?=\s|$)/g;
  let cursor = 0;
  for (const match of text.matchAll(boundary)) {
    if (match.index === undefined) continue;
    const end = match.index + match[0].length;
    if (end > cursor) {
      const span = spanFrom(text, cursor, end);
      if (span) spans.push(span);
    }
    cursor = end;
  }
  if (cursor < text.length) {
    const span = spanFrom(text, cursor, text.length);
    if (span) spans.push(span);
  }
  return spans;
}

function spanFrom(text: string, from: number, to: number): SentenceSpan | null {
  const raw = text.slice(from, to);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;
  const leading = raw.length - raw.trimStart().length;
  const start = from + leading;
  return { text: trimmed, start, end: start + trimmed.length };
}

/**
 * Truncate text to `max` chars **verbatim** (the result is always a substring
 * of the input; no ellipsis is appended so `text.includes(result)` holds).
 */
export function clampVerbatim(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  if (space > Math.floor(max * 0.55)) cut = cut.slice(0, space);
  return cut;
}

/** Heuristic language detection by Cyrillic/Latin letter counts. */
export function detectLanguage(text: string): 'ru' | 'en' {
  let cyrillic = 0;
  let latin = 0;
  for (const char of text) {
    if (/[а-яё]/i.test(char)) cyrillic += 1;
    else if (/[a-z]/i.test(char)) latin += 1;
  }
  if (cyrillic === 0 && latin === 0) return 'ru';
  return cyrillic >= latin ? 'ru' : 'en';
}
