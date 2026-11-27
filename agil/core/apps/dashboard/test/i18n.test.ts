/**
 * Dashboard localization contract.
 *
 * The dashboard ships Russian by default and English for the high-traffic
 * shell (login, navigation, security/settings headings). These tests pin the
 * dictionary contract so a partially translated screen can never render a
 * missing key, a Cyrillic string in English, or a broken `{placeholder}`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en, ru, t, type MessageKey } from '../src/i18n.js';

const CYRILLIC = /[\u0400-\u04FF]/;

test('every Russian key has an English translation', () => {
  const missing = (Object.keys(ru) as MessageKey[]).filter((key) => !(key in en));
  assert.deepEqual(missing, [], `missing en keys: ${missing.join(', ')}`);
});

test('English copy contains no Cyrillic', () => {
  const offenders = Object.entries(en).filter(([, value]) => CYRILLIC.test(value));
  assert.deepEqual(offenders, [], `Cyrillic in en: ${offenders.map(([key]) => key).join(', ')}`);
});

test('ru/en placeholders match for every key', () => {
  const placeholders = (value: string): string[] =>
    [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
  const mismatches = (Object.keys(ru) as MessageKey[]).filter(
    (key) => placeholders(ru[key]).join(',') !== placeholders(en[key]).join(','),
  );
  assert.deepEqual(mismatches, [], `placeholder mismatch: ${mismatches.join(', ')}`);
});

test('Russian remains the default and the fallback', () => {
  // The module resolves `ru` when neither ?lang nor storage select English.
  assert.equal(t('nav.rooms'), 'Комнаты');
  assert.equal(t('status.onlineDetail', { detail: 'v1' }), 'Сервер доступен: v1');
  assert.equal(t('docs.saveAction', { title: 'R&D $& handbook' }), 'сохранить документ «R&D $& handbook»');
});

test('high-traffic shell keys are present', () => {
  for (const key of [
    'app.skip',
    'nav.label',
    'nav.security',
    'nav.settings',
    'login.title',
    'login.error.keyEmpty',
    'security.title',
    'settings.title',
    'common.notFoundTitle',
  ] as MessageKey[]) {
    assert.ok(ru[key]?.trim(), `missing ru ${key}`);
    assert.ok(en[key]?.trim(), `missing en ${key}`);
  }
});
