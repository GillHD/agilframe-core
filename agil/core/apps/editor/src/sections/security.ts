/**
 * Security section: join policy, passwords/lockout, geo policy (ISO-3166
 * alpha-2 picker + GPS consent) and media integrity.
 * Role-based access policy lives in the dedicated "Доступы" section.
 */
import { securitySchema } from '@agil/protocol';
import { badge, button, el } from '../dom';
import { isEnglish, tr } from '../i18n';
import {
  card,
  fieldShell,
  readStringArray,
  renderSchema,
  toggleField,
  type FieldCtx,
  type Sync,
} from '../fields';
import type { SectionDefinition } from './types';

interface Country {
  code: string;
  name: string;
}

const COUNTRIES: readonly Country[] = [
  { code: 'RU', name: 'Россия' },
  { code: 'BY', name: 'Беларусь' },
  { code: 'KZ', name: 'Казахстан' },
  { code: 'UA', name: 'Украина' },
  { code: 'UZ', name: 'Узбекистан' },
  { code: 'KG', name: 'Кыргызстан' },
  { code: 'TJ', name: 'Таджикистан' },
  { code: 'AM', name: 'Армения' },
  { code: 'AZ', name: 'Азербайджан' },
  { code: 'GE', name: 'Грузия' },
  { code: 'MD', name: 'Молдова' },
  { code: 'LT', name: 'Литва' },
  { code: 'LV', name: 'Латвия' },
  { code: 'EE', name: 'Эстония' },
  { code: 'PL', name: 'Польша' },
  { code: 'DE', name: 'Германия' },
  { code: 'FR', name: 'Франция' },
  { code: 'GB', name: 'Великобритания' },
  { code: 'IT', name: 'Италия' },
  { code: 'ES', name: 'Испания' },
  { code: 'PT', name: 'Португалия' },
  { code: 'NL', name: 'Нидерланды' },
  { code: 'BE', name: 'Бельгия' },
  { code: 'CH', name: 'Швейцария' },
  { code: 'AT', name: 'Австрия' },
  { code: 'SE', name: 'Швеция' },
  { code: 'NO', name: 'Норвегия' },
  { code: 'FI', name: 'Финляндия' },
  { code: 'DK', name: 'Дания' },
  { code: 'IE', name: 'Ирландия' },
  { code: 'CZ', name: 'Чехия' },
  { code: 'SK', name: 'Словакия' },
  { code: 'HU', name: 'Венгрия' },
  { code: 'RO', name: 'Румыния' },
  { code: 'BG', name: 'Болгария' },
  { code: 'GR', name: 'Греция' },
  { code: 'TR', name: 'Турция' },
  { code: 'RS', name: 'Сербия' },
  { code: 'HR', name: 'Хорватия' },
  { code: 'SI', name: 'Словения' },
  { code: 'CY', name: 'Кипр' },
  { code: 'IL', name: 'Израиль' },
  { code: 'AE', name: 'ОАЭ' },
  { code: 'SA', name: 'Саудовская Аравия' },
  { code: 'IN', name: 'Индия' },
  { code: 'CN', name: 'Китай' },
  { code: 'JP', name: 'Япония' },
  { code: 'KR', name: 'Южная Корея' },
  { code: 'SG', name: 'Сингапур' },
  { code: 'VN', name: 'Вьетнам' },
  { code: 'TH', name: 'Таиланд' },
  { code: 'ID', name: 'Индонезия' },
  { code: 'MY', name: 'Малайзия' },
  { code: 'AU', name: 'Австралия' },
  { code: 'NZ', name: 'Новая Зеландия' },
  { code: 'US', name: 'США' },
  { code: 'CA', name: 'Канада' },
  { code: 'BR', name: 'Бразилия' },
  { code: 'ZA', name: 'ЮАР' },
  { code: 'EG', name: 'Египет' },
];

const SECURITY_LABELS: Record<string, string> = {
  requireToken: 'Требовать токен',
  waitingRoom: 'Зал ожидания',
  lockRoom: 'Блокировка комнаты',
  moderatorJoinFirst: 'Организатор или модератор входит первым',
  e2ee: 'Сквозное шифрование (E2EE)',
  guestCanShareScreen: 'Гость может делиться экраном',
  guestCanChat: 'Гость может писать в чат',
  guestCanUnmute: 'Гость может включать микрофон',
  passwordRequired: 'Требовать пароль комнаты',
  maxFailedJoinAttempts: 'Макс. неудачных входов',
  lockoutSec: 'Блокировка после неудачных попыток, секунд',
  requireVerifiedIdentity: 'Требовать подтверждение личности',
  auditLog: 'Вести журнал аудита',
  enabled: 'Включено',
  livenessChallenge: 'Проверка подлинности при входе (liveness)',
  frameHeuristics: 'Проверка кадров на синтетическое видео',
  flagThreshold: 'Порог срабатывания, 0–1',
  autoMuteOnHighRisk: 'Автоматически выключать микрофон при высоком риске',
};

const SECURITY_HINTS: Record<string, string> = {
  moderatorJoinFirst: 'Если зал ожидания выключен, гость сможет войти после организатора или модератора.',
  passwordRequired: 'Пароль задаётся при создании комнаты; сервер хранит только его хеш (scrypt — алгоритм хеширования паролей).',
  maxFailedJoinAttempts: 'От 1 до 50. Когда попытки закончатся, вход блокируется на время из поля ниже.',
  lockoutSec: '0 — без блокировки; максимум 86 400 секунд (сутки).',
  e2ee: 'Нужна поддержка в браузерах и на медиасервере; ключи не покидают устройства участников.',
  requireVerifiedIdentity: 'Личность подтверждается во внешней системе входа (IdP) до выдачи токена.',
  flagThreshold: 'По умолчанию 0,7. Участник получает отметку «Подозрительно», когда оценка риска достигает порога.',
  frameHeuristics: 'Браузер проверяет тайминги кадров и признаки синтетического источника.',
};

function readCountryCodes(ctx: FieldCtx, path: string): string[] {
  return [...new Set(readStringArray(ctx, path).map((value) => value.toUpperCase()))];
}

function toggleCountry(ctx: FieldCtx, path: string, code: string): void {
  const current = readCountryCodes(ctx, path);
  const next = current.includes(code)
    ? current.filter((value) => value !== code)
    : [...current, code];
  ctx.set(path, next);
}

function countryPicker(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  title: string,
  hint: string,
): Sync {
  const shell = fieldShell(title, { hint });
  const count = badge('0', 'muted');
  shell.head.append(count);

  const known = el('div', 'chips chips-scroll');
  const buttons = new Map<string, HTMLButtonElement>();
  const countryNames = isEnglish() ? new Intl.DisplayNames('en', { type: 'region' }) : null;
  for (const country of COUNTRIES) {
    const name = countryNames?.of(country.code) ?? country.name;
    const chip = el('button', 'chip chip-code', country.code);
    chip.type = 'button';
    chip.title = name;
    chip.setAttribute('aria-label', `${name} (${country.code})`);
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => toggleCountry(ctx, path, country.code));
    buttons.set(country.code, chip);
    known.append(chip);
  }

  const extras = el('div', 'chips');
  const manual = el('div', 'inline-row');
  const input = el('input', 'input input-code');
  const error = el('p', 'field-error');
  error.id = `${path}-code-error`;
  error.setAttribute('aria-live', 'polite');
  input.type = 'text';
  input.maxLength = 2;
  input.placeholder = tr('Код');
  input.autocomplete = 'off';
  input.setAttribute('aria-label', tr('{title}: добавить код страны', { title: tr(title) }));
  input.setAttribute('aria-describedby', error.id);
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
    if (input.value.length === 2) {
      input.removeAttribute('aria-invalid');
      error.textContent = '';
    }
  });

  const commit = (): void => {
    const code = input.value.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = tr('Код страны должен состоять из двух латинских букв (ISO-3166)');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    error.textContent = '';
    input.value = '';
    const current = readCountryCodes(ctx, path);
    if (!current.includes(code)) {
      ctx.set(path, [...current, code]);
    }
  };

  const add = button(tr('Добавить'), 'btn btn-small', 'plus');
  add.addEventListener('click', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  });
  manual.append(input, add);
  shell.body.append(known, manual, error, extras);
  parent.append(shell.root);

  const sync: Sync = () => {
    const selected = new Set(readCountryCodes(ctx, path));
    for (const [code, chip] of buttons) {
      chip.setAttribute('aria-pressed', selected.has(code) ? 'true' : 'false');
    }
    count.textContent = String(selected.size);
    extras.replaceChildren(
      ...[...selected]
        .filter((code) => !buttons.has(code))
        .map((code) => {
          const chip = el('button', 'chip chip-code chip-extra', code);
          chip.type = 'button';
          const label = tr('Удалить {code}', { code });
          chip.title = label;
          chip.setAttribute('aria-label', label);
          chip.addEventListener('click', () => {
            toggleCountry(ctx, path, code);
            input.focus({ preventScroll: true });
          });
          return chip;
        }),
    );
  };
  sync();
  return sync;
}

export const securitySection: SectionDefinition = {
  id: 'security',
  title: 'Безопасность',
  icon: 'shield',
  description: 'Токены, пароли, гео, медиа, сессии и права.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const accessCard = card(tr('Доступ и модерация'), {
      hint: tr('Сервер проверяет правила при входе; редактор только задаёт политику.'),
    });
    const accessFields = renderSchema(securitySchema, 'security', ctx, {
      labels: SECURITY_LABELS,
      hints: SECURITY_HINTS,
      skip: ['requireVerifiedIdentity', 'geo', 'mediaIntegrity', 'sessionBinding', 'accessPolicy'],
    });
    accessCard.body.append(accessFields.node);
    root.append(accessCard.root);
    syncs.push(...accessFields.syncs);

    const geoCard = card(tr('Гео-политика'), {
      hint: tr('Коды стран ISO-3166 из двух заглавных латинских букв. Если список разрешённых пуст — разрешены все; блокировка важнее разрешения.'),
    });
    syncs.push(toggleField(ctx, geoCard.body, 'security.geo.enabled', 'Включить гео-ограничения'));
    syncs.push(toggleField(ctx, geoCard.body, 'security.geo.blockVpn', 'Блокировать VPN/прокси'));
    syncs.push(
      toggleField(ctx, geoCard.body, 'security.geo.gpsEnabled', 'Запрашивать GPS-геолокацию', {
        hint: 'Браузер спросит разрешение у участника.',
      }),
    );
    syncs.push(
      toggleField(ctx, geoCard.body, 'security.geo.requireConsent', 'Требовать согласие на GPS', {
        hint: 'Согласие до сбора координат (GDPR/152-ФЗ).',
      }),
    );
    syncs.push(
      countryPicker(
        ctx,
        geoCard.body,
        'security.geo.allowedCountries',
        'Разрешённые страны',
        'Пусто — разрешены все. Выберите страны или добавьте код вручную.',
      ),
    );
    syncs.push(
      countryPicker(
        ctx,
        geoCard.body,
        'security.geo.blockedCountries',
        'Заблокированные страны',
        'Страны из этого списка не смогут войти (geo_blocked).',
      ),
    );
    root.append(geoCard.root);

    const integrityCard = card(tr('Проверка подлинности медиа'), {
      hint: tr('Браузер проверяет признаки синтетического видео. Результат даёт ориентир для модерации и может ошибаться.'),
    });
    const integrityFields = renderSchema(
      securitySchema.shape.mediaIntegrity,
      'security.mediaIntegrity',
      ctx,
      { labels: SECURITY_LABELS, hints: SECURITY_HINTS, skip: ['externalProvider'] },
    );
    integrityCard.body.append(integrityFields.node);
    root.append(integrityCard.root);
    syncs.push(...integrityFields.syncs);

    return syncs;
  },
};
