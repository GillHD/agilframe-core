/** Rooms: searchable table, quick actions, create/invite/delete flows. */
import type { AdminRoomSummary } from '@agil/protocol';
import type { ScreenFactory } from '../context.js';
import { debounce, h } from '../dom.js';
import { describeError } from '../errors.js';
import { formatNumber, formatShortDate } from '../format.js';
import { badge, boolBadge } from '../ui/badge.js';
import { button, field, selectInput, textInput } from '../ui/controls.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { copyText } from '../ui/copy-button.js';
import { emptyState } from '../ui/empty-state.js';
import { guardedSave } from '../ui/guard.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { dataTable } from '../ui/table.js';
import { toast } from '../ui/toast.js';
import { errorState, offlinePanel, pageHeader, refreshButton, toastError } from './common.js';
import { confirmRoomLockChange, openCreateRoomDialog, openInviteDialog } from './dialogs.js';

const ROOM_BATCH_SIZE = 25;

export const roomsScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  let allRooms: AdminRoomSummary[] = [];
  let destroyed = false;
  let loading = false;
  let loadRequest = 0;
  let search = '';
  let passwordFilter: 'all' | 'protected' | 'open' = 'all';
  let lockFilter: 'all' | 'locked' | 'unlocked' = 'all';

  const searchInput = textInput({ placeholder: 'Поиск комнат', type: 'search' });
  searchInput.addEventListener(
    'input',
    debounce(() => {
      search = searchInput.value;
      renderTable();
    }, 180),
  );

  const passwordSelect = selectInput(
    [
      { value: 'all', label: 'Все' },
      { value: 'protected', label: 'С паролем' },
      { value: 'open', label: 'Без пароля' },
    ],
    {
      value: 'all',
      onChange: (value) => {
        passwordFilter = value as typeof passwordFilter;
        renderTable();
      },
    },
  );

  const lockSelect = selectInput(
    [
      { value: 'all', label: 'Все' },
      { value: 'locked', label: 'Закрытые' },
      { value: 'unlocked', label: 'Открытые' },
    ],
    {
      value: 'all',
      onChange: (value) => {
        lockFilter = value as typeof lockFilter;
        renderTable();
      },
    },
  );

  const countLabel = h('span', { class: 'notice', text: '' });
  const tableHost = h('div', { class: 'rooms-list' });
  const end = h('div', { class: 'rooms-list-end', attrs: { 'aria-hidden': 'true' } });
  let observer: IntersectionObserver | undefined;

  let drag: { pointerId: number; startY: number; scrollTop: number; viewport: HTMLElement } | undefined;
  let dragged = false;
  tableHost.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    dragged = false;
    if (!(event.target instanceof Element) || !event.target.closest('tr.row-clickable') || event.target.closest('button')) return;
    const viewport = tableHost.closest<HTMLElement>('.content');
    if (!viewport) return;
    drag = { pointerId: event.pointerId, startY: event.clientY, scrollTop: viewport.scrollTop, viewport };
  });
  tableHost.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId || !(event.buttons & 1)) return;
    const distance = event.clientY - drag.startY;
    if (!dragged && Math.abs(distance) < 6) return;
    if (!dragged) {
      tableHost.setPointerCapture(event.pointerId);
      tableHost.classList.add('is-dragging');
      dragged = true;
    }
    event.preventDefault();
    drag.viewport.scrollTo({ top: drag.scrollTop - distance, behavior: 'instant' });
  });
  function stopDrag(): void {
    drag = undefined;
    tableHost.classList.remove('is-dragging');
  }
  tableHost.addEventListener('pointerup', stopDrag);
  tableHost.addEventListener('pointercancel', stopDrag);
  tableHost.addEventListener('pointerleave', () => { if (!dragged) stopDrag(); });
  tableHost.addEventListener('lostpointercapture', stopDrag);
  tableHost.addEventListener('dragstart', (event) => { if (drag) event.preventDefault(); });
  tableHost.addEventListener('click', (event) => {
    if (!dragged || event.detail === 0) return;
    dragged = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  function clearFilters(): void {
    searchInput.value = search = '';
    passwordSelect.value = passwordFilter = 'all';
    lockSelect.value = lockFilter = 'all';
    renderTable();
    searchInput.focus();
  }

  const filters = h(
    'div',
    { class: 'filters' },
    field('Поиск', searchInput),
    field('Пароль', passwordSelect),
    field('Вход', lockSelect),
    h('span', { class: 'spacer' }),
    countLabel,
    button('Сбросить', {
      variant: 'subtle',
      size: 'sm',
      onClick: clearFilters,
    }),
  );

  root.appendChild(
    pageHeader({
      title: 'Комнаты',
      subtitle: 'Создание тестовых комнат, приглашения и управление доступом.',
      actions: [
        refreshButton(() => load()),
        button('Создать комнату', {
          variant: 'primary',
          icon: 'plus',
          onClick: () => openCreateRoomDialog(ctx, { onCreated: () => void load() }),
        }),
      ],
    }),
  );
  root.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-body' }, filters)));
  root.appendChild(body);

  const iconAction = (
    iconName: 'copy' | 'code' | 'external' | 'link' | 'lock' | 'unlock' | 'trash',
    title: string,
    handler: () => void,
    variant: 'subtle' | 'danger-ghost' = 'subtle',
  ): HTMLButtonElement => button(undefined, { variant, size: 'sm', icon: iconName, title, onClick: handler });

  const copyLink = async (value: string, label: string): Promise<void> => {
    const ok = await copyText(value);
    ctx.toast(ok ? `${label} скопирована` : 'Не удалось скопировать ссылку', ok ? 'success' : 'error');
  };

  const modeBadgeFor = (room: AdminRoomSummary): HTMLElement =>
    badge(room.room.mode === 'direct' ? '1:1' : 'группа', room.room.mode === 'direct' ? 'info' : 'neutral', {
      title: `room.mode = ${room.room.mode ?? 'group'}`,
    });

  const contextLabel = (room: AdminRoomSummary): string | null => {
    const context = room.room.context;
    if (!context) return null;
    const parts = [context.messenger, context.title ?? context.conversationId, context.directPeerId]
      .filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      toastError(ctx, error);
    }
  };

  const renderTable = (): void => {
    if (destroyed || loading) return;
    const query = search.trim().toLowerCase();
    const rows = allRooms.filter((room) => {
      if (query && !`${room.room.name} ${room.room.id}`.toLowerCase().includes(query)) return false;
      if (passwordFilter === 'protected' && !room.passwordProtected) return false;
      if (passwordFilter === 'open' && room.passwordProtected) return false;
      if (lockFilter === 'locked' && !room.room.locked) return false;
      if (lockFilter === 'unlocked' && room.room.locked) return false;
      return true;
    });
    countLabel.textContent = `Найдено ${rows.length} из ${allRooms.length}`;
    observer?.disconnect();
    const rendered = Math.min(typeof IntersectionObserver === 'function' ? ROOM_BATCH_SIZE : rows.length, rows.length);
    const table = buildTable(rows.slice(0, rendered));
    const focused = document.activeElement;
    const focusedRoom = focused instanceof HTMLAnchorElement && focused.matches('.row-action-link') && tableHost.contains(focused)
      ? focused.getAttribute('href') : null;
    tableHost.replaceChildren(table);
    if (focusedRoom) {
      const replacement = Array.from(table.querySelectorAll<HTMLAnchorElement>('.row-action-link'))
        .find((link) => link.getAttribute('href') === focusedRoom);
      replacement?.focus({ preventScroll: true });
    }
    if (rendered === rows.length) return;

    const tbody = table.querySelector('tbody')!;
    let loaded = rendered;
    tableHost.append(end);
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || !tbody.isConnected) return;
      const batch = rows.slice(loaded, loaded + ROOM_BATCH_SIZE);
      loaded += batch.length;
      tbody.append(...buildTable(batch).querySelector('tbody')!.children);
      if (loaded === rows.length) {
        observer?.disconnect();
        end.remove();
      } else {
        // Recheck even when the marker stays inside a very tall viewport.
        observer?.unobserve(end);
        observer?.observe(end);
      }
    }, { rootMargin: '0px 0px 320px' });
    observer.observe(end);
  };

  const buildTable = (displayed: AdminRoomSummary[]): HTMLElement =>
      dataTable<AdminRoomSummary>({
        columns: [
          {
            key: 'room',
            header: 'Комната',
            render: (row) => {
              const context = contextLabel(row);
              return h(
                'div',
                { class: 'cell-stack' },
                h('span', { class: 'cell-title', text: row.room.name || 'Без названия', attrs: { title: row.room.name || 'Без названия' } }),
                h('span', { class: 'cell-sub', text: row.room.id, attrs: { title: row.room.id } }),
                context ? h('span', { class: 'cell-sub', text: context, attrs: { title: context } }) : null,
              );
            },
          },
          { key: 'mode', header: 'Тип', render: (row) => modeBadgeFor(row) },
          {
            key: 'participants',
            header: 'Участники',
            render: (row) => h('span', { class: 'mono', text: `${row.participants} / ${row.maxParticipants}` }),
          },
          { key: 'password', header: 'Пароль', render: (row) => boolBadge(row.passwordProtected, 'Да', 'Нет') },
          {
            key: 'locked',
            header: 'Статус',
            render: (row) =>
              row.room.locked ? badge('Закрыта', 'warning', { dot: true }) : badge('Открыта', 'success', { dot: true }),
          },
          { key: 'created', header: 'Создана', render: (row) => formatShortDate(row.createdAt) },
          { key: 'recordings', header: 'Записи', align: 'right', render: (row) => formatNumber(row.recordings) },
          {
            key: 'actions',
            header: 'Действия',
            align: 'right',
            render: (row) =>
              h(
                'div',
                { class: 'cell-actions' },
                iconAction('copy', 'Копировать ссылку для входа', () => void copyLink(row.joinUrl, 'Ссылка для входа')),
                iconAction('code', 'Копировать ссылку для встраивания', () => void copyLink(row.embedUrl, 'Ссылка для встраивания')),
                iconAction('link', 'Создать приглашение', () =>
                  openInviteDialog(ctx, {
                    roomId: row.room.id,
                    roomName: row.room.name,
                    onCreated: () => ctx.toast('Приглашение создано', 'success'),
                  }),
                ),
                iconAction(row.room.locked ? 'unlock' : 'lock', row.room.locked ? 'Открыть комнату' : 'Закрыть комнату', () =>
                  void run(async () => {
                    const nextLocked = !row.room.locked;
                    const confirmed = await confirmRoomLockChange(nextLocked);
                    if (!confirmed) return;
                    const result = await guardedSave(
                      'room',
                      { roomId: row.room.id, locked: nextLocked },
                      nextLocked ? `заблокировать новые входы в комнату «${row.room.name || row.room.id}»` : `открыть вход в комнату «${row.room.name || row.room.id}»`,
                      async () => ctx.api.setRoomLocked(row.room.id, nextLocked),
                    );
                    if (!result.allowed) return;
                    ctx.toast(row.room.locked ? 'Комната открыта' : 'Комната закрыта', 'success');
                    await load();
                  }),
                ),
                iconAction(
                  'trash',
                  'Удалить комнату',
                  () =>
                    void (async () => {
                      const confirmed = await confirmDialog({
                        title: 'Удалить комнату?',
                        message: `Комната «${row.room.name || row.room.id}» будет закрыта, участники отключены. Действие необратимо.`,
                        confirmLabel: 'Удалить',
                        danger: true,
                      });
                      if (!confirmed) return;
                      await run(async () => {
                        const result = await guardedSave(
                          'room',
                          { roomId: row.room.id, delete: true },
                          `удалить комнату «${row.room.name || row.room.id}»`,
                          async () => ctx.api.deleteRoom(row.room.id),
                        );
                        if (!result.allowed) return;
                        ctx.toast('Комната удалена', 'success');
                        await load();
                      });
                    })(),
                  'danger-ghost',
                ),
              ),
          },
        ],
        rows: displayed,
        className: 'rooms-table table-cards',
        onRowClick: (row) => ctx.navigate(`/rooms/${encodeURIComponent(row.room.id)}`),
        rowAction: (row) => ({
          label: `Открыть комнату «${row.room.name || row.room.id}», ID ${row.room.id}`,
          href: `#/rooms/${encodeURIComponent(row.room.id)}`,
        }),
        empty: emptyState({
          title: allRooms.length === 0 ? 'Комнат пока нет' : 'Ничего не найдено',
          message:
            allRooms.length === 0
              ? 'Создайте тестовую комнату — сервер выдаст ссылки для входа и встраивания, а также токен.'
              : 'Измените поиск или сбросьте фильтры.',
          iconName: 'rooms',
          action:
            allRooms.length === 0
              ? button('Создать комнату', {
                  variant: 'primary',
                  size: 'sm',
                  icon: 'plus',
                  onClick: () => openCreateRoomDialog(ctx, { onCreated: () => void load() }),
                })
              : button('Сбросить фильтры', {
                  variant: 'ghost',
                  size: 'sm',
                  onClick: clearFilters,
                }),
        }),
      });

  const load = async (): Promise<void> => {
    if (destroyed) return;
    const request = ++loadRequest;
    loading = true;
    observer?.disconnect();
    countLabel.textContent = '';
    body.replaceChildren(loadingPanel('Загружаем комнаты…'), skeletonTable(5, 6));
    try {
      const rooms = await ctx.api.rooms();
      if (destroyed || request !== loadRequest) return;
      loading = false;
      allRooms = rooms;
      ctx.setServerStatus('online');
      body.replaceChildren(tableHost);
      renderTable();
    } catch (error) {
      if (destroyed || request !== loadRequest) return;
      loading = false;
      const info = describeError(error);
      if (info.offline) ctx.setServerStatus('offline');
      const fragments: HTMLElement[] = [errorState(error, () => void load())];
      if (info.offline) fragments.push(offlinePanel(() => void load()));
      body.replaceChildren(...fragments);
    }
  };

  void load();
  return { el: root, destroy: () => { destroyed = true; observer?.disconnect(); } };
};
