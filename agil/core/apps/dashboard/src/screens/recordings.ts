/** Recordings: list, filter by room, download and delete. */
import type { RecordingRecord } from '@agil/protocol';
import type { ScreenFactory } from '../context.js';
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { describeError } from '../errors.js';
import { formatBytes, formatClock, formatDateTime, formatDuration } from '../format.js';
import { badge } from '../ui/badge.js';
import { kvGrid } from '../ui/card.js';
import { button, field, textInput } from '../ui/controls.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { emptyState } from '../ui/empty-state.js';
import { openModal } from '../ui/modal.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { dataTable } from '../ui/table.js';
import { tableSearch } from '../ui/table-search.js';
import { errorState, offlinePanel, pageHeader, refreshButton, toastError } from './common.js';

export const recordingsScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  const summary = h('div', { class: 'kpi-grid' });
  let destroyed = false;
  let loadRequest = 0;
  let recordings: RecordingRecord[] = [];
  let loading = false;
  let appliedRoom: string | undefined;

  const roomInput = textInput({ placeholder: 'ID комнаты', ariaLabel: 'ID комнаты (необязательно)' });
  const roomFilterStatus = h('div', { class: 'notice', attrs: { id: 'recordings-room-filter-status', role: 'status' } });
  const readRoom = (): string | undefined => roomInput.value.trim() || undefined;
  const syncRoomFilterStatus = (): void => {
    const pending = readRoom() !== appliedRoom;
    const message = pending ? t('recordings.roomFilterPending') : '';
    if (roomFilterStatus.textContent !== message) roomFilterStatus.textContent = message;
    if (pending) roomInput.setAttribute('aria-describedby', roomFilterStatus.id);
    else roomInput.removeAttribute('aria-describedby');
  };
  roomInput.addEventListener('input', syncRoomFilterStatus);
  const applyRoomFilter = (): void => {
    appliedRoom = readRoom();
    syncRoomFilterStatus();
    void load();
  };
  const recordingSearch = tableSearch(t('table.searchRecordings'), t('table.searchRecordingsHint'), () => {
    if (!loading) render();
  });
  const loadButton = button(t('recordings.show'), {
    variant: 'primary',
    size: 'sm',
    icon: 'filter',
    type: 'submit',
  });
  const reset = button('Сбросить', { variant: 'subtle', size: 'sm', onClick: () => {
    roomInput.value = '';
    recordingSearch.reset();
    applyRoomFilter();
  } });

  root.appendChild(
    pageHeader({
      title: 'Записи',
      subtitle: 'До 500 последних записей. Ссылка на скачивание обновляется после истечения срока.',
      actions: [refreshButton(() => load())],
    }),
  );
  root.appendChild(
    h(
      'div',
      { class: 'card' },
      h(
        'div', { class: 'card-body' },
        h('form', { class: 'filters', on: { submit: (event) => {
          event.preventDefault();
          applyRoomFilter();
        } } }, field('Комната', roomInput), loadButton, reset),
        roomFilterStatus,
      ),
    ),
  );
  root.appendChild(summary);
  root.appendChild(recordingSearch.el);
  root.appendChild(body);

  const recordingRoomLink = (row: RecordingRecord): HTMLAnchorElement => h('a', {
    class: 'mono mono-clip',
    attrs: { href: `#/rooms/${encodeURIComponent(row.roomId)}`, title: row.roomId },
    text: row.roomId,
  });

  const expired = (url: URL): boolean => {
    const expiry = url.searchParams.get('exp');
    return expiry !== null && Number(expiry) <= Date.now();
  };

  const download = async (row: RecordingRecord): Promise<void> => {
    const api = ctx.api;
    try {
      let url = new URL(api.resolveUrl(row.url));
      if (expired(url)) {
        const fresh = (await api.recordings(row.roomId)).find((item) => item.id === row.id);
        if (destroyed || api !== ctx.api) return;
        if (!fresh) throw new Error('Запись больше недоступна. Обновите список.');
        url = new URL(api.resolveUrl(fresh.url));
        if (expired(url)) throw new Error('Сервер не выдал действующую ссылку. Повторите скачивание.');
        row.url = fresh.url;
      }
      const link = h('a', { attrs: { href: url.href, download: '', target: '_blank', rel: 'noopener noreferrer' } });
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      if (!destroyed) toastError(ctx, error);
    }
  };

  const openRecording = (row: RecordingRecord): void => {
    const dialog = openModal({
      title: 'Запись звонка',
      body: [kvGrid([
        { label: 'ID записи', value: h('span', { class: 'recording-text', text: row.id }) },
        { label: 'Комната', value: recordingRoomLink(row) },
        { label: 'Создана', value: formatDateTime(row.createdAt) },
        { label: 'Автор', value: row.createdBy || '—' },
        { label: 'Длительность', value: formatDuration(row.durationSec) },
        { label: 'Размер', value: formatBytes(row.size) },
      ]),
      h('h3', { text: 'Расшифровка' }),
      h('p', { class: 'recording-text', text: row.transcript || 'Расшифровки пока нет.' })],
      footer: [button('Закрыть', { variant: 'ghost', onClick: () => dialog.close() }),
        button('Скачать', { variant: 'primary', icon: 'download', onClick: () => void download(row) })],
    });
    dialog.root.querySelector('a')?.addEventListener('click', () => dialog.close());
  };

  const renderSummary = (): void => {
    const totalSize = recordings.reduce((sum, item) => sum + item.size, 0);
    const totalDuration = recordings.reduce((sum, item) => sum + item.durationSec, 0);
    const withTranscript = recordings.filter((item) => Boolean(item.transcript)).length;
    summary.replaceChildren(
      h('div', { class: 'kpi' }, h('div', { class: 'kpi-label', text: 'Записей' }), h('div', { class: 'kpi-value', text: String(recordings.length) })),
      h('div', { class: 'kpi' }, h('div', { class: 'kpi-label', text: 'Общий размер' }), h('div', { class: 'kpi-value', text: formatBytes(totalSize) })),
      h('div', { class: 'kpi' }, h('div', { class: 'kpi-label', text: 'Суммарная длительность' }), h('div', { class: 'kpi-value', text: formatDuration(totalDuration) })),
      h('div', { class: 'kpi' }, h('div', { class: 'kpi-label', text: 'С расшифровкой' }), h('div', { class: 'kpi-value', text: String(withTranscript) })),
    );
  };

  const render = (): void => {
    const visible = recordings.filter((row) => recordingSearch.matches(row.id, row.roomId, row.createdBy, row.mime));
    recordingSearch.setCount(visible.length, recordings.length);
    renderSummary();
    body.replaceChildren(
      dataTable<RecordingRecord>({
        columns: [
          {
            key: 'id',
            header: 'Запись',
            // UUIDs are wider than the cell: clip with an ellipsis and keep the
            // full value in the native tooltip (QA P2).
            render: (row) =>
              h(
                'div',
                { class: 'cell-stack' },
                h('span', { class: 'cell-sub mono-clip', attrs: { title: row.id }, text: row.id }),
                h('span', { class: 'cell-sub', text: row.mime }),
              ),
          },
          { key: 'room', header: 'Комната', render: recordingRoomLink },
          { key: 'createdAt', header: 'Создана', render: (row) => formatDateTime(row.createdAt) },
          { key: 'duration', header: 'Длительность', render: (row) => formatClock(row.durationSec) },
          { key: 'size', header: 'Размер', align: 'right', render: (row) => formatBytes(row.size) },
          { key: 'createdBy', header: 'Автор', render: (row) => row.createdBy || '—' },
          { key: 'transcript', header: 'Расшифровка', render: (row) => (row.transcript ? badge('есть', 'success') : badge('нет', 'neutral')) },
          {
            key: 'actions',
            header: 'Действия',
            align: 'right',
            render: (row) =>
              h(
                'div',
                { class: 'cell-actions' },
                button(undefined, {
                  variant: 'subtle', size: 'sm', icon: 'file', title: 'Открыть карточку записи',
                  onClick: () => openRecording(row),
                }),
                button(undefined, {
                  variant: 'subtle',
                  size: 'sm',
                  icon: 'download',
                  title: 'Скачать по подписанной ссылке',
                  onClick: () => void download(row),
                }),
                row.source === 'egress' && !row.canDelete ? null : button(undefined, {
                  variant: 'danger-ghost',
                  size: 'sm',
                  icon: 'trash',
                  title: 'Удалить запись',
                  onClick: () => {
                    void (async () => {
                      const confirmed = await confirmDialog({
                        title: 'Удалить запись?',
                        message: row.source === 'egress'
                          ? `Запись ${row.id} (${formatBytes(row.size)}) исчезнет из архива. Текущий файл удалится из хранилища.`
                          : `Файл ${row.id} (${formatBytes(row.size)}) будет удалён с сервера. Действие необратимо.`,
                        confirmLabel: 'Удалить',
                        danger: true,
                      });
                      if (!confirmed) return;
                      try {
                        await ctx.api.deleteRecording(row.id);
                        ctx.toast('Запись удалена', 'success');
                        await load();
                      } catch (error) {
                        toastError(ctx, error);
                      }
                    })();
                  },
                }),
              ),
          },
        ],
        rows: visible,
        className: 'table-cards table-compact',
        empty: recordingSearch.active ? emptyState({ title: t('table.noMatches'), compact: true }) : emptyState({
          title: 'Записей пока нет',
          message:
            'Записи не найдены. Включите запись в настройках организации или выберите другую комнату. Файлы скачиваются по подписанной ссылке с ограниченным сроком действия (TTL).',
          iconName: 'recordings',
        }),
      }),
    );
  };

  const load = async (): Promise<void> => {
    const request = ++loadRequest;
    loading = true;
    recordingSearch.el.hidden = true;
    body.replaceChildren(loadingPanel('Загружаем записи…'), skeletonTable(4, 5));
    summary.replaceChildren();
    try {
      const result = await ctx.api.recordings(appliedRoom);
      if (destroyed || request !== loadRequest) return;
      recordings = result;
      loading = false;
      recordingSearch.el.hidden = false;
      ctx.setServerStatus('online');
      render();
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
  return { el: root, destroy: () => { destroyed = true; } };
};
