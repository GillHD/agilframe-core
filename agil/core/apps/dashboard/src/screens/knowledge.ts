/**
 * Knowledge agent (§18): corporate wiki/RAG assistant settings + a live
 * "проверить" block that asks a question through POST /v1/admin/knowledge/ask.
 * We never store wiki content — only proxy questions and render untrusted
 * citations defensively.
 */
import type {
  KnowledgeAgentSettingsResponse,
  KnowledgeAskRequest,
  KnowledgeAskResponse,
  TenantConfig,
} from '@agil/protocol';
import { isKnowledgeCitationWebUrl } from '@agil/protocol';
import type { ScreenFactory } from '../context.js';
import { ApiError } from '../api.js';
import { h, setButtonLoading } from '../dom.js';
import { describeError } from '../errors.js';
import { icon } from '../icons.js';
import { badge } from '../ui/badge.js';
import { card, kvGrid } from '../ui/card.js';
import { button, checkboxField, field, formGrid, selectInput, textareaInput, textInput } from '../ui/controls.js';
import { emptyState } from '../ui/empty-state.js';
import { loadingPanel } from '../ui/skeleton.js';
import { alert, errorState, offlinePanel, pageHeader, refreshButton, toastError } from './common.js';

type KnowledgeConfig = TenantConfig['session']['knowledgeAgent'];
type Role = 'host' | 'moderator' | 'guest';

const ROLE_OPTIONS = [
  { value: 'host', label: 'Организатор (host)' },
  { value: 'moderator', label: 'Модератор (moderator)' },
  { value: 'guest', label: 'Гость (guest)' },
];

export const knowledgeScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  let destroyed = false;
  let settings: KnowledgeAgentSettingsResponse | null = null;
  let draft: KnowledgeConfig | null = null;
  let askRole: Role = 'moderator';
  let askUserId = '';
  let askRoomId = '';
  let answer: KnowledgeAskResponse | null = null;
  let askError: unknown = null;
  let answerHost: HTMLElement | null = null;
  let syncAskAvailability = (): void => {};
  let saveInProgress = false;
  let askInProgress = false;
  let askRevision = 0;
  const saveButton = button('Сохранить', { variant: 'primary', icon: 'check' });
  saveButton.disabled = true;
  const hasDraftChanges = (): boolean => settings !== null && JSON.stringify(draft) !== JSON.stringify(settings.config);
  const updateDraft = (patch: Partial<KnowledgeConfig>): void => {
    if (!draft) return;
    Object.assign(draft, patch);
    invalidateAskResult();
    syncAskAvailability();
  };

  root.appendChild(
    pageHeader({
      eyebrow: `Организация ${ctx.tenantId}`,
      title: 'Ассистент по базе знаний',
      subtitle: 'Ответы по внутренней базе знаний компании с цитатами. Запрос идёт через сервис поиска по документам (RAG) вашей компании. В API этот раздел называется Knowledge-агент.',
      actions: [refreshButton(() => load()), saveButton],
    }),
  );
  root.appendChild(body);

  const renderAnswer = (): void => {
    if (!answerHost) return;
    if (askError !== null) {
      const info = describeError(askError);
      const notConfigured =
        askError instanceof ApiError &&
        (askError.status === 501 || askError.code === 'knowledge_not_configured' || askError.code === 'not_configured');
      answerHost.replaceChildren(
        alert(
          'warning',
          notConfigured ? 'Ассистент по базе знаний не настроен' : info.title,
          notConfigured
            ? 'Укажите адрес сервиса (endpoint) в настройках и имя переменной окружения с ключом (apiKeyEnv) на сервере — панель не хранит сам ключ. Затем повторите проверку.'
            : [info.message, info.hint].filter(Boolean).join(' '),
        ),
      );
      if (info.offline) ctx.setServerStatus('offline');
      return;
    }
    if (!answer) {
      answerHost.replaceChildren(
        emptyState({
          title: 'Проверьте выбранные параметры',
          message: 'Задайте вопрос — панель отправит его в ассистент по базе знаний и покажет ответ с цитатами.',
          iconName: 'book',
          compact: true,
        }),
      );
      return;
    }
    const response = answer;
    const answerCard = h('div', { class: 'stack' });
    const meta = h('div', { class: 'chips' });
    if (response.refused) meta.appendChild(badge('Отказ / нет ответа', 'warning', { dot: true }));
    if (response.provider) meta.appendChild(badge(`Сервис: ${response.provider}`, 'neutral'));
    if (response.model) meta.appendChild(badge(`Модель: ${response.model}`, 'neutral'));
    if (response.confidence !== undefined) meta.appendChild(badge(`Уверенность: ${Math.round(response.confidence * 100)}%`, 'info'));
    answerCard.append(meta, h('div', { class: 'notes-summary', text: response.answer }));
    if (response.citations.length > 0) {
      const list = h('div', { class: 'stack' });
      for (const citation of response.citations) {
        const title = citation.title || citation.url;
        const link = isKnowledgeCitationWebUrl(citation.url)
          ? h('a', { attrs: { href: citation.url, target: '_blank', rel: 'noopener noreferrer', title: citation.url }, text: title })
          : h('span', { text: title });
        list.appendChild(
          h(
            'div',
            { class: 'excerpt' },
            h('div', { class: 'excerpt-meta' }, icon('link', 16), link),
            citation.snippet ? h('div', { class: 'excerpt-quote', text: citation.snippet }) : null,
          ),
        );
      }
      answerCard.appendChild(h('div', { class: 'section-title', text: `Цитаты (${response.citations.length})` }));
      answerCard.appendChild(list);
      answerCard.appendChild(
        h('p', { class: 'notice', text: 'Ссылки приходят из ответа внешнего сервиса — открывайте только те, которым доверяете. Они открываются в новой вкладке.' }),
      );
    }
    answerHost.replaceChildren(answerCard);
  };

  const invalidateAskResult = (): void => {
    askRevision++;
    if (!askInProgress && answer === null && askError === null) return;
    answer = null;
    askError = null;
    renderAnswer();
  };

  const buildAskCard = (): HTMLElement => {
    const questionInput = textareaInput({
      placeholder: 'Как оформить отпуск в этом квартале?',
      rows: 3,
      ariaLabel: 'Вопрос к базе знаний',
      onInput: invalidateAskResult,
    });
    const roleSelect = selectInput(ROLE_OPTIONS, {
      value: askRole,
      onChange: (value) => {
        askRole = value as Role;
        invalidateAskResult();
      },
    });
    const userIdInput = textInput({
      value: askUserId,
      placeholder: 'необязательно: user-123',
      onInput: (value) => {
        askUserId = value.trim();
        invalidateAskResult();
      },
    });
    const roomIdInput = textInput({
      value: askRoomId,
      placeholder: 'необязательно: room-id',
      onInput: (value) => {
        askRoomId = value.trim();
        invalidateAskResult();
      },
    });
    const askButton = button('Проверить', { variant: 'primary', icon: 'play' });
    const askNotice = h('p', { class: 'notice', attrs: { role: 'status' } });
    syncAskAvailability = (): void => {
      const dirty = hasDraftChanges();
      askButton.disabled = askInProgress || saveInProgress || dirty;
      askNotice.textContent = dirty ? 'Сохраните настройки перед проверкой.' : '';
    };
    syncAskAvailability();
    askButton.addEventListener('click', () => {
      void (async () => {
        if (askInProgress || saveInProgress || hasDraftChanges()) return;
        const question = questionInput.value.trim();
        if (!question) {
          ctx.toast('Введите вопрос, чтобы проверить ответ', 'warning');
          questionInput.focus();
          return;
        }
        const revision = askRevision;
        setButtonLoading(askButton, true);
        askInProgress = true;
        saveButton.disabled = true;
        askError = null;
        answer = null;
        answerHost?.replaceChildren(loadingPanel('Корпоративный агент отвечает…'));
        try {
          const request: KnowledgeAskRequest = {
            question,
            role: askRole,
            locale: 'ru',
          };
          if (askUserId) request.userId = askUserId;
          if (askRoomId) request.roomId = askRoomId;
          const response = await ctx.api.askKnowledge(request);
          if (destroyed || revision !== askRevision) return;
          answer = response;
          renderAnswer();
        } catch (error) {
          if (destroyed || revision !== askRevision) return;
          askError = error;
          renderAnswer();
        } finally {
          askInProgress = false;
          saveButton.disabled = false;
          setButtonLoading(askButton, false);
          syncAskAvailability();
        }
      })();
    });

    return card({
      title: 'Проверить',
      subtitle: 'вопрос к базе знаний и ответ с цитатами',
      subtitleTitle: 'POST /v1/admin/knowledge/ask',
      body: h(
        'div',
        { class: 'stack' },
        field('Вопрос', questionInput),
        formGrid(field('Роль спрашивающего', roleSelect), field('ID пользователя (userId)', userIdInput), field('ID комнаты (roomId)', roomIdInput)),
        h('div', { class: 'actions' }, askButton),
        askNotice,
        answerHost ?? h('div'),
      ),
    });
  };

  const renderPage = (): void => {
    if (!settings || !draft) return;
    saveButton.disabled = false;
    const statusHost = h('div', { class: 'chips' });
    const renderStatus = (): void => {
      statusHost.replaceChildren(
        badge(settings?.endpointConfigured ? 'Адрес сервиса задан' : 'Адрес сервиса не задан', settings?.endpointConfigured ? 'success' : 'warning', { dot: true }),
        settings?.config.apiKeyEnv
          ? badge(settings.apiKeyConfigured ? 'Ключ в переменной окружения найден' : 'Ключ не найден', settings.apiKeyConfigured ? 'success' : 'warning', { dot: true })
          : badge('Запросы без API-ключа', 'neutral'),
        badge('Документы не хранятся', 'neutral'),
      );
    };
    renderStatus();

    const rolesHost = h('div', { class: 'checkbox-grid' });
    const renderRoles = (): void => {
      rolesHost.replaceChildren();
      for (const role of ROLE_OPTIONS) {
        rolesHost.appendChild(
          checkboxField({
            label: role.label,
            checked: draft?.allowedRoles.includes(role.value as Role) ?? false,
            onChange: (checked) => {
              if (!draft) return;
              const set = new Set(draft.allowedRoles);
              if (checked) set.add(role.value as Role);
              else set.delete(role.value as Role);
              updateDraft({ allowedRoles: [...set] });
            },
          }),
        );
      }
    };
    renderRoles();

    const save = (): void => {
      void (async () => {
        if (!draft || saveInProgress || askInProgress) return;
        saveInProgress = true;
        setButtonLoading(saveButton, true);
        formCard.inert = true;
        syncAskAvailability();
        try {
          const response = await ctx.api.updateKnowledgeAgent(draft);
          if (destroyed) return;
          settings = response;
          draft = structuredClone(response.config);
          answer = null;
          askError = null;
          renderAnswer();
          renderStatus();
          renderRoles();
          ctx.toast('Настройки ассистента по базе знаний сохранены', 'success');
        } catch (error) {
          if (!destroyed) toastError(ctx, error);
        } finally {
          saveInProgress = false;
          formCard.inert = false;
          setButtonLoading(saveButton, false);
          syncAskAvailability();
        }
      })();
    };
    saveButton.onclick = save;

    const formCard = card({
      title: 'Настройки агента',
      subtitle: 'подключение, роли и лимиты ответа',
      subtitleTitle: 'PUT /v1/admin/knowledge-agent',
      body: h(
        'div',
        { class: 'stack' },
        statusHost,
        alert(
          'info',
          'Граница ответственности',
          'AGIL Calls не хранит wiki (базу знаний) и корпоративные документы. Мы передаём вопрос в ваш сервис поиска, проверяем ответ по схеме и показываем цитаты. Доступ к документам определяет ваш сервис поиска по документам (RAG).',
        ),
        checkboxField({
          label: 'Ассистент по базе знаний включён',
          description: 'Доступен участникам с ролью из списка разрешённых (allowedRoles) и правом knowledgeAgent, если включена проверка права.',
          checked: draft.enabled,
          onChange: (checked) => {
            updateDraft({ enabled: checked });
          },
        }),
        formGrid(
          field(
            'Адрес сервиса (endpoint)',
            textInput({
              value: draft.endpoint,
              placeholder: 'https://wiki.example.com/ask',
              onInput: (value) => {
                updateDraft({ endpoint: value.trim() });
              },
            }),
            { hint: 'Адрес HTTPS сервиса поиска по документам (RAG) вашей компании.' },
          ),
          field(
            'Имя переменной окружения с ключом',
            textInput({
              value: draft.apiKeyEnv,
              onInput: (value) => {
                updateDraft({ apiKeyEnv: value.trim() });
              },
            }),
            { hint: 'Сервер хранит только имя переменной, не ключ.' },
          ),
          field(
            'Ожидание ответа, мс',
            textInput({
              type: 'number',
              value: String(draft.timeoutMs),
              min: 500,
              max: 30000,
              onChange: (value) => {
                updateDraft({ timeoutMs: Math.min(30000, Math.max(500, Number(value) || 10000)) });
              },
            }),
          ),
          field(
            'Макс. длина ответа, символов',
            textInput({
              type: 'number',
              value: String(draft.maxAnswerChars),
              min: 100,
              max: 20000,
              onChange: (value) => {
                updateDraft({ maxAnswerChars: Math.min(20000, Math.max(100, Number(value) || 4000)) });
              },
            }),
          ),
        ),
        h('div', { class: 'section-title', text: 'Разрешённые роли' }),
        rolesHost,
        h(
          'div',
          { class: 'checkbox-grid' },
          checkboxField({
            label: 'Требовать право доступа knowledgeAgent',
            description: 'Дополнительно проверяется политика доступов (#/access).',
            checked: draft.requirePermission,
            onChange: (checked) => {
              updateDraft({ requirePermission: checked });
            },
          }),
          checkboxField({
            label: 'Показывать цитаты',
            description: 'Ответ агента содержит ссылки на источники.',
            checked: draft.citations,
            onChange: (checked) => {
              updateDraft({ citations: checked });
            },
          }),
        ),
        field(
          'Инструкция ассистенту (systemPrompt)',
          textareaInput({
            value: draft.systemPrompt,
            rows: 4,
            placeholder: 'Инструкция ассистенту: стиль, ограничения, что считать конфиденциальным…',
            onInput: (value) => {
              updateDraft({ systemPrompt: value });
            },
          }),
        ),
        field(
          'Сообщение при отказе (denyMessage)',
          textareaInput({
            value: draft.denyMessage,
            rows: 2,
            onInput: (value) => {
              updateDraft({ denyMessage: value });
            },
          }),
          { hint: 'Показывается участнику при отказе в доступе к агенту.' },
        ),
        h('div', { class: 'actions' }, saveButton),
      ),
    });

    answerHost = h('div', { class: 'stack' });
    const left = h('div', { class: 'stack' }, formCard);
    const right = h('div', { class: 'stack' }, buildAskCard(), answerHost);
    body.replaceChildren(h('div', { class: 'split' }, left, right));
    renderAnswer();
  };

  let loadPromise: Promise<void> | null = null;
  const load = async (): Promise<void> => {
    if (saveInProgress || askInProgress) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      body.replaceChildren(loadingPanel('Загружаем настройки ассистента по базе знаний…'));
      try {
        settings = await ctx.api.knowledgeAgentSettings();
        if (destroyed) return;
        ctx.setServerStatus('online');
        draft = structuredClone(settings.config);
        invalidateAskResult();
        renderPage();
      } catch (error) {
        if (destroyed) return;
        const info = describeError(error);
        if (info.offline) ctx.setServerStatus('offline');
        const fragments: HTMLElement[] = [errorState(error, () => void load())];
        if (info.offline) fragments.push(offlinePanel(() => void load()));
        body.replaceChildren(...fragments);
      }
    })().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  };

  void load();
  return { el: root, destroy: () => { destroyed = true; } };
};
