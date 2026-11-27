/** Audit: full table, type/severity/room filters, limit/offset pagination, JSON export. */
import type { AuditEntry } from '@agil/protocol';
import type { AuditQuery } from '../api.js';
import type { ScreenFactory } from '../context.js';
import { h, setButtonLoading } from '../dom.js';
import { describeError, type ErrorInfo } from '../errors.js';
import { currentLocale, t } from '../i18n.js';
import { formatDateTime } from '../format.js';
import { severityBadge } from '../ui/badge.js';
import { button, field, selectInput, textInput } from '../ui/controls.js';
import { emptyState } from '../ui/empty-state.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { dataTable } from '../ui/table.js';
import { auditEntryMessage, auditTypeLabel, OTHER_AUDIT_TYPES, SECURITY_AUDIT_TYPES } from '../ui/audit-entry.js';
import { errorState, offlinePanel, pageHeader, refreshButton } from './common.js';

const EXPORT_LIMIT = 500;
const LIMIT_OPTIONS = [25, 50, 100].map((value) => ({ value: String(value), label: t('audit.perPageOption', { count: value }) }));

const SEVERITY_OPTIONS = [
  { value: 'all', label: t('audit.allSeverities') },
  { value: 'critical', label: t('audit.critical') },
  { value: 'warn', label: t('audit.warn') },
  { value: 'info', label: t('audit.info') },
];

function buildTypeSelect(): HTMLSelectElement {
  const select = h('select', { class: 'select', attrs: { 'aria-label': t('audit.eventType') } });
  select.appendChild(h('option', { text: t('audit.allTypes'), attrs: { value: 'all' } }));
  const securityGroup = h('optgroup', { attrs: { label: t('nav.security') } });
  for (const type of SECURITY_AUDIT_TYPES) {
    securityGroup.appendChild(h('option', { text: auditTypeLabel(type), attrs: { value: type } }));
  }
  const otherGroup = h('optgroup', { attrs: { label: t('audit.otherEvents') } });
  for (const type of OTHER_AUDIT_TYPES) {
    otherGroup.appendChild(h('option', { text: auditTypeLabel(type), attrs: { value: type } }));
  }
  select.append(securityGroup, otherGroup);
  return select;
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = h('a', { attrs: { href: url, download: filename } });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function describeAuditError(error: unknown): ErrorInfo {
  const info = describeError(error);
  if (currentLocale() === 'ru') return info;
  return {
    offline: info.offline,
    unauthorized: info.unauthorized,
    title: t('audit.loadFailed'),
    message: t(info.unauthorized ? 'audit.accessDenied' : info.offline ? 'audit.offline' : 'audit.requestFailed'),
  };
}

export const auditScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  let destroyed = false;
  let requestId = 0;
  let offset = 0;
  let anchorId: string | undefined;
  let applied: AuditQuery = {};
  let limit = 50;
  let loading = false;

  const typeSelect = buildTypeSelect();
  const severitySelect = selectInput(SEVERITY_OPTIONS, { value: 'all' });
  const roomInput = textInput({ placeholder: t('audit.roomId'), ariaLabel: t('audit.optionalRoomId') });
  const search = textInput({ type: 'search', placeholder: t('audit.searchHint'), ariaLabel: t('audit.search') });
  search.maxLength = 200;
  const limitSelect = selectInput(LIMIT_OPTIONS, { value: '50' });

  const applyButton = button(t('audit.apply'), {
    variant: 'primary',
    size: 'sm',
    icon: 'filter',
    type: 'submit',
  });
  const reset = (): void => {
    typeSelect.value = 'all';
    severitySelect.value = 'all';
    roomInput.value = '';
    search.value = '';
    limitSelect.value = '50';
    applyFilters();
  };
  const resetButton = button(t('audit.reset'), {
    variant: 'subtle',
    size: 'sm',
    onClick: reset,
  });
  const exportButton = button(t('audit.downloadJson'), {
    variant: 'ghost',
    size: 'sm',
    icon: 'download',
    onClick: () => {
      void (async () => {
        setButtonLoading(exportButton, true);
        try {
          const response = await ctx.api.audit({
            ...applied,
            anchorId,
            limit: EXPORT_LIMIT,
          });
          if (destroyed) return;
          downloadJson(`agil-audit-${Date.now()}.json`, {
            tenantId: ctx.tenantId,
            exportedAt: new Date().toISOString(),
            total: response.total,
            entries: response.entries,
          });
          const count = response.entries.length;
          ctx.toast(t('audit.downloaded', { count, total: response.total }), count < response.total ? 'warning' : 'success');
        } catch (error) {
          if (destroyed) return;
          const info = describeAuditError(error);
          if (info.offline) ctx.setServerStatus('offline');
          ctx.toast(`${t('audit.downloadFailed')}. ${info.message}`, 'error');
        } finally {
          setButtonLoading(exportButton, false);
          syncExportAvailability();
        }
      })();
    },
  });
  const syncExportAvailability = (): void => {
    exportButton.disabled = (loading && anchorId === undefined) || exportButton.getAttribute('aria-busy') === 'true';
  };
  const exportHint = h('p', {
    class: 'audit-filter-status cell-sub',
    attrs: { id: 'audit-export-hint' },
    text: t('audit.downloadHint', { limit: EXPORT_LIMIT }),
  });

  const filterStatus = h('p', {
    class: 'audit-filter-status cell-sub',
    attrs: { id: 'audit-filter-status', role: 'status' },
  });

  const filters = h(
    'form',
    { class: 'filters audit-filters' },
    field(t('audit.eventType'), typeSelect),
    field(t('audit.severity'), severitySelect),
    field(t('audit.room'), roomInput),
    field(t('audit.search'), search),
    field(t('audit.perPage'), limitSelect),
    filterStatus,
    h('div', { class: 'actions' }, applyButton, resetButton, exportButton),
    exportHint,
  );
  const readFilters = (): AuditQuery => ({
    type: typeSelect.value === 'all' ? undefined : typeSelect.value,
    severity: severitySelect.value === 'all' ? undefined : severitySelect.value,
    roomId: roomInput.value.trim() || undefined,
    q: search.value.trim() || undefined,
  });
  const readLimit = (): number => Number(limitSelect.value) || 50;
  const syncFilterStatus = (): void => {
    const draft = readFilters();
    const hasChanges = draft.type !== applied.type || draft.severity !== applied.severity ||
      draft.roomId !== applied.roomId || draft.q !== applied.q || readLimit() !== limit;
    const message = hasChanges ? t('audit.filtersPending') : '';
    if (filterStatus.textContent !== message) filterStatus.textContent = message;
    exportButton.setAttribute('aria-describedby', hasChanges ? `${exportHint.id} ${filterStatus.id}` : exportHint.id);
  };
  const applyFilters = (): void => {
    applied = readFilters();
    limit = readLimit();
    syncFilterStatus();
    void refresh();
  };
  filters.addEventListener('input', syncFilterStatus);
  filters.addEventListener('change', syncFilterStatus);
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    applyFilters();
  });
  syncFilterStatus();

  const paginationInfo = h('span', { class: 'pagination-info', attrs: { role: 'status' } });
  const prevButton = button(t('audit.previous'), { ariaLabel: t('audit.previousPage'), variant: 'ghost', size: 'sm', icon: 'chevron-left' });
  const nextButton = button(t('audit.next'), { ariaLabel: t('audit.nextPage'), variant: 'ghost', size: 'sm', iconAfter: 'chevron-right' });
  const pagination = h('nav', { class: 'pagination', attrs: { 'aria-label': t('nav.audit') } }, paginationInfo, prevButton, nextButton);

  root.appendChild(
    pageHeader({
      title: t('nav.audit'),
      subtitle: t('audit.subtitle'),
      actions: [refreshButton(() => refresh(), t('common.refresh')), h('a', { class: 'btn btn-subtle btn-sm', attrs: { href: '#/security' } }, t('nav.security'))],
    }),
  );
  root.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-body' }, filters)));
  root.appendChild(body);
  root.appendChild(pagination);

  prevButton.addEventListener('click', () => {
    if (loading) return;
    offset = Math.max(0, offset - limit);
    void load();
  });
  nextButton.addEventListener('click', () => {
    if (loading) return;
    offset += limit;
    void load();
  });

  const setPager = (previousDisabled: boolean, nextDisabled: boolean, fallback: HTMLElement): void => {
    const active = document.activeElement;
    prevButton.removeAttribute('aria-disabled');
    nextButton.removeAttribute('aria-disabled');
    prevButton.disabled = previousDisabled;
    nextButton.disabled = nextDisabled;
    if (active === prevButton && previousDisabled) (nextDisabled ? fallback : nextButton).focus();
    if (active === nextButton && nextDisabled) (previousDisabled ? fallback : prevButton).focus();
  };

  const renderEntries = (entries: AuditEntry[], totalCount: number): void => {
    setPager(offset === 0, offset + entries.length >= totalCount || entries.length === 0, applyButton);
    paginationInfo.textContent = entries.length > 0
      ? t('audit.range', { first: offset + 1, last: offset + entries.length, total: totalCount, page: Math.floor(offset / limit) + 1 })
      : t('audit.noEvents');

    if (entries.length === 0) {
      body.replaceChildren(
        emptyState({
          title: t('audit.noMatches'),
          message: t('audit.noMatchesHint'),
          iconName: 'audit',
          action: button(t('audit.resetFilters'), { onClick: () => { resetButton.focus(); reset(); } }),
        }),
      );
      return;
    }

    body.replaceChildren(
      dataTable<AuditEntry>({
        columns: [
          { key: 'ts', header: t('audit.time'), render: (entry) => formatDateTime(entry.ts), className: 'nowrap' },
          {
            key: 'type',
            header: t('audit.type'),
            render: (entry) =>
              h('span', {
                class: 'cell-title',
                attrs: { title: t('audit.eventCode', { code: entry.type }) },
                text: auditTypeLabel(entry.type),
              }),
          },
          { key: 'severity', header: t('audit.severity'), render: (entry) => severityBadge(entry.severity) },
          { key: 'tenant', header: t('app.tenant'), render: (entry) => entry.tenantId ?? '—' },
          {
            key: 'room',
            header: t('audit.room'),
            render: (entry) =>
              entry.roomId
                ? h('a', { attrs: { href: `#/rooms/${encodeURIComponent(entry.roomId)}` }, class: 'mono', text: entry.roomId })
                : '—',
          },
          { key: 'participant', header: t('audit.participant'), render: (entry) => h('span', { class: 'mono small', text: entry.participantId ?? '—' }) },
          { key: 'country', header: t('audit.country'), render: (entry) => entry.country ?? '—' },
          {
            key: 'message',
            header: t('audit.message'),
            render: (entry) => {
              const cell = h('div', { class: 'cell-stack' });
              cell.appendChild(
                h('span', {
                  class: 'cell-title',
                  attrs: { title: entry.message },
                  text: auditEntryMessage(entry),
                }),
              );
              if (entry.ipHash) cell.appendChild(h('span', { class: 'cell-sub', text: t('audit.ipHash', { hash: `${entry.ipHash.slice(0, 12)}…` }) }));
              if (entry.details) {
                cell.appendChild(
                  h('details', {}, h('summary', { class: 'cell-sub', text: t('audit.details') }),
                    h('pre', { class: 'audit-details mono small', attrs: { tabindex: '0' }, text: JSON.stringify(entry.details, null, 2) })),
                );
              }
              return cell;
            },
          },
        ],
        rows: entries,
        className: 'table-cards table-compact audit-table',
      }),
    );
  };

  const load = async (): Promise<void> => {
    const started = ++requestId;
    loading = true;
    syncExportAvailability();
    // Native disabling would blur a focused pager during each request.
    prevButton.setAttribute('aria-disabled', 'true');
    nextButton.setAttribute('aria-disabled', 'true');
    paginationInfo.textContent = '';
    body.replaceChildren(loadingPanel(t('audit.loading')), skeletonTable(6, 5));
    try {
      const response = await ctx.api.audit({ ...applied, limit, offset, anchorId });
      if (destroyed || started !== requestId) return;
      if (response.anchorId) anchorId = response.anchorId;
      if (offset > 0 && offset >= response.total) {
        offset = Math.max(0, Math.floor((response.total - 1) / limit) * limit);
        await load();
        return;
      }
      ctx.setServerStatus('online');
      loading = false;
      syncExportAvailability();
      renderEntries(response.entries, response.total);
    } catch (error) {
      if (destroyed || started !== requestId) return;
      const info = describeAuditError(error);
      loading = false;
      syncExportAvailability();
      if (info.offline) ctx.setServerStatus('offline');
      const retry = (): void => {
        applyButton.focus();
        void load();
      };
      const fragments: HTMLElement[] = [errorState(error, retry, undefined, describeAuditError)];
      if (info.offline && currentLocale() === 'ru') fragments.push(offlinePanel(retry));
      body.replaceChildren(...fragments);
      setPager(true, true, fragments[0]?.querySelector('button') ?? applyButton);
    }
  };

  const refresh = (): Promise<void> => {
    offset = 0;
    anchorId = undefined;
    return load();
  };

  void refresh();
  return { el: root, destroy: () => { destroyed = true; } };
};
