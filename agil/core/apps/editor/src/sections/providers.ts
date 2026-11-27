/**
 * Providers section (contract §23, docs/extensibility.md): six replaceable
 * capability slots. Everything works builtin by default; a company can point a
 * slot at its own system (external) or disable it. Saved with the regular
 * "Save to tenant" (PATCH config.providers).
 */
import { providerSlotSchema, type ProviderSlot, type TenantConfig } from '@agil/protocol';
import { badge, el, setBadge } from '../dom';
import {
  card,
  readNumber,
  readString,
  renderSchema,
  selectField,
  textField,
  type FieldCtx,
  type Sync,
} from '../fields';
import type { SectionDefinition } from './types';
import { tr } from '../i18n';

const SLOT_ORDER = ['chat', 'files', 'stt', 'notifications', 'recording', 'backgrounds'] as const;
type SlotName = (typeof SLOT_ORDER)[number];

interface SlotDoc {
  title: string;
  builtin: string;
  external: string;
  /** UI capability feature flags gated by this slot (for disabled warnings). */
  features: readonly string[];
}

const SLOT_DOCS: Record<SlotName, SlotDoc> = {
  chat: {
    title: 'Чат',
    builtin: 'Встроенный комнатный чат по сигналингу: история, вложения.',
    external: 'Корпоративный мессенджер (Mattermost, Teams, свой чат).',
    features: ['chat'],
  },
  files: {
    title: 'Файлы',
    builtin: 'Локальное хранилище .data/files + подписанные ссылки.',
    external: 'S3/MinIO, ECM/DMS, корпоративное облако.',
    features: ['fileShare'],
  },
  stt: {
    title: 'Распознавание речи',
    builtin: 'Распознавание в браузере (Web Speech) или на сервере (Whisper-совместимый STT).',
    external: 'Deepgram, Yandex SpeechKit, локальная модель.',
    features: ['captions'],
  },
  notifications: {
    title: 'Уведомления',
    builtin: 'Только встроенные события интерфейса.',
    external: 'Email, Telegram, Teams-webhook, корпоративный бот.',
    features: [],
  },
  recording: {
    title: 'Запись',
    builtin: 'MediaRecorder в браузере + локальное хранилище записей.',
    external: 'Для серверной записи настройте Egress в панели, в карточке «Аудио-видео и обработка медиа».',
    features: ['recording'],
  },
  backgrounds: {
    title: 'Виртуальные фоны',
    builtin: 'Список из session.virtualBackgrounds (градиенты/URL).',
    external: 'Библиотека файлов компании, CDN.',
    features: ['backgroundBlur', 'backgroundReplace'],
  },
};

const SLOT_FIELD_LABELS = {
  mode: 'Как работает',
  providerName: 'Название внешнего сервиса',
  endpoint: 'Адрес сервиса компании',
  apiKeyEnv: 'Переменная окружения с ключом',
  timeoutMs: 'Тайм-аут ожидания, мс',
  fallback: 'Поведение при сбое',
  options: 'Дополнительные параметры (JSON)',
};

const SLOT_FIELD_HINTS = {
  mode: 'Встроенный (builtin) — работает сразу, внешний сервис не нужен. Внешний (external) — замена системой компании по адресу сервиса. Отключённый (disabled) — возможность выключена для организации.',
  providerName: 'Название для интерфейса и аудита: «corp-messenger», «s3», «deepgram».',
  endpoint: 'Укажите полный адрес сервиса. В рабочей среде используйте HTTPS.',
  apiKeyEnv: 'Только имя переменной окружения — секрет хранится в настройках сервера.',
  timeoutMs: 'От 200 до 30 000 мс на один вызов внешнего сервиса.',
  fallback: 'Выберите, что произойдёт, если внешний сервис недоступен.',
  options: 'Параметры конкретного внешнего сервиса в виде JSON-объекта, например {"bucket":"agil"}.',
};

const MODE_LABELS: Record<ProviderSlot['mode'], string> = {
  builtin: 'встроенный',
  external: 'внешний',
  disabled: 'отключён',
};

function readSlotMode(ctx: FieldCtx, slot: SlotName): ProviderSlot['mode'] {
  const mode = ctx.get(`providers.${slot}.mode`);
  return mode === 'external' || mode === 'disabled' ? mode : 'builtin';
}

function invalidProviderEndpoint(value: string): boolean {
  const url = value.trim();
  if (!url) return false;
  if (!/^https?:\/\/\S+$/i.test(url)) return true;
  try {
    return !new URL(url).hostname;
  } catch {
    return true;
  }
}

export function findInvalidProviderEndpoint(providers: TenantConfig['providers']): string | undefined {
  const slot = SLOT_ORDER.find((slot) => providers[slot].mode === 'external' && invalidProviderEndpoint(providers[slot].endpoint));
  return slot === undefined ? undefined : `providers.${slot}.endpoint`;
}

/** Endpoint text field with http(s) validation and inline error. */
function endpointField(ctx: FieldCtx, path: string, parent: HTMLElement): Sync {
  const sync = textField(ctx, parent, path, SLOT_FIELD_LABELS.endpoint ?? 'Адрес сервиса', {
    hint: SLOT_FIELD_HINTS.endpoint,
    placeholder: 'https://example.com/agil/…',
  });
  const input = parent.querySelector<HTMLInputElement>('.field:last-child .input-text');
  if (!input) return sync;
  const error = el('p', 'field-error');
  error.id = `${path}.error`;
  input.setAttribute('aria-describedby', error.id);
  input.after(error);

  const validate = (): void => {
    const invalid = invalidProviderEndpoint(input.value);
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    error.textContent = invalid ? tr('Укажите полный адрес сервиса с http:// или https://.') : '';
  };
  input.addEventListener('input', validate);
  validate();
  return () => {
    sync();
    validate();
  };
}

/** options JSON object editor. */
function optionsField(ctx: FieldCtx, path: string, parent: HTMLElement): Sync {
  const root = el('div', 'field');
  const head = el('div', 'field-head');
  head.append(el('span', 'field-label', tr(SLOT_FIELD_LABELS.options ?? 'Options')));
  root.append(head, el('p', 'field-hint', tr(SLOT_FIELD_HINTS.options ?? '')));
  const area = el('textarea', 'input input-textarea');
  area.dataset.providerOptions = path;
  area.rows = 3;
  area.spellcheck = false;
  area.setAttribute('aria-label', tr('Дополнительные параметры в JSON'));
  const error = el('p', 'field-error');
  error.id = `${path}.error`;
  area.setAttribute('aria-describedby', error.id);
  root.append(area, error);
  parent.append(root);

  const currentJson = (): string => {
    const value = ctx.get(path);
    if (value === undefined) return '{}';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '{}';
    }
  };

  const validate = (): void => {
    const raw = area.value.trim();
    if (!raw) {
      ctx.invalidText.delete(path);
      area.setAttribute('aria-invalid', 'false');
      error.textContent = '';
      ctx.set(path, {});
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(tr('Нужен JSON-объект: проверьте фигурные скобки и кавычки'));
      }
      ctx.invalidText.delete(path);
      area.setAttribute('aria-invalid', 'false');
      error.textContent = '';
      ctx.set(path, parsed);
    } catch (parseError) {
      const message = parseError instanceof Error && !(parseError instanceof SyntaxError) ? parseError.message : tr('Некорректный JSON');
      ctx.invalidText.set(path, { value: area.value, message });
      area.setAttribute('aria-invalid', 'true');
      error.textContent = message;
    }
  };
  area.addEventListener('input', validate);

  const sync: Sync = () => {
    if (document.activeElement === area) return;
    const pending = ctx.invalidText.get(path);
    if (pending) {
      if (area.value !== pending.value) area.value = pending.value;
      area.setAttribute('aria-invalid', 'true');
      error.textContent = pending.message;
      return;
    }
    const json = currentJson();
    if (area.value.trim() !== json.trim()) area.value = json;
    area.setAttribute('aria-invalid', 'false');
    error.textContent = '';
  };
  sync();
  return sync;
}

/** Provider card for one slot. */
function providerCard(ctx: FieldCtx, parent: HTMLElement, slot: SlotName): Sync[] {
  const syncs: Sync[] = [];
  const doc = SLOT_DOCS[slot];
  const cardShell = card(doc.title, {
    hint: tr('{builtin} Внешний вариант: {external}', { builtin: tr(doc.builtin), external: tr(doc.external) }),
  });
  const modeBadge = badge('builtin', 'muted');
  cardShell.head.append(modeBadge);
  const modeNote = el('p', 'field-hint provider-mode-note');
  cardShell.body.append(modeNote);

  const fields = renderSchema(providerSlotSchema, `providers.${slot}`, ctx, {
    labels: SLOT_FIELD_LABELS,
    hints: SLOT_FIELD_HINTS,
    custom: {
      endpoint: endpointField,
      fallback: (fieldCtx, path, parent) => selectField(fieldCtx, parent, path, SLOT_FIELD_LABELS.fallback,
        providerSlotSchema.shape.fallback.options, {
          hint: tr(SLOT_FIELD_HINTS.fallback),
          labels: { builtin: 'Использовать встроенный сервис', fail: 'Показать ошибку' },
        }),
      options: optionsField,
    },
  });
  cardShell.body.append(fields.node);
  parent.append(cardShell.root);
  syncs.push(...fields.syncs);

  syncs.push(() => {
    const mode = readSlotMode(ctx, slot);
    setBadge(modeBadge, tr(MODE_LABELS[mode]), mode === 'builtin' ? 'ok' : mode === 'external' ? 'info' : 'warn');
    if (mode === 'builtin') {
      modeNote.textContent = tr('По умолчанию встроено — внешний сервис не нужен.');
    } else if (mode === 'external') {
      modeNote.textContent = slot === 'recording'
        ? tr('Внешний провайдер хранения записей в этом разделе не поддерживается. Для серверной записи настройте Egress.')
        : tr('Внешний сервис: укажите адрес и имя переменной окружения с ключом HMAC.');
    } else {
      modeNote.textContent = tr('Провайдер отключён для организации.');
    }
  });

  // Endpoint/fallback live warnings in the card.
  syncs.push(() => {
    const mode = readSlotMode(ctx, slot);
    const endpoint = readString(ctx, `providers.${slot}.endpoint`);
    const apiKeyEnv = readString(ctx, `providers.${slot}.apiKeyEnv`);
    const timeout = readNumber(ctx, `providers.${slot}.timeoutMs`, 5000);
    const notes: string[] = [];
    if (mode === 'external') {
      if (!endpoint) notes.push('не указан адрес сервиса');
      else if (!/^https:\/\//i.test(endpoint)) notes.push('адрес сервиса не по https');
      if (!apiKeyEnv.trim()) notes.push('Без имени переменной с ключом сервер не вызовет внешний сервис.');
      if (timeout < 200 || timeout > 30000) notes.push('тайм-аут вне диапазона 200–30 000 мс');
    }
    const existing = cardShell.root.querySelector('.provider-card-warnings');
    const node = existing ?? el('p', 'field-error provider-card-warnings');
    node.textContent = notes.length > 0 ? `⚠ ${notes.map((note) => tr(note)).join('; ')}` : '';
    if (!existing) cardShell.body.append(node);
  });

  return syncs;
}

/** Cross-slot warnings (same semantics as the MCP/API side). */
function summaryCard(ctx: FieldCtx, parent: HTMLElement): Sync {
  const summary = card('Проверка внешних сервисов', {
    hint: 'Проверка черновика. Доступность сервиса и наличие ключа проверяются на сервере.',
  });
  const list = el('div', 'provider-summary');
  summary.body.append(list);
  parent.append(summary.root);

  const sync: Sync = () => {
    const features = ctx.config().features as unknown as Record<string, boolean>;
    const warnings: string[] = [];
    let externalCount = 0;
    let disabledCount = 0;
    for (const slot of SLOT_ORDER) {
      const service = tr(SLOT_DOCS[slot].title);
      const mode = readSlotMode(ctx, slot);
      if (mode === 'external') externalCount += 1;
      if (mode === 'disabled') disabledCount += 1;
      const endpoint = readString(ctx, `providers.${slot}.endpoint`);
      const apiKeyEnv = readString(ctx, `providers.${slot}.apiKeyEnv`);
      const fallback = readString(ctx, `providers.${slot}.fallback`, 'builtin');
      if (mode === 'external') {
        if (slot === 'recording') {
          warnings.push(tr('{service}: для серверной записи настройте Egress.', { service }));
        }
        if (!endpoint) warnings.push(tr('{service}: внешний режим без адреса сервиса — вызвать его нельзя.', { service }));
        else if (!/^https:\/\//i.test(endpoint)) warnings.push(tr('{service}: адрес сервиса не по https.', { service }));
        if (!apiKeyEnv.trim()) warnings.push(tr('{service}: без имени переменной с ключом сервер не вызовет внешний сервис.', { service }));
        if (fallback === 'fail' && slot !== 'recording') warnings.push(tr('{service}: встроенный резерв отключён.', { service }));
      }
      if (mode === 'disabled') {
        const gated = SLOT_DOCS[slot].features.filter((feature) => features[feature]);
        if (gated.length > 0) warnings.push(tr('{service}: провайдер выключен, функции {features} включены.', { service, features: gated.join('/') }));
      }
    }
    list.replaceChildren(
      el('p', 'field-hint', tr('Встроенных: {builtin}, внешних: {external}, отключённых: {disabled}.', {
        builtin: SLOT_ORDER.length - externalCount - disabledCount, external: externalCount, disabled: disabledCount,
      })),
      ...(warnings.length === 0
        ? [el('p', 'a11y-ok', tr('В черновике нет предупреждений.'))]
        : warnings.map((warning) => el('p', 'field-error', `⚠ ${warning}`))),
    );
  };
  sync();
  return sync;
}

export const providersSection: SectionDefinition = {
  id: 'providers',
  title: 'Внешние сервисы',
  icon: 'layers',
  description:
    'Шесть заменяемых возможностей: чат, файлы, речь, уведомления, запись, фоны. По умолчанию работают встроенные решения, внешние подключаются к системе компании.',
  render(ctx, root) {
    const syncs: Sync[] = [];
    syncs.push(summaryCard(ctx, root));

    const note = card('Как это работает', {
      hint: 'Всё работает из коробки (builtin). Любую возможность можно заменить системой компании (external), ничего не отключая. Полное руководство: docs/extensibility.md.',
    });
    note.body.append(
      el(
        'p',
        'field-hint',
        tr('Внешний сервис получает JSON-запрос с подписью {capability, action, requestId, tenantId, roomId, payload} ') +
        tr('(x-agil-signature — подпись HMAC-SHA256) и отвечает {ok, data}.'),
      ),
      el(
        'p',
        'field-hint',
        tr('Чат: providers.chat отвечает за доставку и хранение сообщений, а session.chat.ui (раздел «Расположение элементов») — за то, что рисует виджет.'),
      ),
    );
    root.append(note.root);

    const cards = el('div', 'provider-cards');
    for (const slot of SLOT_ORDER) {
      syncs.push(...providerCard(ctx, cards, slot));
    }
    root.append(cards);

    return syncs;
  },
};
