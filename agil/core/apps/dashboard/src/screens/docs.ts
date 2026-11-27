/**
 * «Документация»: безопасный просмотр markdown, редактирование, загрузка
 * своих .md/.txt, история версий, выбор основного документа.
 *
 * Backend API: `/v1/admin/docs*` (protocol Doc* DTOs). Пока сервер отвечает
 * 404, панель показывает встроенные документы из `BUNDLED_DOCS` и честно
 * предупреждает, что редактирование/версии появятся после обновления сервера.
 */
import type {
  DocContentResponse,
  DocEntry,
  DocVersion,
  DocsListResponse,
} from '@agil/protocol';
import { decodeWikiAnchor, isWikiDocument, parseWikiMarkdown } from '@agil/protocol';
import { ApiError } from '../api.js';
import type { AppContext, DocumentDraft, ScreenFactory } from '../context.js';
import { h } from '../dom.js';
import { describeError, type ErrorInfo } from '../errors.js';
import { currentLocale, t } from '../i18n.js';
import { formatBytes, formatDateTime } from '../format.js';
import { BUNDLED_DOCS, docsRawUrl, docsRoute } from '../links.js';
import { renderMarkdown, renderWikiMarkdown } from '../markdown.js';

export { renderMarkdown } from '../markdown.js';
import { badge } from '../ui/badge.js';
import { card } from '../ui/card.js';
import { button, field, formGrid, textInput } from '../ui/controls.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { emptyState } from '../ui/empty-state.js';
import { guardedSave } from '../ui/guard.js';
import { openModal, type ModalHandle } from '../ui/modal.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { createTabs, type TabsHandle } from '../ui/tabs.js';
import { alert, errorState, pageHeader, refreshButton, reportErrorStatus } from './common.js';

type DocsTab = 'preview' | 'edit' | 'history' | 'upload';

function documentBadge(doc: { bundled: boolean; custom: boolean }): HTMLElement {
  if (!doc.bundled) return badge(t('docs.uploaded'), 'warning');
  return doc.custom ? badge(t('docs.modified'), 'warning') : badge(t('docs.bundled'), 'neutral');
}

function versionStatus(version: DocVersion): string {
  if (version.isCurrent) return t('docs.current');
  if (version.note === 'reset') return t('docs.archivedBeforeReset');
  if (version.note === 'upload') return t('docs.archivedBeforeUpload');
  if (version.note?.startsWith('restore:')) return t('docs.archivedBeforeRestore');
  return t('docs.previousPublication');
}

function describeDocumentError(error: unknown): ErrorInfo {
  const info = describeError(error);
  if (currentLocale() === 'ru') return info;
  const status = error instanceof ApiError ? error.status : 0;
  const reason = info.offline ? 'offline' : info.unauthorized ? 'session'
    : status === 403 ? 'forbidden' : status === 404 ? 'notFound' : status === 413 ? 'tooLarge' : 'generic';
  return {
    offline: info.offline,
    unauthorized: info.unauthorized,
    title: t('docs.requestFailed'),
    message: t(`docs.failure.${reason}`),
    ...(status > 0 ? { hint: t('docs.httpStatus', { status }) } : {}),
  };
}

function documentErrorState(error: unknown, retry: () => void): HTMLElement {
  return errorState(error, retry, undefined, describeDocumentError);
}

function toastError(ctx: AppContext, error: unknown): void {
  reportErrorStatus(ctx, error);
  ctx.toast(describeDocumentError(error).message, 'error');
}

const MAX_UPLOAD_BYTES = 200 * 1024;
const DOC_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.(md|txt)$/i;

function docNameFromFile(fileName: string): string {
  const base = fileName
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? 'document.md';
  const cleaned = base.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return DOC_NAME_PATTERN.test(cleaned) ? cleaned : `${cleaned.replace(/\.(md|markdown|txt)$/i, '') || 'document'}.md`;
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const match = /^\s*#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim().slice(0, 120) || fallback;
}

/** The card head already shows the document title — drop the duplicate H1. */
function withoutLeadingTitle(markdown: string, title: string): string {
  const match = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(markdown);
  if (match && match[1]?.trim() === title.trim()) return markdown.slice(match[0].length);
  return markdown;
}

export const docsScreen: ScreenFactory = (ctx: AppContext) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  let docs: DocEntry[] = [];
  let defaultName = '';
  let editable = false;
  let fallback = false;
  let fallbackContents = new Map<string, string>();
  let selectedName = '';
  let selected: DocContentResponse | null = null;
  let versions: DocVersion[] | null = null;
  let versionsError: unknown = null;
  let docsError: unknown = null;
  let loading = true;
  let contentLoading = false;
  let contentError: unknown = null;
  let historyLoading = false;
  let activeTab: DocsTab = 'preview';
  let tabsHandle: TabsHandle | null = null;
  let search = '';
  const drafts = ctx.documentDrafts;
  const updateDraft = (name: string, draft?: DocumentDraft): void => {
    if (draft) drafts.set(name, draft);
    else drafts.delete(name);
    ctx.documentDraftsChanged();
  };
  let selectedRequest = 0;
  let historyRequest = 0;
  let destroyed = false;
  let versionPreview: ModalHandle | null = null;
  let restoreConflictName: string | null = null;
  let restoring = false;
  let resetting = false;
  let revisionRestore = false;
  let conditionalCreate = false;
  const initialQuery = new URLSearchParams(window.location.hash.split('?')[1]);
  let requestedTab = initialQuery.get('tab');

  const requestedName = (): string => {
    try {
      const query = window.location.hash.split('?')[1] ?? '';
      return new URLSearchParams(query).get('name') ?? '';
    } catch {
      return '';
    }
  };

  const rawUrl = (name: string): string => docsRawUrl(ctx.credentials.serverUrl, name);

  const docTitle = (name: string): string => {
    const found = docs.find((doc) => doc.name === name);
    return found?.title || name;
  };

  const refreshList = async (preferredName?: string): Promise<void> => {
    loading = true;
    docsError = null;
    fallback = false;
    renderAll();
    try {
      const response: DocsListResponse = await ctx.api.docs();
      docs = response.docs;
      defaultName = response.defaultName;
      editable = response.editable;
      revisionRestore = response.revisionRestore === true;
      conditionalCreate = response.conditionalCreate === true;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
        fallback = true;
        editable = false;
        docs = [];
        fallbackContents = new Map();
        await Promise.all(
          BUNDLED_DOCS.map(async (meta) => {
            let content = `# ${meta.title}\n\n${t('docs.unavailableServer')}`;
            try {
              const response = await fetch(rawUrl(meta.name), { cache: 'no-cache' });
              if (response.ok) content = await response.text();
            } catch {
              /* fallback content below */
            }
            fallbackContents.set(meta.name, content);
            docs.push({
              name: meta.name,
              title: titleFromMarkdown(content, meta.title),
              sizeBytes: new TextEncoder().encode(content).length,
              updatedAt: 0,
              bundled: true,
              custom: false,
              isDefault: meta.name === 'api-guide.md',
              versions: 0,
            });
          }),
        );
        defaultName = 'api-guide.md';
      } else {
        docsError = error;
      }
    } finally {
      loading = false;
    }
    if (destroyed) return;
    const wanted = requestedName();
    const firstAvailableDraft = editable ? docs.find((doc) => drafts.has(doc.name)) : undefined;
    const candidate =
      docs.find((doc) => doc.name === preferredName) ??
      docs.find((doc) => doc.name === wanted) ??
      firstAvailableDraft ??
      docs.find((doc) => doc.name === defaultName) ??
      docs[0];
    selectedName = candidate?.name ?? '';
    if (!docsError) {
      if (editable && wanted === selectedName && (requestedTab === 'edit' || requestedTab === 'history')) {
        activeTab = requestedTab;
      } else if (!preferredName && editable && drafts.has(selectedName)) {
        activeTab = 'edit';
      }
      requestedTab = null;
    }
    await loadSelected();
    renderAll();
  };

  const loadSelected = async (): Promise<void> => {
    const request = ++selectedRequest;
    const name = selectedName;
    historyRequest++;
    historyLoading = false;
    selected = null;
    versions = null;
    versionsError = null;
    contentError = null;
    contentLoading = Boolean(name);
    if (!name) return;
    try {
      if (fallback) {
        const content = fallbackContents.get(selectedName) ?? `# ${docTitle(selectedName)}\n\n${t('docs.unavailable')}`;
        const entry = docs.find((doc) => doc.name === selectedName);
        selected = {
          name: selectedName,
          title: entry?.title ?? selectedName,
          content,
          updatedAt: 0,
          bundled: true,
          custom: false,
          isDefault: entry?.isDefault ?? false,
        };
      } else {
        const document = await ctx.api.doc(name);
        if (!destroyed && request === selectedRequest) selected = document;
      }
    } catch (error) {
      if (!destroyed && request === selectedRequest) contentError = error;
    } finally {
      if (request === selectedRequest) contentLoading = false;
    }
  };

  const loadHistory = async (force = false): Promise<void> => {
    if (fallback || !selectedName || historyLoading) return;
    if (versions !== null && !force) return;
    const request = ++historyRequest;
    const name = selectedName;
    historyLoading = true;
    versionsError = null;
    renderPanel();
    try {
      const response = await ctx.api.docVersions(name);
      if (!destroyed && request === historyRequest) versions = response.versions;
    } catch (error) {
      if (!destroyed && request === historyRequest) versionsError = error;
    } finally {
      if (!destroyed && request === historyRequest) {
        historyLoading = false;
        if (activeTab === 'history') {
          renderPanel();
          if (restoreConflictName === name) body.querySelector<HTMLElement>('[data-restore-conflict]')?.focus();
        }
      }
    }
  };

  const loadAndRenderSelection = async (tab: DocsTab): Promise<void> => {
    const pending = loadSelected();
    const request = selectedRequest;
    body.querySelector('.docs-head')?.replaceWith(renderDocHead());
    if (tabsHandle && tabsHandle.getActive() !== tab) tabsHandle.setActive(tab);
    else renderPanel();
    await pending;
    if (destroyed || request !== selectedRequest) return;
    body.querySelector('.docs-head')?.replaceWith(renderDocHead());
    if (activeTab === 'preview' || activeTab === 'edit') renderPanel();
  };

  const selectDoc = async (name: string): Promise<void> => {
    if (name === selectedName) return;
    const previousName = selectedName;
    if (drafts.has(previousName)) {
      const confirmed = await confirmDialog({
        title: t('docs.unsaved'),
        message: t('docs.discardOnSwitch'),
        confirmLabel: t('docs.switchDocument'),
        danger: true,
      });
      if (!confirmed || destroyed || selectedName !== previousName) return;
      updateDraft(previousName);
    }
    selectedName = name;
    for (const item of body.querySelectorAll<HTMLElement>('.docs-item[data-doc-name]')) {
      const current = item.dataset.docName === name;
      item.classList.toggle('is-active', current);
      if (current) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
    await loadAndRenderSelection(drafts.has(name) ? 'edit' : 'preview');
  };

  const saveDocument = async (doc: DocContentResponse, content: string, title: string, submittedDraft: DocumentDraft | undefined): Promise<void> => {
    if (!doc || fallback || !editable) return;
    const api = ctx.api;
    const result = await guardedSave(
      'integrations',
      { doc: { name: doc.name, content } },
      t('docs.saveAction', { title: doc.title }),
      async () => {
        if (ctx.documentDrafts !== drafts) throw new Error(t('docs.sessionChanged'));
        return api.saveDoc(doc.name, { content, title, expectedRevision: doc.revision });
      },
    );
    if (!result.allowed || !result.value) return;
    await applyPublication(result.value, submittedDraft);
  };

  const applyPublication = async (
    publication: DocContentResponse,
    submittedDraft: DocumentDraft | undefined,
    message = t(isWikiDocument(publication.name) ? 'docs.wikiPublished' : 'docs.saved'),
  ): Promise<void> => {
    const { name } = publication;
    if (restoreConflictName === name) restoreConflictName = null;
    if (drafts.get(name) === submittedDraft) updateDraft(name);
    if (destroyed || selectedName !== name) return;
    selected = publication;
    ctx.toast(message, 'success');
    await refreshList(name);
  };

  const renderDocList = (): HTMLElement => {
    const list = h('div', { class: 'docs-list' });
    const query = search.trim().toLowerCase();
    const filtered = docs.filter((doc) => !query || `${doc.title} ${doc.name}`.toLowerCase().includes(query));
    if (filtered.length === 0) {
      list.appendChild(emptyState({ title: t('docs.noMatches'), message: t('docs.changeSearch'), compact: true }));
      return list;
    }
    for (const doc of filtered) {
      const item = h('button', {
        class: `docs-item${doc.name === selectedName ? ' is-active' : ''}`,
        attrs: { type: 'button', 'aria-current': doc.name === selectedName ? 'true' : undefined },
        dataset: { docName: doc.name },
        on: { click: () => void selectDoc(doc.name) },
      });
      item.appendChild(
        h(
          'span',
          { class: 'docs-item-main' },
          h('span', { class: 'docs-item-title', text: doc.title }),
          h('span', { class: 'docs-item-name', text: doc.name }),
        ),
      );
      const meta = h(
        'span',
        { class: 'docs-item-meta' },
        documentBadge(doc),
        doc.isDefault ? badge(t('docs.default'), 'primary', { dot: true }) : null,
        doc.versions > 0 ? badge(t('docs.versions', { count: doc.versions }), 'neutral') : null,
      );
      item.appendChild(meta);
      item.appendChild(
        h('span', {
          class: 'docs-item-sub',
          text: `${formatBytes(doc.sizeBytes)} · ${doc.updatedAt ? formatDateTime(doc.updatedAt) : t('docs.bundledFile')}`,
        }),
      );
      list.appendChild(item);
    }
    return list;
  };

  const renderDocHead = (): HTMLElement => {
    const head = h('div', { class: 'docs-head' });
    if (!selected) return head;
    head.appendChild(
      h(
        'div',
        { class: 'cell-stack' },
        h('h2', { class: 'docs-title', text: selected.title }),
        h(
          'div',
          { class: 'chips' },
          documentBadge(selected),
          selected.isDefault ? badge(t('docs.defaultDocument'), 'primary', { dot: true }) : null,
          h('span', { class: 'notice', text: `${selected.name} · ${formatBytes(new TextEncoder().encode(selected.content).length)}` }),
        ),
      ),
    );
    const actions = h('div', { class: 'actions docs-actions' });
    actions.appendChild(
      button(t('docs.download'), {
        variant: 'ghost',
        size: 'sm',
        icon: 'download',
        onClick: () => downloadDoc(),
      }),
    );
    actions.appendChild(
      button(t('docs.openFile'), {
        variant: 'ghost',
        size: 'sm',
        icon: 'external',
        title: t('docs.openFileHint'),
        onClick: () => window.open(rawUrl(selected!.name), '_blank', 'noopener,noreferrer'),
      }),
    );
    if (!fallback && editable && !selected.isDefault) {
      actions.appendChild(
        button(t('docs.setDefault'), {
          variant: 'ghost',
          size: 'sm',
          icon: 'check',
          onClick: () => void makeDefault(),
        }),
      );
    }
    if (!fallback && editable && selected.custom) {
      actions.appendChild(
        button(selected.bundled ? t('docs.resetToBundled') : t('docs.deleteUploaded'), {
          variant: 'danger-ghost',
          size: 'sm',
          icon: 'refresh',
          onClick: () => void resetDoc(),
        }),
      );
    }
    head.appendChild(actions);
    return head;
  };

  const renderTabs = (): HTMLElement => {
    const items: Array<{ id: DocsTab; label: string }> = [
      { id: 'preview', label: t('docs.preview') },
      { id: 'edit', label: t('docs.edit') },
      { id: 'history', label: t('docs.history') },
      { id: 'upload', label: t('docs.upload') },
    ];
    const tabs = createTabs({
      items: items.filter((item) => item.id === 'preview' || (editable && !fallback)),
      active: activeTab,
      ariaLabel: t('docs.title'),
      onChange: (id, panel) => {
        activeTab = id as DocsTab;
        if (!panel.isConnected) return;
        renderPanel();
        if (activeTab === 'history') void loadHistory();
      },
    });
    tabs.el.querySelector('.tabs')?.classList.replace('tabs', 'docs-tabs');
    tabs.el.querySelectorAll('.tab').forEach((tab) => tab.classList.add('docs-tab'));
    tabs.panel.classList.replace('tab-panel', 'docs-panel');
    tabsHandle = tabs;
    return tabs.el;
  };

  const renderPanel = (): void => {
    const host = body.querySelector<HTMLElement>('.docs-panel');
    if (!host) return;
    host.replaceChildren();
    if (activeTab === 'preview' || activeTab === 'edit') {
      if (contentLoading) {
        host.appendChild(loadingPanel(t('docs.loadingDocument')));
        return;
      }
      if (contentError !== null) {
        host.appendChild(documentErrorState(contentError, () => void loadAndRenderSelection(activeTab)));
        return;
      }
    }
    if (activeTab === 'preview') {
      if (!selected) host.appendChild(emptyState({ title: t('docs.noSelection'), message: t('docs.selectDocument') }));
      else {
        if (fallback) {
          host.appendChild(
            alert(
              'warning',
              t('docs.editingRequiresUpgrade'),
              t('docs.bundledPreviewHint'),
            ),
          );
        }
        const wiki = isWikiDocument(selected.name);
        const draft = wiki && editable ? drafts.get(selected.name) : undefined;
        const source = draft?.content ?? selected.content;
        if (draft) {
          host.appendChild(h('p', { class: 'notice', text: t('docs.wikiDraft') }));
        }
        host.append(...documentPreview(source, wiki, selected.title));
      }
      return;
    }
    if (activeTab === 'edit') {
      if (fallback || !editable) {
        host.appendChild(
          alert(
            'warning',
            t('docs.editUnavailable'),
            fallback
              ? t('docs.editingUnsupported')
              : t('docs.savingNotAllowed'),
          ),
        );
        return;
      }
      if (!selected) return;
      const draft = drafts.get(selected.name);
      let base = draft?.base ?? selected;
      const textarea = h('textarea', { class: 'textarea docs-editor', attrs: { rows: '18', spellcheck: 'false' } });
      textarea.value = draft?.content ?? selected.content;
      const counter = h('span', { class: 'notice', text: t('docs.characters', { count: textarea.value.length }) });
      const wiki = isWikiDocument(base.name);
      const markerWarning = h('p', { class: 'notice', attrs: { id: 'wiki-marker-warning', role: 'status', 'data-wiki-marker-warning': '' } });
      const updateMarkerWarning = (): void => {
        if (!wiki) return;
        const { malformedAnchorLine } = parseWikiMarkdown(textarea.value);
        const message = malformedAnchorLine === undefined ? '' : t('docs.anchorSyntax', { line: malformedAnchorLine });
        markerWarning.hidden = !message;
        if (message) textarea.setAttribute('aria-describedby', markerWarning.id);
        else textarea.removeAttribute('aria-describedby');
        if (markerWarning.textContent !== message) markerWarning.textContent = message;
      };
      updateMarkerWarning();
      textarea.addEventListener('input', () => {
        updateDraft(base.name, textarea.value === base.content ? undefined : { base, content: textarea.value });
        counter.textContent = t('docs.characters', { count: textarea.value.length });
        updateMarkerWarning();
      });
      const saveLabel = t(wiki ? 'docs.publishWiki' : 'docs.save');
      const save = button(saveLabel, { variant: 'primary', icon: 'check' });
      const conflict = h('div', { class: 'stack', attrs: {
        role: 'region', 'aria-label': t('docs.publicationReview'), tabindex: '-1', 'data-doc-publication-review': '',
      } });
      conflict.hidden = true;
      save.addEventListener('click', () => {
        void (async () => {
          save.disabled = true;
          textarea.readOnly = true;
          let awaitingReview = false;
          conflict.replaceChildren();
          conflict.hidden = true;
          try {
            if (wiki) {
              const { invalidAnchor, missingAnchor } = parseWikiMarkdown(textarea.value);
              if (invalidAnchor) {
                conflict.append(alert('warning', t('docs.checkAnchors'), t('docs.anchorConflictHelp', { anchor: invalidAnchor })));
              } else if (missingAnchor) {
                conflict.append(alert('warning', t('docs.checkAnchors'), t('docs.anchorMissingHelp', { anchor: missingAnchor.id, line: missingAnchor.line })));
              }
              if (invalidAnchor || missingAnchor) {
                conflict.hidden = false;
                conflict.focus();
                return;
              }
            }
            await saveDocument(base, textarea.value, titleFromMarkdown(textarea.value, base.title), drafts.get(base.name));
          } catch (error) {
            if (error instanceof ApiError && error.code === 'document_conflict') {
              try {
                const current = await ctx.api.doc(base.name);
                if (!conflict.isConnected || current.name !== selectedName) return;
                const published = h('textarea', { class: 'textarea', attrs: { rows: '8', readonly: '' } });
                published.value = current.content;
                conflict.append(
                  h('p', { text: t('docs.changedWhileEditing') }),
                  field(t('docs.currentPublication'), published),
                  h('div', { class: 'actions' }, button(t('docs.useCurrentVersion'), { onClick: () => {
                    base = current;
                    updateDraft(current.name, { base: current, content: textarea.value });
                    conflict.replaceChildren(h('p', { text: t('docs.draftKept', { action: saveLabel }) }));
                    save.disabled = false;
                    textarea.focus();
                  } })),
                );
                conflict.hidden = false;
                conflict.focus();
                awaitingReview = true;
                return;
              } catch (loadError) {
                toastError(ctx, loadError);
              }
            } else {
              toastError(ctx, error);
            }
          } finally {
            textarea.readOnly = false;
            if (!awaitingReview) save.disabled = false;
          }
        })();
      });
      host.append(
        h('p', { class: 'notice', text: t('docs.markdownHint') }),
        ...(wiki ? [
          h('p', { class: 'notice', text: t('docs.wikiImageHint') }),
          h('p', { class: 'notice', text: t('docs.publishWikiHint') }),
        ] : []),
        field(t(wiki ? 'docs.wikiDraftLabel' : 'docs.content'), textarea),
        ...(wiki ? [markerWarning] : []),
        conflict,
        h(
          'div',
          { class: 'actions' },
          save,
          button(t('docs.discard'), {
            variant: 'ghost',
            onClick: () => {
              updateDraft(base.name);
              tabsHandle?.setActive('preview');
              body.querySelector<HTMLElement>('.docs-tab[data-tab="preview"]')?.focus();
            },
          }),
          button(t('docs.download'), { variant: 'ghost', icon: 'download', onClick: () => downloadDoc(textarea.value) }),
          counter,
        ),
      );
      return;
    }
    if (activeTab === 'history') {
      if (fallback) {
        host.appendChild(alert('warning', t('docs.historyUnavailable'), t('docs.upgrade')));
        return;
      }
      if (restoreConflictName === selectedName) {
        const notice = alert('warning', t('docs.restoreConflict'),
          t('docs.restoreConflictHelp'));
        notice.dataset.restoreConflict = '';
        notice.tabIndex = -1;
        host.appendChild(notice);
      }
      if (historyLoading) {
        host.appendChild(loadingPanel(t('docs.loadingHistory')));
        return;
      }
      if (versionsError !== null) {
        host.appendChild(documentErrorState(versionsError, () => void loadHistory(true)));
        return;
      }
      if (!versions) {
        host.appendChild(loadingPanel(t('docs.historyLoading')));
        return;
      }
      if (versions.length === 0) {
        host.appendChild(emptyState({ title: t('docs.noVersions'), message: t('docs.noVersionsHelp'), compact: true }));
        return;
      }
      const list = h('div', { class: 'docs-history' });
      for (const version of versions) {
        const date = formatDateTime(version.createdAt);
        const versionLabel = versionStatus(version);
        const row = h(
          'div',
          { class: 'docs-version', attrs: { 'data-version-id': version.id, role: 'group', 'aria-label': `${versionLabel} · ${date}` } },
          h(
            'div',
            { class: 'cell-stack' },
            h('strong', { text: date }),
            h('span', { class: 'cell-sub', text: version.isCurrent ? formatBytes(version.sizeBytes) : `${versionLabel} · ${formatBytes(version.sizeBytes)}` }),
          ),
          version.isCurrent ? badge(t('docs.current'), 'success') : null,
          h('div', { class: 'actions' },
            button(t('docs.viewVersion'), { variant: 'ghost', size: 'sm', icon: 'eye', onClick: () => openVersionPreview(version) }),
            !version.isCurrent
              ? button(t('docs.restore'), {
                  variant: 'ghost',
                  size: 'sm',
                  icon: 'refresh',
                  onClick: () => void restoreVersion(version),
                })
              : null,
          ),
        );
        list.appendChild(row);
      }
      host.appendChild(list);
      return;
    }
    // upload
    if (fallback || !editable) {
      host.appendChild(
        alert(
          'warning',
          t('docs.uploadUnavailable'),
          fallback
            ? t('docs.uploadUnsupported')
            : t('docs.readOnlySession'),
        ),
      );
      return;
    }
    host.appendChild(renderUploadPanel());
  };

  function openVersionPreview(version: DocVersion): void {
    const doc = selected;
    if (!doc || versionPreview) return;
    const content = h('div', { class: 'stack docs-version-preview', attrs: { tabindex: '-1' } });
    const dialog: ModalHandle = openModal({
      title: t('docs.viewVersion'),
      size: 'lg', body: [h('p', { class: 'notice', text: `${versionStatus(version)} · ${t('docs.versionDate', { date: formatDateTime(version.createdAt) })}` }), content],
      footer: [button(t('docs.close'), { variant: 'ghost', onClick: () => dialog.close() })],
      onClose: () => { versionPreview = null; },
    });
    versionPreview = dialog;
    const load = async (): Promise<void> => {
      if (content.contains(document.activeElement)) content.focus({ preventScroll: true });
      content.replaceChildren(loadingPanel(t('docs.loadingVersion')));
      try {
        const result = await ctx.api.docVersion(doc.name, version.id);
        if (!dialog.root.isConnected) return;
        if (typeof result.content !== 'string') throw new Error(t('docs.missingVersion'));
        content.replaceChildren(...documentPreview(result.content, isWikiDocument(doc.name)));
      } catch (error) {
        if (dialog.root.isConnected) {
          const failure = documentErrorState(error, () => void load());
          content.replaceChildren(failure);
          if (document.activeElement === content) failure.querySelector('button')?.focus();
        }
      }
    };
    void load();
  }

  const renderUploadPanel = (): HTMLElement => {
    const fileInput = h('input', { class: 'input', attrs: { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain' } });
    const nameInput = textInput({ placeholder: 'my-doc.md', className: 'mono' });
    const titleInput = textInput({ placeholder: t('docs.documentTitle') });
    const preview = h('span', { class: 'notice', text: t('docs.noFile') });
    let content: string | null = null;
    let fileName = '';
    let fileRequest = 0;
    let uploading = false;
    const status = h('div', { attrs: { 'aria-live': 'polite' } });
    const save = button(t('docs.saveUpload'), { variant: 'primary', icon: 'check', disabled: true });
    const drop = h(
      'label',
      { class: 'docs-drop' },
      h('span', { class: 'docs-drop-title', text: t('docs.dropFile') }),
      h('span', { class: 'notice', text: t('docs.dropHint') }),
      fileInput,
    );
    const applyFile = (file: File): void => {
      if (uploading) return;
      const request = ++fileRequest;
      content = null;
      fileName = '';
      nameInput.value = '';
      titleInput.value = '';
      preview.textContent = file.name;
      save.disabled = true;
      status.replaceChildren();
      if (file.size > MAX_UPLOAD_BYTES) {
        status.replaceChildren(alert('danger', t('docs.fileTooLarge'), t('docs.fileTooLargeHint')));
        return;
      }
      if (!/\.(md|markdown|txt)$/i.test(file.name)) {
        status.replaceChildren(alert('danger', t('docs.unsupportedFile'), t('docs.unsupportedFileHint')));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (request !== fileRequest) return;
        content = typeof reader.result === 'string' ? reader.result : '';
        if (!content) {
          status.replaceChildren(alert('danger', t('docs.emptyFile'), t('docs.emptyFileHint')));
          return;
        }
        fileName = docNameFromFile(file.name);
        nameInput.value = fileName;
        titleInput.value = titleFromMarkdown(content, file.name.replace(/\.(md|markdown|txt)$/i, ''));
        preview.textContent = `${file.name} · ${formatBytes(file.size)} · ${t('docs.characters', { count: content?.length ?? 0 })}`;
        save.disabled = false;
      };
      reader.onerror = () => {
        if (request !== fileRequest) return;
        status.replaceChildren(alert('danger', t('docs.readFailed'), t('docs.readFailedHint')));
      };
      reader.readAsText(file);
    };
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) applyFile(file);
    });
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('is-drag');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('is-drag');
      const file = event.dataTransfer?.files?.[0];
      if (file) applyFile(file);
    });
    save.addEventListener('click', () => {
      void (async () => {
        if (!content || uploading) return;
        const fileContent = content;
        const name = docNameFromFile(nameInput.value.trim() || fileName || 'document.md');
        if (!DOC_NAME_PATTERN.test(name)) {
          status.replaceChildren(alert('danger', t('docs.invalidName'), t('docs.invalidNameHint')));
          return;
        }
        const title = titleInput.value.trim();
        const api = ctx.api;
        uploading = true;
        save.disabled = true;
        fileInput.disabled = true;
        nameInput.disabled = true;
        titleInput.disabled = true;
        status.replaceChildren();
        try {
          let existing: DocContentResponse | undefined;
          try {
            existing = await api.doc(name);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
          }
          if (!save.isConnected || destroyed) return;
          if (existing) {
            const confirmed = await confirmDialog({
              title: t('docs.overwriteQuestion'),
              message: t('docs.overwriteConfirm', { name, title: existing.title }),
              confirmLabel: t('docs.overwrite'),
              danger: true,
            });
            if (!confirmed) return;
          }
          if (!save.isConnected || destroyed) return;
          const expectedRevision = existing ? existing.revision : conditionalCreate ? null : undefined;
          const result = await guardedSave(
            'integrations',
            { doc: { name, content: fileContent, title } },
            t('docs.uploadAction', { title: title || name }),
            async () => {
              if (ctx.documentDrafts !== drafts || destroyed || !save.isConnected) throw new Error(t('docs.sessionChanged'));
              const request = { content: fileContent, title: title || undefined, expectedRevision };
              return conditionalCreate ? api.uploadDoc(name, request) : api.saveDoc(name, request);
            },
          );
          if (destroyed || !save.isConnected) return;
          if (!result.allowed || !result.value) return;
          ctx.toast(t('docs.uploadComplete'), 'success');
          selectedName = result.value.name;
          activeTab = 'preview';
          await refreshList(result.value.name);
        } catch (error) {
          const conflict = error instanceof ApiError && error.code === 'document_conflict';
          status.replaceChildren(alert(
            conflict ? 'warning' : 'danger',
            t(conflict ? 'docs.uploadConflict' : 'docs.uploadFailed'),
            conflict ? t('docs.uploadConflictHint') : describeDocumentError(error).message,
          ));
        } finally {
          uploading = false;
          fileInput.disabled = false;
          nameInput.disabled = false;
          titleInput.disabled = false;
          save.disabled = false;
        }
      })();
    });
    return h(
      'div',
      { class: 'docs-upload' },
      alert('info', t('docs.customDocument'), t('docs.customHint')),
      drop,
      formGrid(field(t('docs.filename'), nameInput, { hint: t('docs.filenameHint') }), field(t('docs.nameTitle'), titleInput)),
      h('div', { class: 'actions' }, save, preview),
      status,
    );
  };

  const makeDefault = async (): Promise<void> => {
    const doc = selected;
    if (!doc || fallback) return;
    const confirmed = await confirmDialog({
      title: t('docs.setDefaultQuestion'),
      message: t('docs.makeDefaultConfirm', { title: doc.title }),
      confirmLabel: t('docs.setDefault'),
    });
    if (!confirmed) return;
    try {
      const result = await guardedSave('integrations', { docDefault: doc.name }, t('docs.defaultAction', { title: doc.title }), async () =>
        ctx.api.setDefaultDoc(doc.name),
      );
      if (!result.allowed) return;
      ctx.toast(t('docs.defaultUpdated'), 'success');
      await refreshList();
    } catch (error) {
      toastError(ctx, error);
    }
  };

  const resetDoc = async (): Promise<void> => {
    const doc = selected;
    if (!doc || fallback || !editable || resetting) return;
    const hasBundled = doc.bundled === true;
    const draft = drafts.get(doc.name);
    const api = ctx.api;
    resetting = true;
    try {
      const confirmed = await confirmDialog({
        title: t(hasBundled ? 'docs.resetQuestion' : 'docs.deleteQuestion'),
        message: [
          t(hasBundled ? 'docs.resetConfirm' : 'docs.deleteConfirm', { title: doc.title }),
          ...(draft ? [t('docs.discardOnRestore')] : []),
        ].join(' '),
        confirmLabel: t(hasBundled ? 'docs.reset' : 'docs.deleteDocument'),
        danger: true,
      });
      if (!confirmed || destroyed || selectedName !== doc.name) return;
      const result = await guardedSave(
        'integrations',
        { docDelete: doc.name },
        t(hasBundled ? 'docs.resetAction' : 'docs.deleteAction', { title: doc.title }),
        async () => {
          if (ctx.documentDrafts !== drafts) throw new Error(t('docs.sessionChanged'));
          return api.deleteDoc(doc.name, { expectedRevision: doc.revision });
        },
      );
      if (!result.allowed) return;
      if (drafts.get(doc.name) === draft) updateDraft(doc.name);
      if (destroyed || selectedName !== doc.name) return;
      ctx.toast(t(hasBundled ? 'docs.resetDone' : 'docs.deleteDone'), 'success');
      if (!hasBundled) activeTab = 'preview';
      await refreshList(hasBundled ? doc.name : undefined);
    } catch (error) {
      if (destroyed || selectedName !== doc.name) return;
      if (error instanceof ApiError && error.code === 'document_conflict') {
        activeTab = 'history';
        ctx.toast(t('docs.resetConflict'), 'error');
        await refreshList(doc.name);
        if (!destroyed && selectedName !== doc.name) tabsHandle?.setActive('preview');
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        ctx.toast(t('docs.alreadyDeleted'), 'info');
        await refreshList();
        return;
      }
      toastError(ctx, error);
    } finally {
      resetting = false;
    }
  };

  const restoreVersion = async (version: DocVersion): Promise<void> => {
    const doc = selected;
    if (!doc || restoring || fallback || !editable) return;
    const draft = drafts.get(doc.name);
    const api = ctx.api;
    restoring = true;
    try {
      const confirmed = await confirmDialog({
        title: t('docs.restoreQuestion'),
        message: [t('docs.restoreConfirm', { date: formatDateTime(version.createdAt) }), ...(draft ? [t('docs.discardOnRestore')] : [])].join(' '),
        confirmLabel: t('docs.restore'),
      });
      if (!confirmed || destroyed || selectedName !== doc.name) return;
      if (revisionRestore && doc.revision) {
        const result = await guardedSave(
          'integrations',
          { docRestore: { name: doc.name, versionId: version.id } },
          t('docs.restoreAction', { title: doc.title }),
          async () => {
            if (ctx.documentDrafts !== drafts) throw new Error(t('docs.sessionChanged'));
            return api.restoreDoc(doc.name, version.id, { expectedRevision: doc.revision });
          },
        );
        if (result.allowed && result.value) await applyPublication(result.value, draft, t('docs.versionRestored'));
        return;
      }
      const restored = await api.docVersion(doc.name, version.id);
      if (destroyed || selectedName !== doc.name) return;
      if (typeof restored.content !== 'string') throw new Error(t('docs.missingVersion'));
      await saveDocument(doc, restored.content, restored.title ?? doc.title, draft);
    } catch (error) {
      if (destroyed || selectedName !== doc.name) return;
      if (error instanceof ApiError && error.code === 'document_conflict') {
        restoreConflictName = doc.name;
        await loadSelected();
        if (!destroyed && selectedName === doc.name) renderAll();
      } else {
        toastError(ctx, error);
      }
    } finally {
      restoring = false;
    }
  };

  const downloadDoc = (content?: string): void => {
    const value = content ?? selected?.content ?? '';
    const blob = new Blob([value], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = h('a', { attrs: { href: url, download: selected?.name ?? 'document.md' } });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const renderAll = (): void => {
    if (destroyed) return;
    tabsHandle = null;
    if (fallback || !editable) activeTab = 'preview';
    root.replaceChildren(
      pageHeader({
        eyebrow: `${t('app.tenant')} · ${ctx.tenantId}`,
        title: t('docs.title'),
        subtitle: t('docs.subtitle'),
        actions: [
          refreshButton(() => void refreshList(selectedName), t('common.refresh')),
          ...(!fallback && editable ? [button(t('docs.uploadDocument'), {
            variant: 'primary',
            icon: 'plus',
            onClick: () => {
              tabsHandle?.setActive('upload');
            },
          })] : []),
        ],
      }),
      body,
    );
    const content = h('div', { class: 'stack' });
    body.replaceChildren(content);
    if (loading) {
      content.replaceChildren(loadingPanel(t('docs.loading')), skeletonTable(5, 4));
      return;
    }
    if (docsError !== null) {
      content.replaceChildren(documentErrorState(docsError, () => void refreshList()));
      return;
    }
    if (fallback) {
      content.appendChild(
        alert(
          'warning',
          t('docs.legacyServer'),
          t('docs.legacyHint'),
        ),
      );
    }
    if (!editable && !fallback) {
      content.appendChild(alert('info', t('docs.readOnly'), t('docs.readOnlyHint')));
    }
    const layout = h('div', { class: 'docs-layout' });
    const sidebar = h(
      'aside',
      { class: 'docs-sidebar' },
      h('div', { class: 'docs-sidebar-head' }, h('h2', { class: 'section-title', text: t('docs.count', { count: docs.length }) })),
      textInput({
        placeholder: t('docs.search'),
        type: 'search',
        value: search,
        onInput: (value) => {
          search = value;
          const listHost = sidebar.querySelector('.docs-list');
          if (listHost) listHost.replaceWith(renderDocList());
        },
      }),
      renderDocList(),
    );
    const main = h(
      'section',
      { class: 'docs-main' },
      renderDocHead(),
      renderTabs(),
    );
    layout.append(sidebar, main);
    content.appendChild(layout);
    renderPanel();
    if (activeTab === 'history') void loadHistory();
  };

  const renderPage = (): void => {
    renderAll();
  };

  void (async () => {
    await refreshList();
    // Keep deep links working even if the docs list is loaded after the hash was set.
    const wanted = requestedName();
    if (wanted && selectedName !== wanted) {
      const found = docs.find((doc) => doc.name === wanted);
      if (found) {
        selectedName = wanted;
        await loadSelected();
        renderAll();
      }
    }
  })();

  return {
    el: root,
    destroy: () => {
      destroyed = true;
      versionPreview?.close();
    },
  };
};

function documentPreview(source: string, wiki: boolean, title?: string): HTMLElement[] {
  const content = title === undefined ? source : withoutLeadingTitle(source, title);
  if (!wiki) return [renderMarkdown(content)];
  const { invalidAnchor, malformedAnchorLine } = parseWikiMarkdown(source);
  const rendered = invalidAnchor ? renderMarkdown(content) : renderWikiMarkdown(content, t('docs.tableRegion'));
  const headings = new Map(Array.from(rendered.querySelectorAll<HTMLElement>('h2[id], h3[id], h4[id]'), (node) => [node.id, node]));
  for (const link of rendered.querySelectorAll<HTMLAnchorElement>('a[href^="#"]:not([href^="#/"])')) {
    const anchor = decodeWikiAnchor(link.hash) ?? link.hash.slice(1);
    const heading = headings.get(anchor);
    if (!heading) {
      const status = h('span', { attrs: { role: 'status' } });
      link.after(status);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        status.textContent = ` ${t('docs.anchorMissing', { anchor })}`;
      });
      continue;
    }
    link.addEventListener('click', (event) => {
      event.preventDefault();
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'start' });
    });
  }
  const warnings = [];
  if (invalidAnchor) warnings.push(alert('warning', t('docs.checkAnchors'), t('docs.anchorConflict', { anchor: invalidAnchor })));
  if (malformedAnchorLine !== undefined) warnings.push(alert('warning', t('docs.checkAnchors'), t('docs.anchorSyntax', { line: malformedAnchorLine })));
  return [...warnings, rendered];
}
