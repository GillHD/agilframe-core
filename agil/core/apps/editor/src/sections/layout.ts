/**
 * Layout section: grid mode, controls/chat positions, visible indicators, and
 * the §22 embedding knobs: chrome (full/compact/none), minimized call window,
 * persistAcrossPages (resume after navigation), inheritHostStyles, and the
 * external-chat ownership switch (builtin/external/hidden).
 */
import { layoutSchema, sessionSchema } from '@agil/protocol';
import { el } from '../dom';
import { card, renderSchema, toggleField, type FieldCtx, type Sync } from '../fields';
import { localize, tr } from '../i18n';
import type { SectionDefinition } from './types';

const LAYOUT_LABELS: Record<string, string> = {
  mode: 'Режим компоновки',
  selfView: 'Своё видео',
  controlsPosition: 'Расположение кнопок управления',
  controlsStyle: 'Стиль панели управления',
  controlsAnchor: 'Привязка панели управления',
  hiddenControls: 'Скрытые кнопки управления',
  controlOrder: 'Порядок кнопок управления',
  autoHideControls: 'Скрывать панель управления при бездействии',
  autoHideDelaySec: 'Задержка автоскрытия, сек',
  chatPosition: 'Расположение чата',
  chatDefaultOpen: 'Чат открыт по умолчанию',
  showRoomName: 'Показывать имя комнаты',
  showParticipantCount: 'Показывать число участников',
  showQualityIndicator: 'Показывать качество связи',
  showTimer: 'Показывать таймер',
  tileAspectRatio: 'Соотношение сторон плитки',
  gridMaxTiles: 'Максимум плиток в сетке',
  spotlightFollowSpeaker: 'Крупный план следует за говорящим',
  // §22 — embedding / mini mode
  chrome: 'Оформление встраивания (chrome)',
  header: 'Плотность шапки звонка',
  videoFit: 'Заполнение видео',
  immersiveVideo: 'Видео на весь интерфейс (immersive)',
  persistAcrossPages: 'Сохранять звонок при переходе по страницам',
  inheritHostStyles: 'Наследовать стили страницы компании (host)',
};

const LAYOUT_HINTS: Record<string, string> = {
  mode: 'grid — сетка плиток; spotlight — один крупный участник; sidebar — сетка с боковой панелью.',
  selfView: 'corner — угол; pip — отдельное окно (картинка в картинке); hidden — скрыто.',
  controlsStyle: 'bar — полоса внизу; island — плавающая панель; minimal — только главные кнопки.',
  controlsAnchor: 'К какому краю прижимать панель управления.',
  hiddenControls: 'Идентификаторы кнопок, которые не показывать (например mic, camera).',
  controlOrder: 'Идентификаторы кнопок в нужном порядке; остальные добавляются автоматически.',
  autoHideControls: 'Панель управления скрывается, пока участник не двигает мышь и не нажимает клавиши.',
  autoHideDelaySec: 'От 1 до 120 секунд.',
  tileAspectRatio: '16:9, 4:3 или 1:1.',
  gridMaxTiles: 'От 1 до 64 плиток; остальные уходят в «ещё».',
  header:
    'full — бренд, название комнаты, участники, качество и действия; compact — одна компактная строка (название + статус + иконки); hidden — шапка скрыта и не занимает место, статус поверх видео.',
  videoFit:
    'contain — вписывать с полосами; cover — заполнять с обрезкой.',
  immersiveVideo:
    'Медиа заполняет весь контейнер виджета, а шапка и кнопки управления плавают поверх видео. Удобно для сцен с 25–50 участниками и вебинаров.',
  chrome:
    'full — полный интерфейс; compact — компактная панель; none — без шапки и фона: звонок как часть страницы компании (только сетка видео и кнопки управления).',
  persistAcrossPages:
    'Для сайтов из нескольких страниц: параметры звонка (room, token, tenant, name, theme) хранятся в sessionStorage (хранилище вкладки), и на новой странице AgilFrame.resume() восстанавливает звонок.',
  inheritHostStyles: 'Если цвета и шрифты не заданы явно, берутся со страницы компании.',
};

const MINIMIZED_LABELS: Record<string, string> = {
  mode: 'Режим окна',
  position: 'Расположение окна',
  showSelfView: 'Показывать своё видео',
  keepControls: 'Оставлять кнопки управления',
};

const MINIMIZED_HINTS: Record<string, string> = {
  mode: 'bar — тонкая полоса, bubble — круглый пузырь.',
  position: 'Угол экрана для свёрнутого окна.',
  showSelfView: 'Показывать своё видео в свёрнутом окне.',
  keepControls: 'Оставлять кнопки микрофона, камеры и завершения звонка в свёрнутом окне.',
};

const CHAT_LABELS: Record<string, string> = {
  ui: 'Кто владеет чатом',
  externalProviderName: 'Название внешнего чата',
  allowHostInjection: 'Разрешить странице компании отправлять сообщения',
  allowSystemMessages: 'Разрешить системные сообщения',
  historyStorage: 'Хранилище истории',
  historyRetentionSec: 'Срок хранения истории, сек.',
};

const CHAT_HINTS: Record<string, string> = {
  ui: 'builtin — встроенный чат; external — чат компании (виджет только передаёт события); hidden — чат выключен.',
  externalProviderName: 'Название внешнего сервиса для интерфейса и документации: «Corp Messenger», «Mattermost», «CRM».',
  allowHostInjection: 'Страница компании: sendChat(), postMessage или API.',
  allowSystemMessages: 'Бот или CRM может писать kind:"system" (POST /v1/admin/rooms/:roomId/chat).',
  historyStorage: 'off — только живые сообщения, session — память комнаты, local — диск Core, postgres — PostgreSQL. Внешний провайдер Core работает в режиме session.',
  historyRetentionSec: 'Для local и postgres. От минуты до 90 дней. Новый срок применяется к новым сообщениям.',
};

const CHAT_MODE_EXPLANATION: Record<string, string> = localize({
  builtin:
    'Встроенный чат: панель рисует виджет, сообщения идут по сигналингу. Внешние системы могут дублировать сообщения через API.',
  external:
    'Внешний (external) — чат компании; виджет только передаёт события: onEvent("chat") / postMessage {type:"agil:chat"}. Ответы — instance.sendChat(text), postMessage {type:"agil:chat-send"} или POST /v1/rooms/:roomId/chat.',
  hidden:
    'Скрытый (hidden) — чат в виджете полностью выключен: компания использует свой мессенджер рядом со звонком.',
});

// The schema label/hint maps are keyed by field name; translate the values once
// at module init, which covers all 17 field groups in this section.
const LAYOUT_LABELS_EN = localize(LAYOUT_LABELS);
const LAYOUT_HINTS_EN = localize(LAYOUT_HINTS);
const MINIMIZED_LABELS_EN = localize(MINIMIZED_LABELS);
const MINIMIZED_HINTS_EN = localize(MINIMIZED_HINTS);
const CHAT_LABELS_EN = localize(CHAT_LABELS);
const CHAT_HINTS_EN = localize(CHAT_HINTS);

export const layoutSection: SectionDefinition = {
  id: 'layout',
  title: 'Расположение',
  icon: 'grid',
  description:
    'Сетка, кнопки, чат, индикаторы, встраивание и владелец чата.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const layoutCard = card(tr('Компоновка комнаты'), {
      hint: tr('Как выглядит комната внутри контейнера: сетка или крупный план, расположение элементов и видимые индикаторы.'),
    });
    const fields = renderSchema(layoutSchema, 'layout', ctx, {
      labels: LAYOUT_LABELS_EN,
      hints: LAYOUT_HINTS_EN,
      skip: ['chrome', 'minimized', 'persistAcrossPages', 'inheritHostStyles'],
    });
    layoutCard.body.append(fields.node);
    root.append(layoutCard.root);
    syncs.push(...fields.syncs);

    const embedCard = card(tr('Встраивание: оформление, мини-окно, переходы'), {
      hint: tr('Звонок может быть мини-окном поверх приложения компании и сохраняться при переходе по страницам.'),
    });
    const embedFields = renderSchema(
      layoutSchema.pick({ chrome: true, persistAcrossPages: true, inheritHostStyles: true }),
      'layout',
      ctx,
      { labels: LAYOUT_LABELS_EN, hints: LAYOUT_HINTS_EN },
    );
    embedCard.body.append(embedFields.node);
    syncs.push(...embedFields.syncs);

    const minimizedGroup = el('div', 'field-group');
    minimizedGroup.append(el('div', 'group-title', tr('Мини-режим (свернуть звонок)')));
    syncs.push(
      toggleField(ctx, minimizedGroup, 'layout.minimized.enabled', tr('Сворачивать звонок в мини-окно'), {
        hint: tr('Плавающая полоса или круглый пузырь поверх приложения компании: звук и звонок продолжаются, окно разворачивается кликом. В Chrome доступен режим Document PiP.'),
      }),
    );
    const minimizedFields = renderSchema(layoutSchema.shape.minimized, 'layout.minimized', ctx, {
      labels: MINIMIZED_LABELS_EN,
      hints: MINIMIZED_HINTS_EN,
      skip: ['enabled'],
    });
    minimizedGroup.append(minimizedFields.node);
    syncs.push(...minimizedFields.syncs);
    embedCard.body.append(minimizedGroup);
    embedCard.body.append(
      el(
        'p',
        'field-hint',
        tr('Эти же параметры можно передать в коде для встраивания: config.layout = {chrome, minimized, persistAcrossPages, inheritHostStyles}.'),
      ),
    );
    root.append(embedCard.root);

    const chatCard = card(tr('Чат и встраивание'), {
      hint: tr('Чат может быть внешним: виджет не рисует панель, а передаёт сообщения странице компании через события.'),
    });
    const chatStatus = el('p', 'field-hint chat-mode-status');
    const chatFields = renderSchema(sessionSchema.shape.chat, 'session.chat', ctx, {
      labels: CHAT_LABELS_EN,
      hints: CHAT_HINTS_EN,
    });
    chatCard.body.append(chatFields.node, chatStatus);
    root.append(chatCard.root);
    syncs.push(...chatFields.syncs);
    syncs.push(() => {
      const mode = ctx.get('session.chat.ui');
      const key = typeof mode === 'string' ? mode : 'builtin';
      const provider = ctx.get('session.chat.externalProviderName');
      const providerText =
        key === 'external' && typeof provider === 'string' && provider.trim()
          ? ` ${tr('Внешний сервис: «{name}».', { name: provider.trim() })}`
          : '';
      chatStatus.textContent = `${CHAT_MODE_EXPLANATION[key] ?? CHAT_MODE_EXPLANATION.builtin}${providerText}`;
    });

    return syncs;
  },
};
