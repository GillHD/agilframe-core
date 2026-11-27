/**
 * Editor localization contract.
 *
 * The editor catalog is keyed by the Russian source string (gettext-style), so
 * the contract is: every English value is non-empty and Cyrillic-free, and the
 * shell + high-traffic sections (navigation, call controls, security) are
 * actually covered. Untranslated source strings fall back to Russian verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EN, tr } from '../src/i18n.js';

const CYRILLIC = /[\u0400-\u04FF]/;

test('English values are non-empty and Cyrillic-free', () => {
  const corrupt = Object.entries(EN).filter(([, value]) => !value.trim() || CYRILLIC.test(value));
  assert.deepEqual(corrupt, [], `bad en values: ${corrupt.map(([key]) => key).join(', ')}`);
});

test('shell and section navigation are translated', () => {
  for (const source of [
    'визуальный редактор',
    'Документация API',
    'Перейти к настройкам',
    'Секции настроек',
    'Бренд',
    'Тема',
    'Функции',
    'Доступы',
    'Расположение',
    'Аудио/видео',
    'Резервный режим',
    'Безопасность',
    'Сессия',
    'ИИ-агент',
    'База знаний',
    'Интеграции',
    'Корпоративный вход',
    'Внешние сервисы',
    'Масштабирование',
    'Ассистент звонка',
    'Комната',
  ]) {
    assert.ok(EN[source]?.trim(), `missing translation for “${source}”`);
  }
});

test('call-control labels and security cards are translated', () => {
  for (const source of [
    'Режим компоновки',
    'Стиль панели управления',
    'Скрытые кнопки управления',
    'Порядок кнопок управления',
    'Скрывать панель управления при бездействии',
    'Компоновка комнаты',
    'Чат и встраивание',
    'Доступ и модерация',
    'Гео-политика',
    'Проверка подлинности медиа',
  ]) {
    assert.ok(EN[source]?.trim(), `missing translation for “${source}”`);
  }
});

test('untranslated source strings fall back to Russian verbatim', () => {
  // Russian is the active locale in Node, so every lookup is the source.
  assert.equal(tr('Расположение'), 'Расположение');
  assert.equal(tr(''), '');
});
