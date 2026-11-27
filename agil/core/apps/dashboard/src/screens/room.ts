/**
 * Room detail: live participants (3 s polling), join/embed links, invite/lock/
 * kick/delete, and tabs for chat, transcript, meeting notes (excerpts), compliance
 * findings and recordings.
 */
import type {
  AnalysisResponse,
  ChatPostRequest,
  ComplianceFinding,
  Participant,
  RecordingRecord,
  RoomDetail,
  TenantConfig,
  TranscriptResponse,
  TranscriptSegment,
  FeatureKey,
} from '@agil/protocol';
import type { ScreenFactory } from '../context.js';
import { ApiError } from '../api.js';
import { h, setButtonLoading } from '../dom.js';
import { describeError } from '../errors.js';
import { featureLabel } from '../features.js';
import {
  countryLabel,
  formatBytes,
  formatClock,
  formatDateTime,
  formatShortDate,
  formatTime,
  initials,
  relativeTime,
} from '../format.js';
import { icon } from '../icons.js';
import { demoJoinUrl } from '../links.js';
import { badge, roleBadge, roleLabel, severityBadge } from '../ui/badge.js';
import { card, kvGrid, linkRow } from '../ui/card.js';
import { button, field, formGrid, selectInput, textInput, textareaInput } from '../ui/controls.js';
import { t } from '../i18n.js';
import { tableSearch } from '../ui/table-search.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { copyButton } from '../ui/copy-button.js';
import { emptyState } from '../ui/empty-state.js';
import { guardedSave } from '../ui/guard.js';
import { openModal, type ModalHandle } from '../ui/modal.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { dataTable } from '../ui/table.js';
import { createTabs, type TabsHandle } from '../ui/tabs.js';
import { createPollsView } from '../ui/polls.js';
import { createLobbyView } from '../ui/lobby.js';
import { createEgressCard } from '../ui/egress.js';
import { renderConversationReview } from '../ui/conversation-review.js';
import { errorState, offlinePanel, pageHeader, refreshButton, toastError, alert } from './common.js';
import { confirmRoomLockChange, openInviteDialog, generatePassword } from './dialogs.js';

/** Live participants poll: fast enough for a call, slow enough for the admin API. */
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_INTERVAL_MS = 30_000;

const INTEGRITY_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  verified: { label: 'Проверен', tone: 'success' },
  suspicious: { label: 'Подозрительно', tone: 'danger' },
  unknown: { label: 'Нет данных', tone: 'neutral' },
};

const EXCERPT_KIND_LABELS: Record<string, string> = {
  key_point: 'Ключевой момент',
  decision: 'Решение',
  action_item: 'Задача',
  risk: 'Риск',
  question: 'Вопрос',
};

const ACTION_LABELS: Record<string, string> = {
  flag: 'Пометить',
  warn: 'Предупредить',
  mute: 'Заглушить',
  block: 'Заблокировать',
};

const SENTIMENT_LABELS: Record<string, { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  positive: { label: 'Позитивный', tone: 'success' },
  neutral: { label: 'Нейтральный', tone: 'neutral' },
  negative: { label: 'Негативный', tone: 'danger' },
};

const SEVERITY_OPTIONS = [
  { value: 'all', label: 'Все уровни' },
  { value: 'critical', label: 'Критично (critical)' },
  { value: 'warn', label: 'Предупреждение (warn)' },
  { value: 'info', label: 'Информация (info)' },
] as const;

type ChatUiMode = 'builtin' | 'external' | 'hidden';

const CHAT_UI_LABELS: Record<ChatUiMode, { label: string; tone: 'success' | 'info' | 'neutral' }> = {
  builtin: { label: 'чат: встроенный', tone: 'success' },
  external: { label: 'чат: внешний', tone: 'info' },
  hidden: { label: 'чат: скрыт', tone: 'neutral' },
};

function mediaFlag(on: boolean, iconName: 'mic' | 'video', onLabel: string, offLabel: string): HTMLElement {
  const node = h('span', {
    class: on ? 'is-on' : 'is-off',
    attrs: { title: on ? onLabel : offLabel, 'aria-label': on ? onLabel : offLabel },
  });
  node.appendChild(icon(on ? iconName : `${iconName}-off` as 'mic-off' | 'video-off', 15));
  return node;
}

export const roomScreen: ScreenFactory = (ctx, params) => {
  const roomId = params.id ?? '';
  const root = h('div', { class: 'page' });
  let destroyed = false;
  let detail: RoomDetail | null = null;
  let transcript: TranscriptResponse | null = null;
  let analysis: AnalysisResponse | null = null;
  let recordings: RecordingRecord[] | null = null;
  let roomConfig: TenantConfig | null = null;
  let chatUi: ChatUiMode = 'builtin';
  let chatExternalName = '';
  let allowSystemMessages = true;
  let allowHostInjection = true;
  let tabsHandle: TabsHandle | null = null;
  let pollsView: ReturnType<typeof createPollsView> | null = null;
  let lobbyView: ReturnType<typeof createLobbyView> | null = null;
  let egressView: ReturnType<typeof createEgressCard> | null = null;
  const stopAuxViews = (): void => {
    pollsView?.stop();
    lobbyView?.stop();
  };
  let pollTimer: number | null = null;
  let pollDelay = POLL_INTERVAL_MS;
  let polling = false;
  let lastPollSnapshot = '';
  let rateLimited = false;
  let complianceSeverity = 'all';
  let lockBadge: HTMLElement | null = null;
  let participantsBadge: HTMLElement | null = null;
  let lockButton: HTMLButtonElement | null = null;
  let liveStatus: HTMLElement | null = null;
  let participantsHost: HTMLElement | null = null;

  const backLink = h(
    'a',
    { class: 'link-button', attrs: { href: '#/rooms' } },
    icon('chevron-left', 16),
    h('span', { text: 'Все комнаты' }),
  );

  if (!roomId) {
    root.append(
      pageHeader({ title: 'Комната не выбрана', subtitle: 'Вернитесь к списку комнат.' }),
      emptyState({ title: 'Нет ID комнаты', message: 'Откройте комнату из списка.', iconName: 'rooms', action: backLink }),
    );
    return { el: root };
  }

  const content = h('div', { class: 'stack' });
  root.appendChild(content);

  /** Keeps the status dot when the lock badge is refreshed by polling. */
  const setLockBadge = (locked: boolean): void => {
    if (!lockBadge) return;
    lockBadge.className = `badge badge-${locked ? 'warning' : 'success'}`;
    lockBadge.replaceChildren(
      h('span', { class: 'badge-dot', attrs: { 'aria-hidden': 'true' } }),
      document.createTextNode(locked ? 'Закрыта' : 'Открыта'),
    );
    lockBadge.title = locked ? 'Новые участники не могут войти' : 'Комната принимает участников';
    const action = locked ? 'Открыть' : 'Закрыть';
    if (lockButton && lockButton.textContent !== action) {
      lockButton.replaceChildren(icon(locked ? 'unlock' : 'lock', 16), h('span', { text: action }));
    }
  };

  const setLoading = (): void => {
    content.replaceChildren(loadingPanel('Загружаем комнату…'), skeletonTable(3, 5));
  };

  const stopPolling = (): void => {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const schedulePoll = (delay = pollDelay): void => {
    stopPolling();
    if (destroyed) return;
    pollTimer = window.setTimeout(() => {
      pollTimer = null;
      void poll();
    }, delay);
  };

  /* ------------------------------------------------------------------ */
  /* Tabs rendering                                                      */
  /* ------------------------------------------------------------------ */

  const ensureAnalysis = async (run: boolean): Promise<AnalysisResponse> => {
    if (run || !analysis) {
      analysis = run ? await ctx.api.runAnalysis(roomId) : await ctx.api.analysis(roomId);
    }
    return analysis;
  };

  const runAnalysisButton = (): HTMLButtonElement => {
    const node = button('Запустить анализ', { variant: 'primary', size: 'sm', icon: 'cpu' });
    node.addEventListener('click', () => {
      void (async () => {
        setButtonLoading(node, true);
        try {
          await ensureAnalysis(true);
          ctx.toast('Анализ обновлён', 'success');
          if (tabsHandle) await renderTab(tabsHandle.getActive(), tabsHandle.panel);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'timeout') {
            ctx.toast('Анализ продолжается на сервере — обновите вкладку через минуту.', 'warning');
          } else {
            toastError(ctx, error);
          }
        } finally {
          setButtonLoading(node, false);
        }
      })();
    });
    return node;
  };

  const refreshAnalysisButton = (): HTMLButtonElement =>
    refreshButton(async () => {
      analysis = null;
      if (tabsHandle) await renderTab(tabsHandle.getActive(), tabsHandle.panel);
    }, 'Обновить');

  const renderChat = (panel: HTMLElement): void => {
    const messages = detail?.messages ?? [];
    panel.replaceChildren();
    const chatNotice =
      chatUi === 'external'
        ? alert(
            'info',
            'Чат ведёт внешний интерфейс компании',
            `${
              chatExternalName ? `Внешний сервис: ${chatExternalName}. ` : ''
            }Виджет не рисует свой чат: сообщения уходят на сайт компании, а панель показывает историю для контроля. Отправлять сообщения можно кнопкой «Сообщение от бота» (POST /v1/admin/rooms/:id/chat).`,
          )
        : chatUi === 'hidden'
          ? alert(
              'info',
              'Чат скрыт в настройках',
              "session.chat.ui = 'hidden': участники используют свой мессенджер. История ниже доступна только для контроля и аудита.",
            )
          : null;
    if (messages.length === 0) {
      panel.appendChild(
        card({
          body: h(
            'div',
            { class: 'stack' },
            chatNotice,
            emptyState({
              title: 'Сообщений пока нет',
              message: 'История чата идёт по сигналингу и появится здесь после первых сообщений.',
              iconName: 'chat',
            }),
          ),
        }),
      );
      return;
    }
    const list = h('div', { class: 'chat-list' });
    for (const message of messages.slice(-200)) {
      const isSystem = message.kind === 'system';
      const node = h('div', { class: `chat-message${isSystem ? ' is-system' : ''}` });
      const meta = h(
        'div',
        { class: 'chat-meta' },
        isSystem ? h('span', { class: 'chat-author', text: 'Система' }) : h('span', { class: 'chat-author', text: message.from.name }),
        isSystem ? null : roleBadge(message.from.role),
        h('span', { text: formatTime(message.ts) }),
      );
      node.appendChild(meta);
      node.appendChild(h('div', { class: 'chat-text', text: message.text }));
      if (message.attachment) {
        node.appendChild(
          h(
            'a',
            {
              class: 'link-button mono small',
              attrs: { href: message.attachment.url, target: '_blank', rel: 'noopener noreferrer' },
              text: `${message.attachment.name} (${formatBytes(message.attachment.size)})`,
            },
          ),
        );
      }
      list.appendChild(node);
    }
    panel.appendChild(
      card({
        title: 'Чат комнаты',
        subtitle: `${messages.length} сообщений`,
        body: h('div', { class: 'stack' }, chatNotice, list),
      }),
    );
    const scroller = list;
    window.setTimeout(() => {
      scroller.scrollTop = scroller.scrollHeight;
    }, 0);
  };

  const segmentRow = (segment: TranscriptSegment): HTMLElement => {
    const node = h('div', { class: 'segment' });
    const translation = segment.translation;
    node.append(
      h('div', { class: 'segment-time', text: `${formatClock(segment.start)}–${formatClock(segment.end)}` }),
      h(
        'div',
        { class: 'segment-body' },
        h(
          'div',
          { class: 'segment-head' },
          h('span', { class: 'chat-author', text: segment.participantName || 'Участник' }),
          segment.isFinal ? null : badge('черновик', 'warning'),
          segment.lang ? badge(segment.lang, 'neutral') : null,
          translation ? badge(`перевод: ${translation.lang}`, 'neutral') : null,
        ),
        h('div', { class: 'segment-text', text: segment.text }),
        translation
          ? h(
              'div',
              { class: 'segment-translation' },
              // Machine output must be labelled as such, never presented as human quality.
              h('span', {
                class: 'segment-translation-label',
                text: `Машинный перевод (${translation.lang})`,
              }),
              h('div', { class: 'segment-translation-text', text: translation.text }),
            )
          : null,
      ),
    );
    return node;
  };

  const renderTranscript = async (panel: HTMLElement): Promise<void> => {
    panel.replaceChildren(loadingPanel('Загружаем расшифровку…'));
    const refresh = refreshButton(async () => {
      transcript = await ctx.api.transcript(roomId);
      await renderTranscript(panel);
    }, 'Обновить');
    try {
      if (!transcript) transcript = await ctx.api.transcript(roomId);
      const data = transcript;
      const body = h('div', { class: 'stack' });
      const policy: string[] = [];
      if (data.translation) {
        policy.push(
          data.translation.enabled
            ? `Машинный перевод: ${data.translation.target} · ${data.translation.provider}${
                data.translation.engine ? ` · ${data.translation.engine}` : ''
              } (качество машинное)`
            : 'Машинный перевод для этой организации выключен',
        );
      }
      if (data.retention) {
        const retention =
          data.retention.retentionSec > 0
            ? `сегменты хранятся ${Math.max(1, Math.round(data.retention.retentionSec / 60))} мин`
            : 'сегменты хранятся до закрытия комнаты';
        const consent = data.retention.consentRequired
          ? data.retention.consented
            ? 'согласие получено'
            : 'требуется согласие участника'
          : 'согласие не требуется';
        policy.push(`${retention} · ${consent}`);
      }
      if (policy.length > 0) body.appendChild(h('div', { class: 'notice', text: policy.join(' · ') }));
      if (data.segments.length === 0) {
        body.appendChild(
          emptyState({
            title: 'Расшифровка пуста',
            message: 'Включите запись и субтитры в настройках организации и виджета — сегменты появятся здесь после звонка.',
            iconName: 'file',
          }),
        );
      } else {
        body.appendChild(h('div', { class: 'segment-list' }, ...data.segments.map(segmentRow)));
      }
      panel.replaceChildren(
        card({
          title: 'Расшифровка',
          subtitle: data.segments.length > 0 ? `${data.segments.length} сегментов · обновлён ${formatTime(data.updatedAt)}` : 'обновлён ' + formatTime(data.updatedAt),
          actions: [refresh],
          body,
        }),
      );
    } catch (error) {
      panel.replaceChildren(errorState(error, () => void renderTranscript(panel)));
    }
  };

  const noteBlock = (title: string, content: HTMLElement | HTMLElement[]): HTMLElement => {
    const block = h('div', { class: 'note-block' }, h('h4', { text: title }));
    const children = Array.isArray(content) ? content : [content];
    for (const child of children) block.appendChild(child);
    return block;
  };

  const renderNotes = async (panel: HTMLElement): Promise<void> => {
    panel.replaceChildren(loadingPanel('Загружаем заметки…'));
    try {
      const data = await ensureAnalysis(false);
      const notes = data.notes;
      if (!notes) {
        panel.replaceChildren(
          card({
            body: emptyState({
              title: 'Заметок пока нет',
              message: 'ИИ-агент ещё не анализировал расшифровку. Запустите анализ — локальные правила и выдержки работают даже без внешней модели.',
              iconName: 'cpu',
              action: runAnalysisButton(),
            }),
          }),
        );
        return;
      }
      const blocks: HTMLElement[] = [];
      if (notes.summary) blocks.push(h('div', { class: 'notes-summary', text: notes.summary }));
      const sentiment = notes.sentiment ? SENTIMENT_LABELS[notes.sentiment] : undefined;
      blocks.push(
        h(
          'div',
          { class: 'chips' },
          badge(`Источник: ${notes.source}`, notes.source === 'local' ? 'neutral' : 'primary'),
          sentiment ? badge(`Тональность: ${sentiment.label}`, sentiment.tone) : null,
          badge(`${notes.segmentsAnalyzed} сегментов`, 'neutral'),
          notes.language ? badge(notes.language, 'neutral') : null,
        ),
      );

      if (notes.excerpts.length > 0) {
        const excerpts = notes.excerpts.map((excerpt) =>
          h(
            'div',
            { class: 'excerpt' },
            h(
              'div',
              { class: 'excerpt-meta' },
              badge(EXCERPT_KIND_LABELS[excerpt.kind] ?? excerpt.kind, excerpt.kind === 'risk' ? 'danger' : 'info'),
              h('span', { text: `${formatClock(excerpt.start)} · ${excerpt.participantName ?? 'неизвестный спикер'}` }),
            ),
            h('div', { class: 'excerpt-quote', text: excerpt.text }),
            excerpt.note ? h('p', { class: 'notice', text: excerpt.note }) : null,
          ),
        );
        blocks.push(noteBlock('Выдержки из расшифровки', excerpts));
      }
      if (notes.actionItems.length > 0) {
        const list = h('ul', { class: 'list-plain' });
        for (const item of notes.actionItems) {
          list.appendChild(
            h(
              'li',
              {},
              h('span', { text: item.text }),
              item.owner || item.due
                ? h('span', {
                    class: 'notice',
                    text: [item.owner ? `ответственный: ${item.owner}` : '', item.due ? `срок: ${item.due}` : '']
                      .filter(Boolean)
                      .join(' · '),
                  })
                : null,
            ),
          );
        }
        blocks.push(noteBlock('Задачи', list));
      }
      if (notes.decisions.length > 0) {
        const list = h('ul', { class: 'list-plain' }, ...notes.decisions.map((decision) => h('li', { text: decision })));
        blocks.push(noteBlock('Решения', list));
      }
      if (notes.risks.length > 0) {
        const list = h('ul', { class: 'list-plain' }, ...notes.risks.map((risk) => h('li', { text: risk })));
        blocks.push(noteBlock('Риски', list));
      }
      if (notes.topics.length > 0) {
        blocks.push(noteBlock('Темы', h('div', { class: 'chips' }, ...notes.topics.map((topic) => badge(topic, 'neutral')))));
      }
      panel.replaceChildren(
        card({
          title: 'Заметки встречи',
          subtitle: `${notes.excerpts.length} выдержек · ${notes.actionItems.length} задач`,
          actions: [refreshAnalysisButton(), runAnalysisButton()],
          body: blocks,
        }),
      );
    } catch (error) {
      panel.replaceChildren(errorState(error, () => void renderNotes(panel)));
    }
  };

  const findingRow = (finding: ComplianceFinding): HTMLElement => {
    return h(
      'div',
      { class: 'excerpt' },
      h(
        'div',
        { class: 'excerpt-meta' },
        severityBadge(finding.severity),
        h('span', { class: 'chat-author', text: finding.ruleName }),
        h('span', { text: `действие: ${ACTION_LABELS[finding.action] ?? finding.action}` }),
        h('span', { text: formatDateTime(finding.ts) }),
        finding.confidence !== undefined ? h('span', { text: `уверенность: ${Math.round(finding.confidence * 100)}%` }) : null,
      ),
      h('div', { class: 'excerpt-quote', text: finding.excerpt }),
      h(
        'div',
        { class: 'excerpt-meta' },
        h('span', { text: finding.participantName ?? finding.participantId ?? 'участник не указан' }),
        badge(finding.source, finding.source === 'local' ? 'neutral' : 'primary'),
        finding.recommendation ? h('span', { text: finding.recommendation }) : null,
      ),
    );
  };

  const renderCompliance = async (panel: HTMLElement): Promise<void> => {
    panel.replaceChildren(loadingPanel('Загружаем отчёт о соответствии правилам…'));
    const severitySelect = selectInput([...SEVERITY_OPTIONS], {
      value: complianceSeverity,
      ariaLabel: 'Фильтр по уровню',
      onChange: (value) => {
        complianceSeverity = value;
        void renderCompliance(panel);
      },
    });
    try {
      const data = await ensureAnalysis(false);
      const findings = complianceSeverity === 'all' ? data.findings : data.findings.filter((finding) => finding.severity === complianceSeverity);
      const body: HTMLElement[] = [];
      if (data.report?.summary) body.push(h('div', { class: 'notes-summary', text: data.report.summary }));
      if (findings.length === 0) {
        body.push(
          emptyState({
            title: data.findings.length === 0 ? 'Нарушений не найдено' : 'Нет замечаний с таким уровнем',
            message:
              data.findings.length === 0
                ? 'Локальные правила и ИИ-агент не нашли нарушений. Запустите анализ повторно после новых фрагментов расшифровки.'
                : 'Измените фильтр уровня критичности.',
            iconName: 'shield-check',
            action: runAnalysisButton(),
          }),
        );
      } else {
        body.push(h('div', { class: 'segment-list' }, ...findings.map(findingRow)));
      }
      panel.replaceChildren(
        card({
          title: 'Соответствие правилам',
          subtitle: `${data.findings.length} замечаний · отчёт ${data.report ? formatDateTime(data.report.createdAt) : 'не сформирован'}`,
          actions: [severitySelect, refreshAnalysisButton(), runAnalysisButton()],
          body,
        }),
      );
    } catch (error) {
      panel.replaceChildren(errorState(error, () => void renderCompliance(panel)));
    }
  };

  const renderRecordings = async (panel: HTMLElement): Promise<void> => {
    panel.replaceChildren(loadingPanel('Загружаем записи…'));
    const refresh = refreshButton(async () => {
      recordings = null;
      await renderRecordings(panel);
    }, 'Обновить');
    try {
      if (!recordings) recordings = await ctx.api.recordings(roomId);
      const list = recordings;
      const table = dataTable<RecordingRecord>({
        className: 'table-cards',
        columns: [
          {
            key: 'id',
            header: 'Запись',
            render: (row) => h('div', { class: 'cell-stack' }, h('span', { class: 'cell-sub', text: row.id }), h('span', { class: 'cell-sub', text: row.mime })),
          },
          { key: 'createdAt', header: 'Создана', render: (row) => formatShortDate(row.createdAt) },
          { key: 'duration', header: 'Длительность', render: (row) => formatClock(row.durationSec) },
          { key: 'size', header: 'Размер', align: 'right', render: (row) => formatBytes(row.size) },
          { key: 'author', header: 'Автор', render: (row) => row.createdBy || '—' },
          {
            key: 'actions',
            header: 'Действия',
            align: 'right',
            render: (row) =>
              h(
                'div',
                { class: 'cell-actions' },
                button(undefined, {
                  variant: 'subtle',
                  size: 'sm',
                  icon: 'download',
                  title: 'Скачать запись',
                  onClick: () => window.open(ctx.api.resolveUrl(row.url), '_blank', 'noopener,noreferrer'),
                }),
                button(undefined, {
                  variant: 'danger-ghost',
                  size: 'sm',
                  icon: 'trash',
                  title: 'Удалить запись',
                  onClick: () => {
                    void (async () => {
                      const confirmed = await confirmDialog({
                        title: 'Удалить запись?',
                        message: `Запись ${row.id} будет удалена с сервера. Действие необратимо.`,
                        confirmLabel: 'Удалить',
                        danger: true,
                      });
                      if (!confirmed) return;
                      try {
                        await ctx.api.deleteRecording(row.id);
                        recordings = null;
                        ctx.toast('Запись удалена', 'success');
                        await renderRecordings(panel);
                      } catch (error) {
                        toastError(ctx, error);
                      }
                    })();
                  },
                }),
              ),
          },
        ],
        rows: list,
        empty: emptyState({
          title: 'Записей пока нет',
          message: 'Включите запись в настройках организации (session.recording.enabled) — файлы появятся здесь.',
          iconName: 'recordings',
        }),
      });
      panel.replaceChildren(card({ title: 'Записи комнаты', subtitle: `${list.length} файлов`, actions: [refresh], body: table, flush: true }));
    } catch (error) {
      panel.replaceChildren(errorState(error, () => void renderRecordings(panel)));
    }
  };

  const renderTab = async (id: string, panel: HTMLElement): Promise<void> => {
    stopAuxViews();
    if (id === 'chat') renderChat(panel);
    else if (id === 'transcript') await renderTranscript(panel);
    else if (id === 'notes') await renderNotes(panel);
    else if (id === 'compliance') await renderCompliance(panel);
    else if (id === 'conversation-review') await renderConversationReview(ctx, roomId, panel);
    else if (id === 'recordings') await renderRecordings(panel);
    else if (id === 'polls') {
      pollsView ??= createPollsView(ctx, roomId);
      await pollsView.render(panel);
    } else if (id === 'lobby') {
      lobbyView ??= createLobbyView(ctx, roomId);
      await lobbyView.render(panel);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Live participants + polling                                         */
  /* ------------------------------------------------------------------ */

  const participantSearch = tableSearch(t('table.searchParticipants'), t('table.searchParticipantsHint'), () => renderParticipants());
  const renderParticipants = (): void => {
    if (!detail || !participantsHost) return;
    const participants = detail.participants.filter((participant) => participantSearch.matches(
      participant.name, participant.id, participant.role, participant.roleName,
      roleLabel(participant.role),
    ));
    participantSearch.setCount(participants.length, detail.participants.length);
    const showPermissions = participants.some((participant) => participant.permissions !== undefined);
    const locationCell = (participant: Participant): HTMLElement => {
      const location = participant.location;
      const country = location?.country ?? participant.country;
      const source = location?.source ?? (country ? 'ip' : 'none');
      const sourceLabel = source === 'gps' ? 'GPS' : source === 'ip' ? 'IP' : 'нет';
      const sourceTone = source === 'gps' ? 'success' : source === 'ip' ? 'neutral' : 'warning';
      const wrap = h('div', { class: 'cell-stack' });
      const title =
        country !== undefined
          ? `Страна: ${country}${location?.city ? ` · город: ${location.city}` : ''}${
              location?.accuracyM !== undefined ? ` · точность ≈${Math.round(location.accuracyM)} м` : ''
            }`
          : 'Гео не определено (IP-адрес мог быть скрыт VPN/TURN)';
      wrap.appendChild(
        h('span', {
          class: 'cell-title',
          text: country ? `${countryLabel(country)}${location?.city ? `, ${location.city}` : ''}` : 'Не определена',
          attrs: { title },
        }),
      );
      const meta = h('div', { class: 'chips' });
      meta.appendChild(badge(`источник: ${sourceLabel}`, sourceTone, { title: 'Источник: IP подключения или GPS с согласия участника' }));
      if (location?.vpnSuspected) meta.appendChild(badge('VPN?', 'warning', { title: 'Возможен VPN/прокси' }));
      if (source === 'gps' && location?.accuracyM !== undefined) {
        meta.appendChild(h('span', { class: 'notice', text: `±${Math.round(location.accuracyM)} м` }));
      }
      wrap.appendChild(meta);
      return wrap;
    };
    const columns = [
      {
        key: 'participant',
        header: 'Участник',
        render: (participant: Participant) =>
          h(
            'div',
            { class: 'participant-cell' },
            h('span', { class: 'avatar', text: initials(participant.name) }),
            h(
              'div',
              { class: 'cell-stack' },
              h('span', { class: 'cell-title', text: participant.name }),
              h('span', { class: 'cell-sub', text: participant.id }),
            ),
          ),
      },
      { key: 'role', header: 'Роль', render: (participant: Participant) => roleBadge(participant.role) },
      {
        key: 'location',
        header: 'Локация',
        render: (participant: Participant) => locationCell(participant),
      },
      {
        key: 'verified',
        header: 'Личность',
        render: (participant: Participant) =>
          participant.verified ? badge('Подтверждён', 'success', { dot: true }) : badge('Не подтверждён', 'neutral'),
      },
      {
        key: 'integrity',
        header: 'Подлинность',
        render: (participant: Participant) => {
          const info = INTEGRITY_LABELS[participant.integrity] ?? INTEGRITY_LABELS.unknown;
          return badge(info?.label ?? participant.integrity, info?.tone ?? 'neutral', { dot: true });
        },
      },
      {
        key: 'media',
        header: 'Микрофон / камера',
        render: (participant: Participant) =>
          h(
            'span',
            { class: 'media-flags' },
            mediaFlag(participant.state.mic === 'on', 'mic', 'Микрофон включён', 'Микрофон выключен'),
            mediaFlag(participant.state.cam === 'on', 'video', 'Камера включена', 'Камера выключена'),
            participant.state.screen ? badge('экран', 'info') : null,
            participant.state.handRaised ? badge('рука', 'warning') : null,
          ),
      },
      ...(showPermissions
        ? [
            {
              key: 'permissions',
              header: 'Права',
              render: (participant: Participant) => {
                const permissions = participant.permissions;
                if (permissions === undefined) return h('span', { class: 'muted', text: '—' });
                const title = permissions.map((key) => featureLabel(key as FeatureKey)).join(', ');
                return badge(`${permissions.length} функций`, permissions.length > 0 ? 'info' : 'warning', {
                  title: title || 'Права не выданы',
                });
              },
            },
          ]
        : []),
      {
        key: 'actions',
        header: 'Действия',
        align: 'right' as const,
        render: (participant: Participant) =>
          h(
            'div',
            { class: 'cell-actions' },
            button(undefined, {
              variant: 'danger-ghost',
              size: 'sm',
              icon: 'user-x',
              title: 'Отключить участника',
              onClick: () => {
                void (async () => {
                  const confirmed = await confirmDialog({
                    title: 'Отключить участника?',
                    message: `«${participant.name}» будет отключён от комнаты и сможет вернуться только по новой ссылке.`,
                    confirmLabel: 'Отключить',
                    danger: true,
                  });
                  if (!confirmed) return;
                  try {
                    await ctx.api.kickParticipant(roomId, participant.id);
                    ctx.toast('Участник отключён', 'success');
                    await poll();
                  } catch (error) {
                    toastError(ctx, error);
                  }
                })();
              },
            }),
          ),
      },
    ];
    participantsHost.replaceChildren(
      dataTable<Participant>({
        className: 'table-cards',
        columns,
        rows: participants,
        empty: participantSearch.active ? emptyState({ title: t('table.noMatches'), compact: true }) : emptyState({
          title: 'В комнате никого нет',
          message: 'Отправьте приглашение — участники появятся здесь автоматически.',
          iconName: 'rooms',
          action: button('Пригласить', {
            variant: 'primary',
            size: 'sm',
            icon: 'link',
            onClick: () => openInviteDialog(ctx, { roomId, roomName: detail?.room.name }),
          }),
        }),
      }),
    );
    if (participantsBadge) participantsBadge.textContent = `${detail.participants.length} онлайн`;
  };

  const poll = async (force = false): Promise<void> => {
    if (destroyed || !detail || polling) return;
    if (document.hidden && !force) {
      schedulePoll(10_000);
      return;
    }
    if (force) {
      pollDelay = POLL_INTERVAL_MS;
      rateLimited = false;
    }
    polling = true;
    try {
      const next = await ctx.api.room(roomId);
      if (destroyed) return;
      const snapshot = JSON.stringify({
        participants: next.participants,
        messages: next.messages.map((message) => message.id),
        locked: next.room.locked,
      });
      const changed = snapshot !== lastPollSnapshot;
      detail = next;
      lastPollSnapshot = snapshot;
      rateLimited = false;
      pollDelay = POLL_INTERVAL_MS;
      ctx.setServerStatus('online');
      if (changed) {
        renderParticipants();
        if (tabsHandle?.getActive() === 'chat') renderChat(tabsHandle.panel);
        setLockBadge(next.room.locked);
      }
      if (liveStatus) {
        liveStatus.textContent = `Обновлено ${formatTime(Date.now())}`;
        liveStatus.classList.remove('text-danger');
      }
    } catch (error) {
      if (destroyed) return;
      if (error instanceof ApiError && (error.code === 'rate_limited' || error.status === 429)) {
        rateLimited = true;
        pollDelay = Math.min(Math.max(pollDelay * 2, 10_000), POLL_MAX_INTERVAL_MS);
        if (liveStatus) {
          liveStatus.textContent = `Сервер ограничил частоту · следующее обновление через ${Math.round(pollDelay / 1000)} с`;
          liveStatus.classList.add('text-danger');
        }
      } else if (error instanceof ApiError && error.offline) {
        ctx.setServerStatus('offline');
        pollDelay = Math.min(Math.max(pollDelay * 2, 10_000), POLL_MAX_INTERVAL_MS);
        if (liveStatus) {
          liveStatus.textContent = `Нет связи с сервером · повторим через ${Math.round(pollDelay / 1000)} с`;
          liveStatus.classList.add('text-danger');
        }
      }
    } finally {
      polling = false;
      if (!destroyed) schedulePoll();
    }
  };

  const openBotMessageDialog = (): void => {
    let handle: ModalHandle | null = null;
    const textArea = textareaInput({ rows: 4, placeholder: 'Текст сообщения (до 4000 символов)', ariaLabel: 'Текст сообщения' });
    textArea.maxLength = 4000;
    const kindSelect = selectInput(
      [
        { value: 'text', label: 'Сообщение от имени бота (text)' },
        { value: 'system', label: 'Системное уведомление (system)' },
      ],
      { value: 'text' },
    );
    if (!allowSystemMessages) {
      const systemOption = kindSelect.querySelector<HTMLOptionElement>('option[value="system"]');
      if (systemOption) {
        systemOption.disabled = true;
        systemOption.textContent = 'system — запрещено настройками (allowSystemMessages=false)';
      }
    }
    const fromInput = textInput({ value: 'Бот панели', placeholder: 'Имя отправителя' });
    const alertBox = h('div', { attrs: { 'aria-live': 'polite' } });
    const submit = button('Отправить в комнату', { variant: 'primary', icon: 'chat' });

    const send = (): void => {
      void (async () => {
        const text = textArea.value.trim();
        if (!text) {
          alertBox.replaceChildren(alert('danger', 'Пустое сообщение', 'Введите текст сообщения.'));
          textArea.focus();
          return;
        }
        if (text.length > 4000) {
          alertBox.replaceChildren(alert('danger', 'Слишком длинное сообщение', 'Лимит — 4000 символов.'));
          return;
        }
        if (kindSelect.value === 'system' && !allowSystemMessages) {
          alertBox.replaceChildren(
            alert('danger', 'Системные сообщения запрещены', 'Включите session.chat.allowSystemMessages в настройках организации.'),
          );
          return;
        }
        setButtonLoading(submit, true);
        alertBox.replaceChildren();
        try {
          const request: ChatPostRequest = {
            text,
            kind: kindSelect.value === 'system' ? 'system' : 'text',
            id: crypto.randomUUID(),
          };
          const fromName = fromInput.value.trim();
          if (fromName) request.from = { name: fromName, role: 'moderator' };
          const response = await ctx.api.postRoomChat(roomId, request);
          if (detail) detail.messages = [...detail.messages, response.message];
          ctx.toast('Сообщение отправлено в комнату', 'success');
          handle?.close();
          if (tabsHandle?.getActive() === 'chat') renderChat(tabsHandle.panel);
          await poll();
        } catch (error) {
          const info = describeError(error);
          if (info.offline) ctx.setServerStatus('offline');
          alertBox.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
        } finally {
          setButtonLoading(submit, false);
        }
      })();
    };
    submit.addEventListener('click', send);

    handle = openModal({
      title: 'Сообщение от системы/бота',
      size: 'md',
      body: h(
        'div',
        { class: 'stack' },
        alert(
          'info',
          'Когда это нужно',
          'Внешний чат, CRM или бот: сообщение уйдёт в историю комнаты и будет доставлено участникам через POST /v1/admin/rooms/:roomId/chat — без постоянного соединения панели с сервером.',
        ),
        field('Текст', textArea, { hint: 'До 4000 символов. Вставляется как обычный текст, без HTML.' }),
        formGrid(field('Тип', kindSelect), field('Отправитель', fromInput, { hint: 'Отображается в истории чата.' })),
        allowHostInjection
          ? null
          : h('p', { class: 'notice', text: 'В настройках session.chat.allowHostInjection = false — сервер может отклонить сообщения, отправленные со страницы компании.' }),
        !allowSystemMessages
          ? h('p', { class: 'notice', text: 'Системные сообщения запрещены: session.chat.allowSystemMessages = false.' })
          : null,
        alertBox,
      ),
      footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), submit],
    });
  };

  /* ------------------------------------------------------------------ */
  /* Full page once the room is loaded                                   */
  /* ------------------------------------------------------------------ */

  const openChangePasswordDialog = (): void => {
    let handle: ModalHandle | null = null;
    const passwordInput = textInput({ placeholder: 'Новый пароль', type: 'text' });
    passwordInput.autocomplete = 'new-password';
    const generate = button('Сгенерировать', {
      variant: 'ghost',
      size: 'sm',
      icon: 'key',
      onClick: () => {
        passwordInput.value = generatePassword();
      },
    });
    const alertBox = h('div', { attrs: { 'aria-live': 'polite' } });
    const submit = button(detail?.passwordProtected ? 'Сменить пароль' : 'Установить пароль', { variant: 'primary', icon: 'check' });
    const save = (): void => {
      void (async () => {
        const password = passwordInput.value.trim();
        if (password.length < 4) {
          alertBox.replaceChildren(alert('danger', 'Слишком короткий пароль', 'Минимум 4 символа; лучше сгенерировать кнопкой.'));
          return;
        }
        setButtonLoading(submit, true);
        alertBox.replaceChildren();
        try {
          const result = await guardedSave(
            'room',
            { roomId, passwordChanged: true },
            detail?.passwordProtected ? `сменить пароль комнаты «${detail?.room.name || roomId}»` : `установить пароль комнаты «${detail?.room.name || roomId}»`,
            async () => ctx.api.setRoomPassword(roomId, password),
          );
          if (!result.allowed) return;
          handle?.close();
          ctx.toast('Пароль комнаты обновлён. Сохраните его — старый больше не действует.', 'success');
          await load();
        } catch (error) {
          const info = describeError(error);
          const hint =
            error instanceof ApiError && (error.status === 404 || error.code === 'http_404')
              ? 'Сервер пока не поддерживает смену пароля (нужен POST /v1/admin/rooms/:roomId/password). Пароль можно задать только при создании комнаты.'
              : [info.message, info.hint].filter(Boolean).join(' ');
          alertBox.replaceChildren(alert('danger', 'Не удалось обновить пароль', hint));
        } finally {
          setButtonLoading(submit, false);
        }
      })();
    };
    submit.addEventListener('click', save);
    passwordInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save();
      }
    });
    handle = openModal({
      title: detail?.passwordProtected ? 'Сменить пароль комнаты' : 'Установить пароль комнаты',
      size: 'sm',
      body: h(
        'div',
        { class: 'stack' },
        alert(
          'warning',
          'Старый пароль нельзя показать',
          'Сервер хранит только хэш. После смены старый пароль перестанет работать, новый показывается только сейчас — сохраните его.',
        ),
        field('Новый пароль', h('div', { class: 'key-row' }, passwordInput, generate), {
          hint: 'Минимум 4 символа. Участникам нужно передать новый пароль отдельно.',
        }),
        alertBox,
      ),
      footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), submit],
    });
    passwordInput.focus();
  };

  const renderRoom = (): void => {
    if (!detail) return;
    const room = detail.room;
    const heading = h('div', { class: 'page-heading' });
    heading.append(
      backLink,
      h('h2', { text: room.name || 'Комната' }),
      h('p', { text: `ID: ${room.id} · организация ${room.tenantId}` }),
    );
    const chips = h('div', { class: 'chips' });
    lockBadge = badge(room.locked ? 'Закрыта' : 'Открыта', room.locked ? 'warning' : 'success', { dot: true });
    participantsBadge = h('span', { class: 'badge badge-neutral', text: `${detail.participants.length} онлайн` });
    chips.append(
      lockBadge,
      detail.passwordProtected ? badge('Пароль', 'warning') : badge('Без пароля', 'neutral'),
      participantsBadge,
      badge(CHAT_UI_LABELS[chatUi].label, CHAT_UI_LABELS[chatUi].tone, {
        title:
          chatUi === 'external' && chatExternalName
            ? `session.chat.ui=external · внешний сервис: ${chatExternalName}`
            : `session.chat.ui = ${chatUi}`,
      }),
      badge(room.mode === 'direct' ? '1:1' : 'группа', room.mode === 'direct' ? 'info' : 'neutral', {
        title: `room.mode = ${room.mode ?? 'group'}`,
      }),
    );
    if (room.context?.messenger) {
      chips.appendChild(badge(`messenger: ${room.context.messenger}`, 'neutral', { title: 'context.messenger' }));
    }
    if (room.context?.title) {
      chips.appendChild(badge(room.context.title, 'neutral', { title: 'context.title' }));
    }
    if (room.context?.conversationId) {
      chips.appendChild(badge(room.context.conversationId, 'neutral', { title: 'context.conversationId' }));
    }
    heading.appendChild(chips);

    lockButton = button(room.locked ? 'Открыть' : 'Закрыть', {
      variant: 'ghost',
      icon: room.locked ? 'unlock' : 'lock',
      onClick: () => {
        void (async () => {
          try {
            const nextLocked = !(detail?.room.locked ?? false);
            const confirmed = await confirmRoomLockChange(nextLocked);
            if (!confirmed) return;
            const result = await guardedSave(
              'room',
              { roomId: room.id, locked: nextLocked },
              nextLocked ? `заблокировать новые входы в комнату «${room.name || room.id}»` : `открыть вход в комнату «${room.name || room.id}»`,
              async () => ctx.api.setRoomLocked(room.id, nextLocked),
            );
            if (!result.allowed) return;
            const locked = result.value ?? nextLocked;
            if (detail) detail.room.locked = locked;
            setLockBadge(locked);
            ctx.toast(locked ? 'Комната закрыта' : 'Комната открыта', 'success');
            await poll();
          } catch (error) {
            toastError(ctx, error);
          }
        })();
      },
    });
    const actions = h(
      'div',
      { class: 'actions' },
      refreshButton(() => load()),
      button('Сообщение от бота', {
        variant: 'ghost',
        icon: 'chat',
        onClick: () => openBotMessageDialog(),
      }),
      button('Приглашение', {
        variant: 'primary',
        icon: 'link',
        onClick: () => openInviteDialog(ctx, { roomId: room.id, roomName: room.name }),
      }),
      button(detail?.passwordProtected ? 'Сменить пароль' : 'Установить пароль', {
        variant: 'ghost',
        icon: 'key',
        title: detail?.passwordProtected ? 'Задать новый пароль комнаты (старый не показываем)' : 'Защитить комнату паролем',
        onClick: () => openChangePasswordDialog(),
      }),
      lockButton,
      button('Удалить', {
        variant: 'danger-ghost',
        icon: 'trash',
        onClick: () => {
          void (async () => {
            const confirmed = await confirmDialog({
              title: 'Удалить комнату?',
              message: `Комната «${room.name || room.id}» будет закрыта, участники отключены. Действие необратимо.`,
              confirmLabel: 'Удалить',
              danger: true,
            });
            if (!confirmed) return;
            try {
              const result = await guardedSave(
                'room',
                { roomId: room.id, delete: true },
                `удалить комнату «${room.name || room.id}»`,
                async () => ctx.api.deleteRoom(room.id),
              );
              if (!result.allowed) return;
              ctx.toast('Комната удалена', 'success');
              ctx.navigate('/rooms');
            } catch (error) {
              toastError(ctx, error);
            }
          })();
        },
      }),
    );
    content.replaceChildren(h('div', { class: 'page-header' }, heading, actions));

    const joinRow = h('div', { class: 'link-row' });
    joinRow.append(
      h('span', { class: 'link-value', text: detail.joinUrl, attrs: { title: detail.joinUrl } }),
      copyButton(detail.joinUrl, { title: 'Скопировать ссылку для входа' }),
      h(
        'a',
        {
          class: 'btn btn-subtle btn-sm',
          attrs: {
            href: detail.joinUrl || demoJoinUrl(ctx.credentials.serverUrl, room.id, undefined, ctx.tenantId),
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'Открыть демо',
          },
        },
        icon('external', 16),
      ),
    );
    const embedRow = h('div', { class: 'link-row' });
    embedRow.append(
      h('span', { class: 'link-value', text: detail.embedUrl, attrs: { title: detail.embedUrl } }),
      copyButton(detail.embedUrl, { title: 'Скопировать ссылку для встраивания' }),
      h(
        'a',
        {
          class: 'btn btn-subtle btn-sm',
          attrs: { href: detail.embedUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Открыть страницу для встраивания' },
        },
        icon('external', 16),
      ),
    );
    const connectionCard = card({
      title: 'Подключение',
      subtitle: 'ссылки для входа и встраивания, параметры комнаты',
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Ссылка для входа' }), joinRow),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Ссылка для встраивания' }), embedRow),
        kvGrid([
          { label: 'Создана', value: formatDateTime(detail.createdAt) },
          { label: 'Последняя активность', value: relativeTime(detail.lastActivityAt) },
          { label: 'Пароль', value: detail.passwordProtected ? 'Установлен' : 'Не требуется' },
          { label: 'Участники', value: `${detail.participants.length} онлайн` },
          {
            label: 'Лимит участников',
            value: `${detail.effectiveMaxParticipants ?? detail.room.maxParticipants ?? '—'} эффективный${
              detail.capacity && room.mediaMode !== 'mesh'
                ? ` · профиль ${detail.capacity.profile} (${detail.capacity.profileParticipants})`
                : ''
            }`,
          },
          { label: 'Сообщений', value: String(detail.messages.length) },
          { label: 'Вход', value: detail.room.locked ? 'Закрыт' : 'Открыт' },
          { label: 'Тип комнаты', value: room.mode === 'direct' ? 'Один на один' : 'Групповая' },
          { label: 'Режим связи', value: room.mediaMode === 'mesh' ? (room.mode === 'direct' ? 'P2P (напрямую, без серверного медиа)' : 'прямое соединение (mesh)') : room.mediaMode === 'sfu' ? 'через SFU' : room.mediaMode === 'broadcast' ? 'трансляция' : '—' },
          {
            label: 'Контекст мессенджера',
            value:
              [
                room.context?.messenger,
                room.context?.conversationId ? `беседа ${room.context.conversationId}` : '',
                room.context?.directPeerId ? `собеседник ${room.context.directPeerId}` : '',
                room.context?.title,
              ]
                .filter(Boolean)
                .join(' · ') || '—',
          },
        ]),
      ),
    });

    liveStatus = h('span', { class: 'notice', text: `Обновлено ${formatTime(Date.now())}` });
    participantsHost = h('div');
    renderParticipants();
    const liveCard = card({
      title: 'Участники онлайн',
      subtitle: 'обновление каждые 5 секунд · GPS-координаты не отображаются',
      actions: [
        liveStatus,
        button(undefined, {
          variant: 'subtle',
          size: 'sm',
          icon: 'refresh',
          title: 'Обновить сейчас',
          onClick: () => void poll(),
        }),
      ],
      body: [participantSearch.el, participantsHost],
      flush: true,
    });

    tabsHandle = createTabs({
      items: [
        { id: 'chat', label: 'Чат', count: detail.messages.length },
        { id: 'transcript', label: 'Расшифровка' },
        { id: 'notes', label: 'Заметки' },
        { id: 'compliance', label: 'Соответствие правилам' },
        { id: 'conversation-review', label: 'Проверка разговора' },
        { id: 'polls', label: 'Опросы' },
        { id: 'lobby', label: 'Ожидают входа' },
        { id: 'recordings', label: 'Записи', count: recordings?.length },
      ],
      ariaLabel: 'Данные комнаты',
      active: 'chat',
      onChange: (id, panel) => {
        void renderTab(id, panel);
      },
    });

    // Tabs first: at 1440×900 the tab bar used to sit below the fold (~y 1061)
    // and every tab screenshot repeated the room header. The workspace grid
    // keeps the tab bar and its panel visible, with the connection/participants
    // cards in the right column (they stack below the tabs on narrow screens).
    egressView?.destroy();
    egressView = createEgressCard(ctx, roomId, Boolean(roomConfig?.features?.recording), roomConfig?.scale?.streaming);
    content.append(
      h('div', { class: 'split room-workspace' }, tabsHandle.el, h('div', { class: 'stack room-side' }, connectionCard, liveCard, egressView.el)),
    );

    if (pollTimer === null) {
      pollTimer = window.setInterval(() => {
        void poll();
      }, POLL_INTERVAL_MS);
    }
  };

  const load = async (): Promise<void> => {
    setLoading();
    const [detailResult, configResult] = await Promise.allSettled([
      ctx.api.room(roomId),
      ctx.api.getConfig(ctx.tenantId),
    ]);
    if (destroyed) return;
    if (detailResult.status === 'rejected') {
      const error = detailResult.reason;
      const info = describeError(error);
      if (info.offline) ctx.setServerStatus('offline');
      const fragments: HTMLElement[] = [errorState(error, () => void load())];
      if (info.offline) fragments.push(offlinePanel(() => void load()));
      fragments.push(h('div', { class: 'actions' }, backLink));
      content.replaceChildren(...fragments);
      return;
    }
    detail = detailResult.value;
    if (configResult.status === 'fulfilled') {
      roomConfig = configResult.value;
      const chat = roomConfig.session.chat;
      chatUi = chat.ui;
      chatExternalName = chat.externalProviderName;
      allowSystemMessages = chat.allowSystemMessages;
      allowHostInjection = chat.allowHostInjection;
    }
    ctx.setServerStatus('online');
    ctx.setPageTitle(`Комната · ${detail.room.name || detail.room.id}`, `ID ${detail.room.id}`);
    renderRoom();
  };

  void load();

  return {
    el: root,
    destroy: () => {
      destroyed = true;
      stopPolling();
      stopAuxViews();
      egressView?.destroy();
    },
  };
};
