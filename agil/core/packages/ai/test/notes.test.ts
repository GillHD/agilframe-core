import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptSegment } from '@agil/protocol';
import { LocalNotesExtractor } from '../src/index.js';

function seg(id: string, name: string, text: string, start: number): TranscriptSegment {
  return {
    id,
    participantId: id,
    participantName: name,
    text,
    start,
    end: start + 4,
    isFinal: true,
    ts: 1_700_000_000_000 + start * 1000,
  };
}

const RU_SEGMENTS: TranscriptSegment[] = [
  seg('s1', 'Иван', 'Добрый день, начинаем встречу по проекту интеграции с корпоративным порталом.', 0),
  seg('s2', 'Иван', 'Мы решили запустить пилот интеграции в следующем квартале.', 4),
  seg('s3', 'Мария', 'Есть риск, что не хватит ресурсов команды.', 8),
  seg('s4', 'Иван', 'Анна, ты сделаешь отчёт до 15.03?', 12),
  seg('s5', 'Анна', 'Да, я сделаю отчёт до 15.03 и отправлю всем.', 16),
  seg('s6', 'Мария', 'Также нужно подготовить презентацию для совета директоров.', 20),
  seg('s7', 'Иван', 'Какой вопрос по бюджету обсуждаем?', 24),
  seg('s8', 'Мария', 'Бюджет согласован, спасибо за работу, всё отлично.', 28),
];

const EN_SEGMENTS: TranscriptSegment[] = [
  seg('e1', 'Alice', 'We decided to move the launch to next week.', 0),
  seg('e2', 'Bob', 'I will prepare the report by Friday.', 4),
  seg('e3', 'Alice', 'There is a risk with the vendor API.', 8),
  seg('e4', 'Bob', 'Can you clarify the budget question?', 12),
  seg('e5', 'Alice', 'Great, thanks everyone, the demo went well.', 16),
];

function assertExcerptsAreVerbatim(notes: ReturnType<LocalNotesExtractor['extract']>, sources: TranscriptSegment[]): void {
  for (const excerpt of notes.excerpts) {
    assert.ok(excerpt.text.length > 0 && excerpt.text.length <= 600);
    assert.ok(
      sources.some((source) => source.text.includes(excerpt.text)),
      `excerpt is not a verbatim substring: ${excerpt.text}`,
    );
    assert.ok(typeof excerpt.note === 'string' && excerpt.note.length > 0);
    assert.ok(excerpt.start >= 0 && excerpt.end >= excerpt.start);
  }
}

test('extracts MeetingNotes from a Russian meeting (structure, verbatim excerpts)', () => {
  const notes = new LocalNotesExtractor().extract(RU_SEGMENTS);

  assert.equal(notes.source, 'local');
  assert.equal(notes.language, 'ru');
  assert.equal(notes.segmentsAnalyzed, RU_SEGMENTS.length);
  assert.ok(notes.createdAt > 0);
  assert.ok(notes.summary.length > 20, 'summary must not be empty');
  assert.ok(notes.summary.length <= 4000);
  assert.ok(notes.excerpts.length >= 5 && notes.excerpts.length <= 10, `excerpts: ${notes.excerpts.length}`);
  assert.equal(new Set(notes.excerpts.map((excerpt) => excerpt.id)).size, notes.excerpts.length);
  assertExcerptsAreVerbatim(notes, RU_SEGMENTS);
});

test('classifies RU cue phrases into decisions / risks / actions / questions', () => {
  const notes = new LocalNotesExtractor().extract(RU_SEGMENTS);
  const kinds = new Set(notes.excerpts.map((excerpt) => excerpt.kind));

  assert.ok(kinds.has('decision'));
  assert.ok(kinds.has('risk'));
  assert.ok(kinds.has('action_item'));
  assert.ok(kinds.has('question'));
  assert.ok(notes.decisions.some((line) => /решили/.test(line)));
  assert.ok(notes.risks.some((line) => /риск/.test(line)));
});

test('extracts RU action items with speaker owner and due dates', () => {
  const notes = new LocalNotesExtractor().extract(RU_SEGMENTS);

  assert.equal(notes.actionItems.length, 3);
  assert.ok(notes.actionItems.some((item) => item.owner === 'Анна' && item.due?.includes('15.03')));
  assert.ok(notes.actionItems.some((item) => item.owner === 'Мария' && item.due === undefined));
  assert.ok(notes.actionItems.every((item) => typeof item.sourceTs === 'number'));
  assert.ok(notes.actionItems.every((item) => item.id.length > 0 && item.text.length > 0));
  assert.ok(notes.actionItems.some((item) => item.excerptId !== undefined));
});

test('builds topics (top-8) and lexicon sentiment', () => {
  const notes = new LocalNotesExtractor().extract(RU_SEGMENTS);
  assert.ok(notes.topics.length > 0 && notes.topics.length <= 8);
  assert.ok(notes.topics.some((topic) => /интеграц/.test(topic)));
  assert.equal(notes.sentiment, 'positive');

  const negative = new LocalNotesExtractor().extract([
    seg('n1', 'Иван', 'У нас большая проблема с бюджетом, сроки срываются.', 0),
  ]);
  assert.equal(negative.sentiment, 'negative');

  const neutral = new LocalNotesExtractor().extract([
    seg('x1', 'Иван', 'Обсудили интеграцию и перенесли созвон на завтра.', 0),
  ]);
  assert.equal(neutral.sentiment, 'neutral');
});

test('extracts English cue phrases, action items and due dates', () => {
  const notes = new LocalNotesExtractor().extract(EN_SEGMENTS);

  assert.equal(notes.language, 'en');
  assert.equal(notes.source, 'local');
  assert.ok(notes.decisions.some((line) => /decided/i.test(line)));
  assert.ok(notes.risks.some((line) => /risk/i.test(line)));
  assert.ok(notes.excerpts.some((excerpt) => excerpt.kind === 'question'));
  assert.ok(notes.excerpts.length >= 5);
  assertExcerptsAreVerbatim(notes, EN_SEGMENTS);

  const action = notes.actionItems.find((item) => item.owner === 'Bob');
  assert.ok(action, 'expected an action item owned by Bob');
  assert.match(action.due ?? '', /friday/i);
  assert.ok(notes.actionItems.length >= 1);
  assert.equal(notes.sentiment, 'positive');
});

test('respects extract options (maxExcerpts, maxActionItems, locale)', () => {
  const extractor = new LocalNotesExtractor();

  assert.equal(extractor.extract(RU_SEGMENTS, { maxExcerpts: 3 }).excerpts.length, 3);
  assert.equal(extractor.extract(RU_SEGMENTS, { maxActionItems: 1 }).actionItems.length, 1);
  assert.equal(extractor.extract(RU_SEGMENTS, { locale: 'en' }).language, 'en');
});

test('handles an empty transcript', () => {
  const notes = new LocalNotesExtractor().extract([]);
  assert.equal(notes.summary, '');
  assert.deepEqual(notes.excerpts, []);
  assert.deepEqual(notes.actionItems, []);
  assert.deepEqual(notes.decisions, []);
  assert.deepEqual(notes.risks, []);
  assert.deepEqual(notes.topics, []);
  assert.equal(notes.sentiment, 'neutral');
  assert.equal(notes.source, 'local');
  assert.equal(notes.segmentsAnalyzed, 0);
  assert.equal(notes.language, 'ru');
});

test('skips empty/interim-only segment texts without throwing', () => {
  const notes = new LocalNotesExtractor().extract([
    seg('a', 'Иван', '   ', 0),
    seg('b', 'Иван', 'Коротко обсудили бюджет.', 4),
  ]);
  assert.equal(notes.segmentsAnalyzed, 1);
  assert.ok(notes.summary.includes('бюджет'));
});
