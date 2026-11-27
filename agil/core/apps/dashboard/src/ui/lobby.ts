/**
 * Waiting-room (lobby) panel: pending requests, admit/reject/reject-all.
 * Backend lobby endpoints are ready; polling uses backoff and leaves a clear
 * fallback for older servers.
 */
import type { LobbyRequestInfo } from '@agil/protocol';
import type { AppContext } from '../context.js';
import { ApiError } from '../api.js';
import { h } from '../dom.js';
import { describeError } from '../errors.js';
import { countryLabel, formatDateTime, formatTime } from '../format.js';
import { badge } from './badge.js';
import { confirmDialog } from './confirm-dialog.js';
import { button } from './controls.js';
import { alert } from '../screens/common.js';

const LOBBY_POLL_MS = 5_000;
const MAX_POLL_MS = 60_000;

export interface LobbyView {
  render: (panel: HTMLElement) => Promise<void>;
  stop: () => void;
}

export function createLobbyView(ctx: AppContext, roomId: string): LobbyView {
  let requests: LobbyRequestInfo[] = [];
  let loaded = false;
  let fallback = false;
  let error: unknown = null;
  let panelRef: HTMLElement | null = null;
  let timer: number | null = null;
  let delay = LOBBY_POLL_MS;
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
  const unavailable = (err: unknown): boolean =>
    err instanceof ApiError && [404, 405, 501].includes(err.status);

  const load = async (): Promise<void> => {
    if (!panelRef || destroyed) return;
    try {
      const response = await ctx.api.lobby(roomId);
      requests = response.requests;
      fallback = false;
      error = null;
      loaded = true;
      delay = LOBBY_POLL_MS;
    } catch (err) {
      if (unavailable(err) && !loaded) {
        fallback = true;
        error = err;
      } else {
        error = err;
        delay = Math.min(delay * 2, MAX_POLL_MS);
      }
    } finally {
      renderPanel();
      if (!fallback && !destroyed) schedule();
    }
  };

  const ttlText = (request: LobbyRequestInfo): string => {
    const seconds = Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000));
    if (seconds <= 0) return 'истекла';
    return `ещё ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  const decide = async (request: LobbyRequestInfo, action: 'admit' | 'reject'): Promise<void> => {
    try {
      if (action === 'admit') await ctx.api.admitLobby(roomId, request.id);
      else await ctx.api.rejectLobby(roomId, request.id);
      ctx.toast(action === 'admit' ? `${request.name} впущен(а)` : `${request.name}: вход отклонён`, 'success');
      loaded = false;
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        ctx.toast('Заявка уже обработана или истекла — обновляю список.', 'warning');
        loaded = false;
        await load();
        return;
      }
      const info = describeError(err);
      ctx.toast([info.message, info.hint].filter(Boolean).join(' '), 'error');
    }
  };

  const rejectAll = async (): Promise<void> => {
    if (requests.length === 0) return;
    const confirmed = await confirmDialog({
      title: 'Отклонить всех?',
      message: `Будет отклонено заявок: ${requests.length}. Участники получат отказ и не смогут войти.`,
      confirmLabel: 'Отклонить всех',
      danger: true,
    });
    if (!confirmed) return;
    const results = await Promise.allSettled(requests.map((request) => ctx.api.rejectLobby(roomId, request.id)));
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    ctx.toast(`Отклонено: ${ok} из ${requests.length}`, ok === requests.length ? 'success' : 'warning');
    loaded = false;
    await load();
  };

  const requestCard = (request: LobbyRequestInfo): HTMLElement => {
    const card = h('article', { class: 'lobby-card' });
    card.appendChild(
      h(
        'div',
        { class: 'lobby-head' },
        h('div', { class: 'cell-stack' }, h('strong', { text: request.name || 'Без имени' }), h('span', { class: 'notice', text: request.country ? countryLabel(request.country) : 'Страна не определена' })),
        badge('ожидает', 'warning', { dot: true }),
      ),
    );
    card.appendChild(
      h(
        'div',
        { class: 'lobby-meta' },
        h('span', { text: `Подан: ${formatDateTime(request.createdAt)}` }),
        h('span', { text: `TTL: ${ttlText(request)}` }),
        h('span', { text: `Истекает: ${formatTime(request.expiresAt)}` }),
      ),
    );
    card.appendChild(
      h(
        'div',
        { class: 'lobby-actions' },
        button('Впустить', { variant: 'primary', size: 'sm', icon: 'check', onClick: () => void decide(request, 'admit') }),
        button('Отклонить', { variant: 'danger-ghost', size: 'sm', icon: 'x', onClick: () => void decide(request, 'reject') }),
      ),
    );
    return card;
  };

  const renderPanel = (): void => {
    const panel = panelRef;
    if (!panel) return;
    panel.replaceChildren();
    if (fallback) {
      panel.appendChild(
        alert('warning', 'Лобби появится после обновления сервера', 'Endpoint /v1/rooms/:roomId/lobby пока недоступен. Заявки, admit/reject и счётчик включатся без изменений панели.'),
      );
      return;
    }
    const toolbar = h(
      'div',
      { class: 'lobby-toolbar' },
      h('span', { class: 'lobby-count' }, badge(`Ожидают: ${requests.length}`, requests.length > 0 ? 'warning' : 'neutral', { dot: requests.length > 0 })),
      h('span', { class: 'spacer' }),
      button('Обновить', { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void load() }),
      requests.length > 0
        ? button('Отклонить всех', { variant: 'danger-ghost', size: 'sm', icon: 'x', onClick: () => void rejectAll() })
        : null,
    );
    panel.appendChild(toolbar);
    if (error && loaded) {
      panel.appendChild(alert('warning', 'Не удалось обновить лобби', describeError(error).message));
    }
    if (!loaded) {
      panel.appendChild(h('p', { class: 'notice', text: 'Загружаем заявки…' }));
      return;
    }
    if (requests.length === 0) {
      panel.appendChild(alert('info', 'Ожидающих нет', 'Новые заявки на вход появятся здесь автоматически (опрос каждые 5 секунд).'));
      return;
    }
    const list = h('div', { class: 'lobby-list' });
    for (const request of requests) list.appendChild(requestCard(request));
    panel.appendChild(list);
    panel.appendChild(h('p', { class: 'notice', text: 'Обновление каждые 5 секунд с backoff; действия — admit/reject для конкретной заявки.' }));
  };

  return {
    render: async (panel: HTMLElement) => {
      panelRef = panel;
      renderPanel();
      if (!loaded) await load();
      schedule();
    },
    stop,
  };
}
