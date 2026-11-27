/**
 * In-call assistant section (docs/in-call-agent.md): local/external/hybrid mode,
 * user-scoped tool allowlist (18 tools, each with the feature/role it requires)
 * and spotlight settings. The assistant acts only with the user's permissions.
 */
import { assistantTools, assistantToolRequirements, sessionSchema } from '@agil/protocol';
import { badge, el, setBadge } from '../dom';
import { card, renderSchema, type FieldCtx, type Sync } from '../fields';
import type { SectionDefinition } from './types';
import { tr } from '../i18n';

const ASSISTANT_TOOL_LABELS: Record<(typeof assistantTools)[number], string> = {
  start_recording: 'Начать запись',
  stop_recording: 'Остановить запись',
  toggle_mic: 'Микрофон вкл/выкл',
  toggle_camera: 'Камера вкл/выкл',
  toggle_screen_share: 'Демонстрация экрана',
  raise_hand: 'Поднять руку',
  send_chat: 'Отправить сообщение',
  open_chat: 'Открыть чат',
  open_files: 'Открыть файлы',
  open_participants: 'Открыть участников',
  open_notes: 'Открыть заметки',
  open_settings: 'Открыть настройки',
  set_blur: 'Размытие фона',
  minimize: 'Свернуть в мини-окно',
  restore: 'Развернуть из мини-окна',
  request_fullscreen: 'Полный экран',
  open_new_tab: 'Открыть в новой вкладке',
  copy_invite_link: 'Скопировать приглашение',
};

const FIELD_LABELS: Record<string, string> = {
  enabled: 'Включить ассистента',
  mode: 'Режим',
  endpoint: 'Адрес сервиса внешнего ИИ-агента',
  apiKeyEnv: 'Переменная окружения с ключом',
  timeoutMs: 'Тайм-аут ожидания, мс',
  systemPrompt: 'Системная инструкция (system prompt)',
  model: 'Модель',
  compressContext: 'Сжимать историю разговора',
  spotlight: 'Разрешить подсветку кнопок (spotlight)',
  allowedTools: 'Разрешённые инструменты',
  maxActionsPerReply: 'Макс. действий на ответ',
  audit: 'Записывать аудит assistant.usage',
  denyMessage: 'Текст при отказе по правам',
};

const FIELD_HINTS: Record<string, string> = {
  mode: 'local — офлайн-правила без ИИ; external — внешняя нейросеть компании; hybrid — нейросеть с локальным резервным режимом.',
  endpoint: 'Адрес сервиса (https, HMAC). Нужен для external/hybrid.',
  apiKeyEnv: 'Только имя переменной окружения — ключ не хранится в конфигурации.',
  timeoutMs: 'От 500 до 30 000 мс на один внешний вызов.',
  systemPrompt: 'До 4000 символов: роль и ограничения ответов модели.',
  model: 'Имя модели для внешнего агента (необязательно).',
  compressContext: 'Если внешний агент поддерживает сжатие истории, он сокращает историю сообщений. Системная инструкция и правила безопасности передаются целиком.',
  spotlight: 'Ассистент сможет затемнять интерфейс и подсвечивать нужную кнопку («нажмите сюда»), в том числе в обучающих турах.',
  maxActionsPerReply: '1–10 действий; лишние отбрасываются сервером.',
  audit: 'События assistant.usage в журнале аудита: кто, какой инструмент и когда использовал.',
  denyMessage: 'Показывается пользователю, когда запрошенное действие недоступно по правам.',
};

/** Chips for the 18 assistant tools with the required feature/role badge. */
function allowedToolsField(ctx: FieldCtx, parent: HTMLElement): Sync {
  const root = el('div', 'field');
  const head = el('div', 'field-head');
  head.append(el('span', 'field-label', tr(FIELD_LABELS.allowedTools ?? 'allowedTools')));
  const count = badge('0', 'muted');
  head.append(count);
  root.append(head);
  root.append(
    el(
      'p',
      'field-hint',
      tr('Права проверяют браузер и сервер. Пустой список запрещает выполнение действий в звонке.'),
    ),
  );
  const chips = el('div', 'chips chips-scroll');
  const buttons = new Map<(typeof assistantTools)[number], HTMLButtonElement>();

  for (const tool of assistantTools) {
    const required = assistantToolRequirements(tool);
    const requirement = [
      required.feature ? tr('функция {feature}', { feature: required.feature }) : '',
      required.roles ? tr('роль {roles}', { roles: required.roles.join('/') }) : '',
    ]
      .filter(Boolean)
      .join(' + ');
    const chip = el('button', 'chip', tr(ASSISTANT_TOOL_LABELS[tool]));
    chip.type = 'button';
    chip.title = requirement ? tr('Требует: {requirement}', { requirement }) : tr('Без отдельной функции и роли');
    chip.setAttribute('aria-pressed', 'false');
    if (required.feature) chip.classList.add('chip-needs-feature');
    if (required.roles) chip.classList.add('chip-needs-role');
    chip.addEventListener('click', () => {
      const current = readTools(ctx);
      const next = current.includes(tool) ? current.filter((value) => value !== tool) : [...current, tool];
      ctx.set('session.inCallAgent.allowedTools', assistantTools.filter((candidate) => next.includes(candidate)));
    });
    buttons.set(tool, chip);
    chips.append(chip);
  }
  root.append(chips);
  const requiredNote = el(
    'p',
    'field-hint',
    tr('Метки: функция — её нужно включить в разделе «Функции» и разрешить политикой; роль — организатор или модератор (host/moderator).'),
  );
  root.append(requiredNote);
  parent.append(root);

  const sync: Sync = () => {
    const selected = new Set(readTools(ctx));
    for (const [tool, chip] of buttons) {
      chip.setAttribute('aria-pressed', selected.has(tool) ? 'true' : 'false');
    }
    setBadge(count, `${selected.size}/${assistantTools.length}`, selected.size === 0 ? 'warn' : 'muted');
  };
  sync();
  return sync;
}

function readTools(ctx: FieldCtx): Array<(typeof assistantTools)[number]> {
  const value = ctx.get('session.inCallAgent.allowedTools');
  const known = new Set<string>(assistantTools);
  return Array.isArray(value)
    ? value.filter((entry): entry is (typeof assistantTools)[number] => typeof entry === 'string' && known.has(entry))
    : [];
}

export const inCallAssistantSection: SectionDefinition = {
  id: 'assistant',
  title: 'Ассистент звонка',
  icon: 'sparkles',
  description:
    'Ассистент во время звонка: офлайн-правила или внешняя нейросеть компании, подсказки с подсветкой кнопок и инструменты строго с правами пользователя.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const modesCard = card('Ассистент во время звонка', {
      hint: 'local работает без интернета: заранее заданные правила для русского и английского, без передачи данных и расходов. external и hybrid подключают нейросеть компании по адресу с подписью HMAC. Ассистент действует только с правами пользователя.',
    });
    const fields = renderSchema(sessionSchema.shape.inCallAgent, 'session.inCallAgent', ctx, {
      labels: FIELD_LABELS,
      hints: FIELD_HINTS,
      skip: ['allowedTools'],
      multiline: ['systemPrompt'],
    });
    modesCard.body.append(fields.node);
    root.append(modesCard.root);
    syncs.push(...fields.syncs);

    const toolsCard = card('Инструменты ассистента (18)', {
      hint: 'Каждый инструмент ограничен функцией и ролью. Сервер повторно проверяет права, отбрасывает лишнее и пишет аудит.',
    });
    syncs.push(allowedToolsField(ctx, toolsCard.body));
    toolsCard.body.append(
      el(
        'p',
        'field-hint',
        tr('Подсказки «куда нажать» используют логические цели: mic, camera, screen, chat, files, participants, notes, settings, blur, recording, minimize, fullscreen, newtab, invite. ') +
          tr('Описание и туры — в docs/in-call-agent.md; в MCP (протокол подключения ИИ-инструментов) — agil_explain_spotlight и agil_get_assistant_tools.'),
      ),
    );
    root.append(toolsCard.root);

    const trustCard = card('Безопасность и режимы', {
      hint: 'Внешний сервис получает вопрос, системную инструкцию и сведения о комнате, участнике, правах и состоянии звонка.',
    });
    trustCard.body.append(
      el('p', 'field-hint', tr('local — офлайн и без расходов; external — любая нейросеть через прокси (docs/llm-integrations.md); hybrid — нейросеть с локальным резервным режимом.')),
      el('p', 'field-hint', tr('Подсветка управляет визуальными подсказками. Когда список инструментов пуст, ассистент отвечает без выполнения действий. Выключатель ассистента скрывает его панель.')),
    );
    root.append(trustCard.root);

    return syncs;
  },
};
