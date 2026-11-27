import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompliancePolicyRule, TranscriptSegment } from '@agil/protocol';
import { ComplianceEngine, DEFAULT_PII_RULES } from '../src/index.js';

function makeRule(
  input: Partial<CompliancePolicyRule> & Pick<CompliancePolicyRule, 'id' | 'type' | 'pattern'>,
): CompliancePolicyRule {
  return {
    name: input.id,
    severity: 'warn',
    action: 'flag',
    enabled: true,
    ...input,
  };
}

function makeSegment(text: string, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg-1',
    participantId: 'p1',
    participantName: 'Анна',
    text,
    start: 10,
    end: 14,
    isFinal: true,
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

/** ~235 chars of filler, so separate matches get different excerpts and are not deduped. */
const FILLER = ' Это промежуточная реплика без ключевых слов.'.repeat(5);

test('phrase rule matches case-insensitively with crude Russian morphology', () => {
  const engine = new ComplianceEngine({
    rules: [makeRule({ id: 'confidential', name: 'Конфиденциальность', type: 'phrase', pattern: 'конфиденциальная информация' })],
  });

  const findings = engine.analyzeSegment(
    makeSegment(`Это КОНФИДЕНЦИАЛЬНАЯ информация.${FILLER} Клиент просил конфиденциальную информацию.`),
  );

  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.equal(finding.ruleId, 'confidential');
    assert.equal(finding.ruleName, 'Конфиденциальность');
    assert.equal(finding.source, 'local');
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.action, 'flag');
    assert.equal(finding.confidence, 1);
    assert.equal(finding.participantId, 'p1');
    assert.equal(finding.participantName, 'Анна');
    assert.equal(finding.ts, 1_700_000_000_000);
    assert.ok(finding.excerpt.length > 0 && finding.excerpt.length <= 200);
    assert.match(finding.excerpt, /конфиденциальн\S* информац\S*/i);
  }
});

test('phrase rule normalizes ё/е and supports single-word stems', () => {
  const engine = new ComplianceEngine({
    rules: [makeRule({ id: 'accounting', name: 'Учёт', type: 'phrase', pattern: 'учёт' })],
  });
  const findings = engine.analyzeSegment(makeSegment('Передали УЧЕТ клиента в бухгалтерию.'));
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.excerpt, /УЧЕТ/);
});

test('disabled rules and empty patterns are ignored', () => {
  const engine = new ComplianceEngine({
    rules: [
      makeRule({ id: 'off', type: 'phrase', pattern: 'секрет', enabled: false }),
      makeRule({ id: 'empty', type: 'phrase', pattern: '' }),
    ],
  });
  assert.deepEqual(engine.analyzeSegment(makeSegment('Это секрет.')), []);
});

test('regex rule matches (case-insensitive) and caps matches per rule', () => {
  const engine = new ComplianceEngine({
    rules: [makeRule({ id: 'secret', name: 'Секрет', type: 'regex', pattern: 'секрет[а-я]*', severity: 'critical', action: 'warn' })],
  });
  const findings = engine.analyzeSegment(
    makeSegment(`секрет${FILLER} секретный${FILLER} секретность${FILLER}`),
  );
  assert.equal(findings.length, 3);
  assert.ok(findings.every((finding) => finding.ruleId === 'secret'));
  assert.ok(findings.every((finding) => finding.severity === 'critical' && finding.action === 'warn'));
});

test('malformed / too long regex rules never throw', () => {
  const engine = new ComplianceEngine({
    rules: [
      makeRule({ id: 'broken', type: 'regex', pattern: '(unclosed' }),
      makeRule({ id: 'huge', type: 'regex', pattern: 'a'.repeat(501) }),
    ],
  });
  assert.deepEqual(engine.analyzeSegment(makeSegment('Любой текст aaa (unclosed')), []);
});

test('regex excerpts are quoted around the match and clamped to 200 chars', () => {
  const engine = new ComplianceEngine({
    rules: [makeRule({ id: 'keyword', type: 'regex', pattern: 'секрет' })],
  });
  const text = `${'слово '.repeat(120)}секрет${' хвост'.repeat(120)}`;
  const findings = engine.analyzeSegment(makeSegment(text));
  assert.equal(findings.length, 1);
  const excerpt = findings[0]!.excerpt;
  assert.match(excerpt, /секрет/);
  assert.ok(excerpt.length <= 200, `excerpt too long: ${excerpt.length}`);
  assert.ok(excerpt.startsWith('…') || excerpt.length < 200);
});

test('built-in PII: email and phone', () => {
  const engine = new ComplianceEngine({ rules: DEFAULT_PII_RULES });

  const emailFindings = engine.analyzeSegment(makeSegment('Пишите на ivan.petrov@example.com пожалуйста.'));
  assert.equal(emailFindings.length, 1);
  assert.equal(emailFindings[0]!.ruleId, 'pii.email');
  assert.match(emailFindings[0]!.excerpt, /ivan\.petrov@example\.com/);

  const phoneFindings = engine.analyzeSegment(makeSegment('Телефон для связи: +7 (912) 345-67-89.'));
  assert.ok(phoneFindings.some((finding) => finding.ruleId === 'pii.phone'));
  assert.equal(
    phoneFindings.filter((finding) => finding.ruleId === 'pii.phone').length,
    1,
  );
  assert.ok(!phoneFindings.some((finding) => finding.ruleId === 'pii.card'));

  const localPhone = engine.analyzeSegment(makeSegment('Звоните 8-912-345-67-89 после обеда.'));
  assert.ok(localPhone.some((finding) => finding.ruleId === 'pii.phone'));
});

test('built-in PII: card requires a valid Luhn checksum', () => {
  const engine = new ComplianceEngine({ rules: DEFAULT_PII_RULES });

  const valid = engine.analyzeSegment(makeSegment('Оплата картой 4111 1111 1111 1111 прошла.'));
  assert.equal(valid.filter((finding) => finding.ruleId === 'pii.card').length, 1);

  const invalid = engine.analyzeSegment(makeSegment('Номер карты 1234 5678 9012 3456 не подходит.'));
  assert.deepEqual(invalid, []);
});

test('built-in PII: INN and SNILS are reported by pii.inn, not pii.phone', () => {
  const engine = new ComplianceEngine({ rules: DEFAULT_PII_RULES });
  const findings = engine.analyzeSegment(makeSegment(`ИНН 7707083893.${FILLER}СНИЛС 112-233-445 95.`));

  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.ruleId === 'pii.inn'));
  assert.ok(findings.some((finding) => finding.ruleName === 'СНИЛС / ИНН'));
  assert.ok(findings.some((finding) => finding.excerpt.includes('7707083893')));
  assert.ok(findings.some((finding) => finding.excerpt.includes('112-233-445 95')));
  assert.ok(findings.every((finding) => finding.recommendation !== undefined));
});

test('PII rules can be narrowed by rule id or pattern', () => {
  const emailOnly = new ComplianceEngine({
    rules: [makeRule({ id: 'pii.email', name: 'Email', type: 'pii', pattern: 'email' })],
  });
  const findings = emailOnly.analyzeSegment(makeSegment('Почта a@b.ru, телефон +7 (912) 345-67-89.'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.ruleId, 'pii.email');

  const unknownPatternRunsAll = new ComplianceEngine({
    rules: [makeRule({ id: 'custom-pii', name: 'PII', type: 'pii', pattern: 'custom' })],
  });
  const all = unknownPatternRunsAll.analyzeSegment(
    makeSegment(`Почта a@b.ru.${FILLER}Телефон +7 (912) 345-67-89.`),
  );
  assert.equal(all.length, 2);
});

test('deduplicates findings by (ruleId, excerpt) inside a segment', () => {
  const engine = new ComplianceEngine({ rules: [makeRule({ id: 'pii.email', name: 'Email', type: 'pii', pattern: 'email' })] });
  const findings = engine.analyzeSegment(makeSegment('a@b.ru a@b.ru'));
  assert.equal(findings.length, 1);
});

test('analyzeSegments aggregates findings and keeps participant/time metadata', () => {
  const engine = new ComplianceEngine({
    rules: [makeRule({ id: 'secret', name: 'Секрет', type: 'phrase', pattern: 'секрет' })],
  });
  const segments: TranscriptSegment[] = [
    makeSegment('Первый секрет.', { id: 's1', participantId: 'p1', participantName: 'Анна', ts: 111, start: 0, end: 2 }),
    makeSegment('Здесь чисто.', { id: 's2', participantId: 'p2', participantName: 'Борис', ts: 222, start: 2, end: 4 }),
    makeSegment('Ещё секрет.', { id: 's3', participantId: 'p2', participantName: 'Борис', ts: 333, start: 4, end: 6 }),
  ];
  const findings = engine.analyzeSegments(segments);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((finding) => finding.participantName), ['Анна', 'Борис']);
  assert.deepEqual(findings.map((finding) => finding.ts), [111, 333]);
  assert.notEqual(findings[0]!.id, findings[1]!.id);
});
