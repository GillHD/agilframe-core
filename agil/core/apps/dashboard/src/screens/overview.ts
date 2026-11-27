/** Overview: KPI, latest rooms, country distribution, quick links and server health. */
import type { AdminOverview, AdminRoomSummary, HealthResponse } from '@agil/protocol';
import type { ScreenFactory } from '../context.js';
import { h } from '../dom.js';
import { describeError } from '../errors.js';
import { formatNumber, formatTime, formatUptime, relativeTime, countryLabel } from '../format.js';
import { icon, type IconName } from '../icons.js';
import { publicLinks } from '../links.js';
import { badge, boolBadge } from '../ui/badge.js';
import { barList, card, kpiCard, kvGrid } from '../ui/card.js';
import { button } from '../ui/controls.js';
import { emptyState } from '../ui/empty-state.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { dataTable } from '../ui/table.js';
import { errorState, offlinePanel, pageHeader, refreshButton } from './common.js';
import { openCreateRoomDialog } from './dialogs.js';

function quickLink(title: string, subtitle: string, href: string, iconName: IconName, external = false): HTMLAnchorElement {
  const link = h('a', {
    class: 'quick-link',
    attrs: external ? { href, target: '_blank', rel: 'noopener noreferrer' } : { href },
  });
  const iconWrap = h('span', { class: 'quick-link-icon' });
  iconWrap.appendChild(icon(iconName, 16));
  link.append(
    iconWrap,
    h(
      'span',
      { class: 'quick-link-text' },
      h('span', { class: 'quick-link-title', text: title }),
      h('span', { class: 'quick-link-sub', text: subtitle }),
    ),
  );
  return link;
}

export const overviewScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const refresh = refreshButton(() => load());
  const createButton = button('Создать комнату', {
    variant: 'primary',
    icon: 'plus',
    onClick: () => openCreateRoomDialog(ctx, { onCreated: () => void load() }),
  });
  const lobbyBadge = badge('Ожидают: 0', 'warning', { dot: true });
  lobbyBadge.hidden = true;
  root.appendChild(
    pageHeader({
      eyebrow: 'Организация ' + ctx.tenantId,
      title: 'Обзор',
      subtitle: 'Комнаты, участники, записи и события безопасности вашей организации.',
      actions: [lobbyBadge, refresh, createButton],
    }),
  );
  const body = h('div', { class: 'stack' });
  root.appendChild(body);
  let destroyed = false;
  let loadRequest = 0;

  const render = (overview: AdminOverview, rooms: AdminRoomSummary[], health: HealthResponse | null, roomsError: unknown, lobbyPending: number, lobbyIsPartial: boolean): void => {
    body.replaceChildren();
    lobbyBadge.textContent = lobbyIsPartial ? `Ожидают в последних 20 комнатах: ${lobbyPending}` : `Ожидают: ${lobbyPending}`;
    lobbyBadge.hidden = lobbyPending <= 0;
    const kpis = h(
      'div',
      { class: 'kpi-grid' },
      kpiCard({
        label: 'Активные комнаты',
        value: formatNumber(overview.activeRooms),
        hint: overview.waitingParticipants === undefined ? undefined : `Создано с запуска Core: ${formatNumber(overview.totalRoomsCreated)}`,
        iconName: 'rooms',
      }),
      kpiCard({
        label: 'Участники',
        value: formatNumber(overview.activeParticipants),
        hint: 'Сейчас в звонках',
        iconName: 'activity',
        tone: 'info',
      }),
      kpiCard({
        label: 'Записи',
        value: formatNumber(overview.recordings),
        hint: `Файлов в хранилище: ${formatNumber(overview.sharedFiles)}`,
        iconName: 'recordings',
        tone: 'success',
      }),
      kpiCard({
        label: 'События безопасности · 24ч',
        value: formatNumber(overview.securityEvents24h),
        hint: 'Отказы при входе, гео-блокировки, блокировка после неудачных попыток',
        iconName: 'security',
        tone: overview.securityEvents24h > 0 ? 'danger' : 'info',
      }),
    );
    body.appendChild(kpis);

    /* --------------------------- latest rooms ---------------------------- */
    const sortedRooms = [...(Array.isArray(rooms) ? rooms : [])]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 7);
    const roomsTable = dataTable<AdminRoomSummary>({
      columns: [
        {
          key: 'room',
          header: 'Комната',
          render: (row) => {
            const context = row.room.context;
            const contextText = context
              ? [context.messenger, context.title ?? context.conversationId].filter(Boolean).join(' · ')
              : '';
            return h(
              'div',
              { class: 'cell-stack' },
              h(
                'span',
                { class: 'row', attrs: { style: 'gap:6px;flex-wrap:nowrap' } },
                h('span', { class: 'cell-title', text: row.room.name || 'Без названия' }),
                badge(row.room.mode === 'direct' ? '1:1' : 'группа', row.room.mode === 'direct' ? 'info' : 'neutral', {
                  title: `room.mode = ${row.room.mode ?? 'group'}`,
                }),
              ),
              h('span', { class: 'cell-sub', text: row.room.id }),
              contextText ? h('span', { class: 'cell-sub', text: contextText }) : null,
            );
          },
        },
        {
          key: 'participants',
          header: 'Участники',
          render: (row) => `${row.participants} / ${row.maxParticipants}`,
        },
        { key: 'password', header: 'Пароль', render: (row) => boolBadge(row.passwordProtected, 'Да', 'Нет') },
        { key: 'locked', header: 'Замок', render: (row) => boolBadge(row.room.locked, 'Закрыта', 'Открыта') },
        { key: 'activity', header: 'Активность', render: (row) => relativeTime(row.lastActivityAt) },
      ],
      rows: sortedRooms,
      onRowClick: (row) => ctx.navigate(`/rooms/${encodeURIComponent(row.room.id)}`),
      rowAction: (row) => ({
        label: `Открыть комнату «${row.room.name || row.room.id}», ID ${row.room.id}`,
        href: `#/rooms/${encodeURIComponent(row.room.id)}`,
      }),
      empty: emptyState({
        title: 'Комнат пока нет',
        message: 'Создайте тестовую комнату и отправьте приглашение коллеге.',
        iconName: 'rooms',
        action: button('Создать комнату', {
          variant: 'primary',
          size: 'sm',
          icon: 'plus',
          onClick: () => openCreateRoomDialog(ctx, { onCreated: () => void load() }),
        }),
      }),
    });
    const roomsCard = card({
      title: 'Последние комнаты',
      subtitle: roomsError ? undefined : `Сейчас в организации: ${rooms.length}`,
      actions: [
        h('a', { class: 'btn btn-subtle btn-sm', attrs: { href: '#/rooms' } }, 'Все комнаты'),
      ],
      body: roomsError
        ? errorState(roomsError, () => void load())
        : roomsTable,
      flush: !roomsError,
    });

    /* ------------------------------ countries ---------------------------- */
    const countries = Object.entries(overview.countries ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([code, count]) => ({ label: countryLabel(code), value: count }));
    const countriesCard = card({
      title: 'Распределение по странам',
      subtitle: 'по активным участникам',
      body: barList(countries, 'Геоданные пока недоступны'),
    });

    /* --------------------------- quick links ----------------------------- */
    const links = publicLinks(ctx.credentials.serverUrl);
    const quickLinks = card({
      title: 'Быстрый старт',
      subtitle: 'соседние приложения и API',
      body: h(
        'div',
        { class: 'quick-links' },
        quickLink('Демо-звонок', 'Тест встраиваемого звонка', links.demo, 'play', true),
        quickLink('Визуальный редактор', 'Тема, функции и расположение', links.editor, 'settings', true),
        quickLink('Документация API', 'Интерактивные запросы (/docs)', links.apiDocs, 'code', true),
        quickLink('Спецификация OpenAPI 3.1', 'Машиночитаемое описание API (/openapi.json)', links.openapi, 'file', true),
        quickLink('Доступы и токены', 'Матрица прав и выдача токенов', '#/access', 'key'),
        quickLink('Ассистент по базе знаний', 'Вопросы по базе знаний', '#/knowledge', 'book'),
      ),
    });

    // The right column would otherwise end after the short countries card and
    // leave ~330 px of empty space; the quick links fill it and stay above the fold.
    body.appendChild(h('div', { class: 'split' }, roomsCard, h('div', { class: 'stack' }, countriesCard, quickLinks)));

    /* --------------------------- server health --------------------------- */
    const healthBody = health
      ? kvGrid([
          { label: 'Сервер', value: `${health.name} ${health.version}` },
          { label: 'Время работы', value: formatUptime(health.uptimeSec) },
          { label: 'Комнат на сервере', value: formatNumber(health.rooms) },
          { label: 'Организаций', value: formatNumber(health.tenants) },
          {
            label: 'Подсистемы',
            value: h(
              'div',
              { class: 'chips' },
              badge(health.security.geoEnabled ? 'Гео: вкл' : 'Гео: выкл', health.security.geoEnabled ? 'success' : 'neutral'),
              badge(health.security.integrityEnabled ? 'Проверка подлинности: вкл' : 'Проверка подлинности: выкл', health.security.integrityEnabled ? 'success' : 'neutral'),
              badge(health.security.sttConfigured ? 'Распознавание речи: настроено' : 'Распознавание речи: не настроено', health.security.sttConfigured ? 'success' : 'warning'),
              badge(health.security.aiAgentConfigured ? 'ИИ: настроен' : 'ИИ: встроенные подсказки', health.security.aiAgentConfigured ? 'success' : 'neutral'),
            ),
          },
        ])
      : errorState(new Error('Состояние сервера недоступно. Проверьте, что сервер запущен, и повторите.'), () => void load());
    const healthCard = card({
      title: 'Сервер',
      subtitle: 'состояние, версия и подключённые функции',
      subtitleTitle: 'GET /v1/health',
      body: healthBody,
      actions: [
        h(
          'a',
          { class: 'btn btn-subtle btn-sm', attrs: { href: links.apiDocs, target: '_blank', rel: 'noopener noreferrer' } },
          'Документация API',
        ),
      ],
    });

    body.appendChild(healthCard);
    body.appendChild(
      h('p', { class: 'notice', text: `Данные на ${formatTime(overview.serverTime)} · обновляются кнопкой «Обновить».` }),
    );
  };

  const load = async (): Promise<void> => {
    const request = ++loadRequest;
    if (body.contains(document.activeElement)) refresh.focus({ preventScroll: true });
    body.replaceChildren(loadingPanel('Загружаем обзор…'), skeletonTable(2, 4));
    const [overviewResult, roomsResult, healthResult] = await Promise.allSettled([
      ctx.api.overview(),
      ctx.api.rooms(),
      ctx.api.health(),
    ]);
    if (destroyed || request !== loadRequest) return;
    if (overviewResult.status === 'rejected') {
      const info = describeError(overviewResult.reason);
      if (info.offline) ctx.setServerStatus('offline');
      const fragments: HTMLElement[] = [errorState(overviewResult.reason, () => void load())];
      if (info.offline) fragments.push(offlinePanel(() => void load()));
      body.replaceChildren(...fragments);
      return;
    }
    ctx.setServerStatus('online');
    const activeRooms = roomsResult.status === 'fulfilled' ? roomsResult.value : [];
    let lobbyPending = overviewResult.value.waitingParticipants ?? 0;
    const legacyLobby = overviewResult.value.waitingParticipants === undefined;
    if (legacyLobby && activeRooms.length > 0) {
      const lobbyResults = await Promise.allSettled(activeRooms.slice(0, 20).map((room) => ctx.api.lobby(room.room.id)));
      for (const result of lobbyResults) {
        if (result.status === 'fulfilled') lobbyPending += result.value.requests.length;
      }
    }
    if (destroyed || request !== loadRequest) return;
    render(
      overviewResult.value,
      activeRooms,
      healthResult.status === 'fulfilled' ? healthResult.value : null,
      roomsResult.status === 'rejected' ? roomsResult.reason : null,
      lobbyPending,
      legacyLobby && activeRooms.length > 20,
    );
  };

  void load();
  return { el: root, destroy: () => { destroyed = true; } };
};
