/**
 * Room polls / Q&A panel: list, filter, create, close, results, export.
 * Backend endpoints are public room routes; polling uses backoff until a
 * room-scoped `poll.updated` WS channel is available in the dashboard.
 */
import type { AppContext } from '../context.js';
import { ApiError } from '../api.js';
import { h } from '../dom.js';
import { describeError } from '../errors.js';
import { formatDateTime } from '../format.js';
import { badge } from './badge.js';
import { copyText } from './copy-button.js';
import { confirmDialog } from './confirm-dialog.js';
import { button, field, selectInput, textareaInput, textInput } from './controls.js';
import { alert } from '../screens/common.js';
import { openModal } from './modal.js';
import type { RoomPoll } from '@agil/protocol';

const POLL_MS = 10_000;
const MAX_POLL_MS = 60_000;

export interface PollsView {
  render: (panel: HTMLElement) => Promise<void>;
  stop: () => void;
}

export function createPollsView(ctx: AppContext, roomId: string): PollsView {
  let polls: RoomPoll[] = [];
  let loaded = false;
  let loading = false;
  let fallback = false;
  let error: unknown = null;
  let filter: 'all' | 'open' | 'closed' = 'all';
  let timer: number | null = null;
  let delay = POLL_MS;
  let panelRef: HTMLElement | null = null;
  let destroyed = false;

  const stop = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    if (destroyed || fallback) return;
    stop();
    timer = window.setTimeout(() => void load(), delay);
  };
  const isUnavailable = (err: unknown): boolean =>
    err instanceof ApiError && [404, 405, 501].includes(err.status);

  const load = async (): Promise<void> => {
    if (!panelRef || destroyed) return;
    try {
      const response = await ctx.api.polls(roomId);
      polls = response.polls;
      error = null;
      fallback = false;
      delay = POLL_MS;
      loaded = true;
    } catch (err) {
      if (isUnavailable(err) && !loaded) {
        fallback = true;
        error = err;
      } else {
        error = err;
        delay = Math.min(delay * 2, MAX_POLL_MS);
      }
    } finally {
      renderList(panelRef);
      if (!fallback && !destroyed) schedule();
    }
  };

  const statusBadge = (poll: RoomPoll): HTMLElement =>
    badge(poll.status === 'open' ? 'открыт' : 'закрыт', poll.status === 'open' ? 'success' : 'neutral', { dot: true });

  const rowTitle = (poll: RoomPoll): HTMLElement => h('strong', { class: 'poll-question', text: poll.question });

  const pollCard = (poll: RoomPoll): HTMLElement => {
    const card = h('article', { class: 'poll-card' });
    const head = h('div', { class: 'poll-head' }, rowTitle(poll), statusBadge(poll), h('span', { class: 'spacer' }), badge(poll.kind === 'qna' ? 'Q&A' : 'опрос', 'info'));
    card.appendChild(head);
    const options = h('div', { class: 'poll-options' });
    for (const option of poll.options) {
      const share = Math.round((option.share ?? 0) * 100);
      const row = h(
        'div',
        { class: 'poll-option' },
        h('div', { class: 'poll-option-head' }, h('span', { class: 'poll-option-text', text: option.text }), h('span', { class: 'poll-option-num', text: `${option.votes} · ${share}%` })),
        h('div', { class: 'poll-bar', attrs: { role: 'progressbar', 'aria-valuenow': String(share), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': option.text } }, h('span', { class: 'poll-bar-fill', attrs: { style: `width:${share}%` } })),
      );
      options.appendChild(row);
    }
    card.appendChild(options);
    const meta = h(
      'div',
      { class: 'poll-meta' },
      h('span', { text: `Всего голосов: ${poll.totalVotes}` }),
      h('span', { text: `Создал: ${poll.createdBy?.name || '—'}` }),
      h('span', { text: formatDateTime(poll.createdAt) }),
      poll.multiple ? badge('несколько', 'neutral') : null,
    );
    card.appendChild(meta);
    const actions = h('div', { class: 'poll-actions' });
    actions.appendChild(button('Копировать результаты', { variant: 'subtle', size: 'sm', icon: 'copy', onClick: () => void exportPoll(poll, 'markdown') }));
    actions.appendChild(button('JSON', { variant: 'ghost', size: 'sm', onClick: () => void exportPoll(poll, 'json') }));
    if (poll.status === 'open') {
      actions.appendChild(button('Закрыть опрос', { variant: 'danger-ghost', size: 'sm', onClick: () => void closePoll(poll) }));
    }
    card.appendChild(actions);
    return card;
  };

  const asMarkdown = (poll: RoomPoll): string => {
    const lines = [`# ${poll.question}`, '', `Статус: ${poll.status}, всего голосов: ${poll.totalVotes}`, ''];
    for (const option of poll.options) lines.push(`- ${option.text}: ${option.votes} (${Math.round((option.share ?? 0) * 100)}%)`);
    lines.push('', `Создатель: ${poll.createdBy?.name ?? '—'}`, `Время: ${formatDateTime(poll.createdAt)}`);
    return lines.join('\n');
  };

  const exportPoll = async (poll: RoomPoll, format: 'markdown' | 'json'): Promise<void> => {
    const text = format === 'json' ? JSON.stringify(poll, null, 2) : asMarkdown(poll);
    const ok = await copyText(text);
    ctx.toast(ok ? `Результаты скопированы (${format === 'json' ? 'JSON' : 'Markdown'})` : 'Не удалось скопировать результаты', ok ? 'success' : 'error');
  };

  const closePoll = async (poll: RoomPoll): Promise<void> => {
    const confirmed = await confirmDialog({
      title: 'Закрыть опрос?',
      message: `«${poll.question}» перестанет принимать голоса. Результаты останутся доступны.`,
      confirmLabel: 'Закрыть опрос',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await ctx.api.closePoll(roomId, poll.id);
      ctx.toast('Опрос закрыт', 'success');
      loaded = false;
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        ctx.toast('Опрос уже закрыт другим модератором — обновляю список.', 'warning');
        loaded = false;
        await load();
        return;
      }
      const info = describeError(err);
      ctx.toast([info.message, info.hint].filter(Boolean).join(' '), 'error');
    }
  };

  const openCreate = (): void => {
    let handle: { close: () => void } | null = null;
    const question = textInput({ placeholder: 'Вопрос для участников' });
    const optionsArea = textareaInput({ rows: 5, placeholder: 'Вариант 1\nВариант 2\n…' });
    const kind = selectInput([
      { value: 'poll', label: 'Опрос' },
      { value: 'qna', label: 'Q&A / вопросы' },
    ], { value: 'poll' });
    const multiple = h('input', { attrs: { type: 'checkbox' } });
    const anonymous = h('input', { attrs: { type: 'checkbox' } });
    anonymous.checked = true;
    const status = h('div', { attrs: { 'aria-live': 'polite' } });
    const submit = button('Создать опрос', { variant: 'primary', icon: 'plus' });
    submit.addEventListener('click', () => {
      void (async () => {
        const title = question.value.trim();
        const options = optionsArea.value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 10);
        if (title.length < 3) {
          status.replaceChildren(alert('danger', 'Нужен вопрос', 'Введите вопрос длиной не меньше 3 символов.'));
          return;
        }
        if (options.length < 2) {
          status.replaceChildren(alert('danger', 'Нужно 2–10 вариантов', 'Каждый вариант — отдельная строка.'));
          return;
        }
        submit.disabled = true;
        status.replaceChildren();
        try {
          await ctx.api.createPoll(roomId, {
            question: title,
            options: options.map((text) => ({ text })),
            multiple: multiple.checked,
            anonymous: anonymous.checked,
            kind: kind.value as 'poll' | 'qna',
          });
          handle?.close();
          ctx.toast('Опрос создан', 'success');
          loaded = false;
          await load();
        } catch (err) {
          const info = describeError(err);
          status.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
        } finally {
          submit.disabled = false;
        }
      })();
    });
    handle = openModal({
      title: 'Создать опрос',
      size: 'md',
      body: h(
        'div',
        { class: 'stack' },
        alert('info', 'Опрос в комнате', 'Участники голосуют в интерфейсе звонка; панель показывает результаты и может закрыть опрос.'),
        field('Вопрос', question),
        field('Варианты (по одному в строке, 2–10)', optionsArea),
        field('Тип', kind),
        h('label', { class: 'checkbox-row' }, multiple, h('span', { class: 'checkbox-text' }, h('span', { class: 'checkbox-title', text: 'Несколько вариантов' }))),
        h('label', { class: 'checkbox-row' }, anonymous, h('span', { class: 'checkbox-text' }, h('span', { class: 'checkbox-title', text: 'Анонимные голоса' }))),
        status,
      ),
      footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), submit],
    });
  };

  const renderList = (panel: HTMLElement): void => {
    panel.replaceChildren();
    if (fallback) {
      panel.appendChild(
        alert('warning', 'Опросы появятся после обновления сервера', 'Endpoint /v1/rooms/:roomId/polls пока недоступен. Список, создание и результаты включатся без изменений панели.'),
      );
      return;
    }
    if (loading && !loaded) {
      panel.appendChild(h('p', { class: 'notice', text: 'Загружаем опросы…' }));
      return;
    }
    if (error && !loaded) {
      panel.appendChild(alert('danger', 'Не удалось загрузить опросы', describeError(error).message));
      return;
    }
    const toolbar = h('div', { class: 'poll-toolbar' });
    const filters: Array<{ value: typeof filter; label: string }> = [
      { value: 'all', label: 'Все' },
      { value: 'open', label: 'Активные' },
      { value: 'closed', label: 'Закрытые' },
    ];
    for (const item of filters) {
      toolbar.appendChild(button(item.label, {
        variant: filter === item.value ? 'subtle' : 'ghost',
        size: 'sm',
        onClick: () => {
          filter = item.value;
          renderList(panel);
        },
      }));
    }
    toolbar.appendChild(h('span', { class: 'spacer' }));
    toolbar.appendChild(button('Обновить', { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void load() }));
    toolbar.appendChild(button('Создать опрос', { variant: 'primary', size: 'sm', icon: 'plus', onClick: openCreate }));
    panel.appendChild(toolbar);
    if (error && loaded) panel.appendChild(alert('warning', 'Не удалось обновить', describeError(error).message));
    const visible = polls.filter((poll) => filter === 'all' || poll.status === filter);
    if (visible.length === 0) {
      panel.appendChild(alert('info', 'Опросов нет', filter === 'all' ? 'Создайте первый опрос для комнаты.' : 'В этом фильтре пока пусто.'));
      return;
    }
    const list = h('div', { class: 'poll-list' });
    for (const poll of visible) list.appendChild(pollCard(poll));
    panel.appendChild(list);
    panel.appendChild(h('p', { class: 'notice', text: 'Обновление каждые 10 секунд с backoff при ошибках; голоса приходят через REST/WS комнаты.' }));
  };

  return {
    render: async (panel: HTMLElement) => {
      panelRef = panel;
      if (!loaded && !loading) {
        loading = true;
        renderList(panel);
        loading = false;
        await load();
      } else {
        renderList(panel);
      }
      schedule();
    },
    stop,
  };
}
