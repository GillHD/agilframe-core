/**
 * Right column: live JSON, embed snippet, "Save to tenant", import and reset.
 *
 * Load and save are explicit. Import validates with
 * `tenantConfigPatchSchema` and resolves a full config with `resolveTenantConfig`.
 */
import { resolveTenantConfig, tenantConfigPatchSchema, tenantConfigSchema, type TenantConfig } from '@agil/protocol';
import { z } from 'zod';
import {
  buildEmbedSnippet,
  loadServerSettings,
  loadTenantConfig,
  normalizeServerUrl,
  saveServerSettings,
  saveTenantConfig,
  type ConfigBase,
  type ServerSettings,
} from './api';
import {
  badge,
  button,
  confirmAction,
  copyText,
  debounce,
  downloadText,
  el,
  type ToastTone,
} from './dom';
import { MAX_CONFIG_CHARS } from './background-cache';
import { card } from './fields';
import { currentLocale, tr } from './i18n';

export interface InspectorDeps {
  getConfig(): TenantConfig;
  getBase(): ConfigBase | undefined;
  setBase(base: ConfigBase): void;
  applyImported(config: TenantConfig): void;
  resetConfig(): void;
  checkDraftFields(): string | undefined;
  notify(message: string, tone?: ToastTone): void;
  /**
   * Guard hook: called before PATCH. Returns false when the admin cancels the
   * critical-change dialog; the save is then skipped entirely.
   */
  beforeSave?(settings: ServerSettings, config: TenantConfig): Promise<boolean>;
}

export interface InspectorHandle {
  /** Called on every state change: refreshes JSON and the embed snippet. */
  sync(config: TenantConfig): void;
}

function settingField(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  const wrap = el('label', 'inspector-field');
  wrap.append(el('span', 'field-label', label));
  if (hint) wrap.append(el('p', 'field-hint', hint));
  wrap.append(input);
  return wrap;
}

function safeFilename(tenantId: string): string {
  const cleaned = tenantId.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `agil-${cleaned || 'tenant'}-config.json`;
}

export function mountInspector(root: HTMLElement, deps: InspectorDeps): InspectorHandle {
  const initialSettings = loadServerSettings(deps.getConfig().tenantId);
  const formatNumber = new Intl.NumberFormat(currentLocale());
  const issuesHost = el('div', 'import-issues');
  issuesHost.dataset.testid = 'import-issues';

  /* ---------------------------------------------------------------- */
  /* JSON                                                             */
  /* ---------------------------------------------------------------- */

  const jsonCard = card(tr('JSON конфигурации'), {
    badge: tr('только чтение'),
    hint: tr('Текущая конфигурация организации целиком. Копирование и скачивание работают без интернета.'),
  });
  const jsonArea = el('textarea', 'input json-area');
  jsonArea.dataset.testid = 'config-json';
  jsonArea.readOnly = true;
  jsonArea.spellcheck = false;
  // The config is a primary workspace: a 2-row textarea reads as a caption.
  // CSS keeps a 280px floor; rows is the no-CSS fallback for the same intent.
  jsonArea.rows = 12;
  jsonArea.setAttribute('aria-label', tr('JSON конфигурации организации'));
  const jsonMeta = el('p', 'field-hint');
  const jsonButtons = el('div', 'button-row');
  const copyJson = button(tr('Копировать JSON'), 'btn btn-small', 'copy');
  const downloadJson = button(tr('Скачать JSON'), 'btn btn-small', 'download');
  jsonButtons.append(copyJson, downloadJson);
  jsonCard.body.append(jsonArea, jsonMeta, jsonButtons);
  root.append(jsonCard.root);

  const currentJson = (): string => JSON.stringify(deps.getConfig(), null, 2);

  copyJson.addEventListener('click', async () => {
    const copied = await copyText(currentJson());
    deps.notify(copied ? tr('JSON скопирован') : tr('Не удалось скопировать JSON'), copied ? 'success' : 'error');
  });

  downloadJson.addEventListener('click', () => {
    const config = deps.getConfig();
    downloadText(safeFilename(config.tenantId), JSON.stringify(config, null, 2));
  });

  /* ---------------------------------------------------------------- */
  /* Embed snippet                                                    */
  /* ---------------------------------------------------------------- */

  const snippetCard = card(tr('Код для встраивания'), {
    hint: tr('Скрипт SDK (набор для разработчиков) и вызов mount() с текущей организацией и схемой темы.'),
  });
  const snippetArea = el('textarea', 'input json-area snippet-area');
  snippetArea.dataset.testid = 'config-snippet';
  snippetArea.readOnly = true;
  snippetArea.spellcheck = false;
  snippetArea.rows = 5;
  snippetArea.setAttribute('aria-label', tr('Код для встраивания'));
  const copySnippet = button(tr('Копировать код'), 'btn btn-small', 'copy');
  copySnippet.dataset.testid = 'copy-snippet';
  copySnippet.addEventListener('click', async () => {
    const copied = await copyText(snippetArea.value);
    deps.notify(copied ? tr('Код скопирован') : tr('Не удалось скопировать код'), copied ? 'success' : 'error');
  });
  const snippetButtons = el('div', 'button-row');
  snippetButtons.append(copySnippet);
  snippetCard.body.append(snippetArea, snippetButtons);
  root.append(snippetCard.root);

  /* ---------------------------------------------------------------- */
  /* Save to tenant                                                   */
  /* ---------------------------------------------------------------- */

  const serverInput = el('input', 'input input-text');
  serverInput.type = 'text';
  serverInput.spellcheck = false;
  serverInput.autocomplete = 'off';
  serverInput.value = initialSettings.serverUrl;
  serverInput.setAttribute('aria-label', tr('Адрес сервера'));

  const tenantInput = el('input', 'input input-text');
  tenantInput.type = 'text';
  tenantInput.spellcheck = false;
  tenantInput.autocomplete = 'off';
  tenantInput.value = initialSettings.tenantId;
  tenantInput.setAttribute('aria-label', tr('Идентификатор организации (tenantId)'));

  const keyInput = el('input', 'input input-text');
  keyInput.type = 'password';
  keyInput.spellcheck = false;
  keyInput.autocomplete = 'off';
  keyInput.value = initialSettings.apiKey;
  keyInput.setAttribute('aria-label', tr('API-ключ'));

  const saveCard = card(tr('Сохранить в организации'), {
    hint: tr('Загрузите текущие настройки в черновик перед редактированием. Для публикации укажите API-ключ этой организации.'),
  });
  saveCard.body.append(
    settingField(tr('Адрес сервера'), serverInput, tr('Для разработки: http://localhost:8787 (запросы идут через /v1).')),
    settingField(tr('Идентификатор организации (tenantId)'), tenantInput),
    settingField(tr('API-ключ'), keyInput, tr('Ключ разработчика по умолчанию: dev-key. В журналы не попадает.')),
  );
  const saveButton = button(tr('Сохранить в организации'), 'btn btn-primary', 'save');
  saveButton.dataset.testid = 'save-tenant';
  const loadButton = button(tr('Загрузить из организации'), 'btn', 'download');
  loadButton.dataset.testid = 'load-tenant';
  const saveStatus = el('div', 'save-status');
  saveStatus.dataset.testid = 'save-status';
  saveStatus.setAttribute('role', 'status');
  const tenantActions = el('div', 'button-row');
  tenantActions.append(loadButton, saveButton);
  saveCard.body.append(tenantActions, saveStatus);
  root.append(saveCard.root);

  // Sticky save dock: the right column scrolls independently, so the primary
  // action stays visible next to the export cards instead of below the fold.
  const dock = el('div', 'save-dock');
  dock.dataset.testid = 'save-dock';
  const dockCopy = el('div', 'save-dock-copy');
  const dockTarget = el('span', 'save-dock-hint');
  dockCopy.append(
    el('strong', 'save-dock-title', tr('Сохранить изменения')),
    dockTarget,
  );
  const dockButton = button(tr('Сохранить в организации'), 'btn btn-primary btn-small', 'save');
  dockButton.dataset.testid = 'save-tenant-dock';
  const dockStatus = el('div', 'save-status save-status-dock');
  dockStatus.dataset.testid = 'save-status-dock';
  dockStatus.hidden = true;
  dockStatus.setAttribute('role', 'status');
  dock.append(dockCopy, dockButton, dockStatus);
  root.prepend(dock);

  // Track the fixed dock height so the mobile layout can reserve space for it.
  const syncDockHeight = (): void => {
    const height = Math.ceil(dock.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty('--save-dock-height', `${height}px`);
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => syncDockHeight()).observe(dock);
  }
  window.addEventListener('resize', syncDockHeight);
  syncDockHeight();

  // On stacked mobile/tablet layouts the dock is fixed; hide it while the user is
  // working in the left pane/preview so it never covers the edited form.
  const paneRight = dock.closest('.pane-right');
  const syncDockVisibility = (): void => {
    if (!paneRight) return;
    const rect = paneRight.getBoundingClientRect();
    const visible = rect.top < window.innerHeight && rect.bottom > 0;
    dock.classList.toggle('is-offscreen', !visible);
  };
  if (paneRight) {
    new IntersectionObserver(() => syncDockVisibility(), { threshold: 0.01 }).observe(paneRight);
    window.addEventListener('scroll', syncDockVisibility, { passive: true });
    syncDockVisibility();
    // Keyboard focus must never land behind the fixed mobile dock: scroll the
    // focused control just above it when needed.
    document.addEventListener('focusin', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('.save-dock')) return;
      if (dock.classList.contains('is-offscreen') || getComputedStyle(dock).position !== 'fixed') return;
      window.requestAnimationFrame(() => {
        const focused = target.getBoundingClientRect();
        const dockRect = dock.getBoundingClientRect();
        if (focused.bottom > dockRect.top + 2 && focused.top < dockRect.bottom) {
          window.scrollBy(0, focused.bottom - dockRect.top + 16);
        }
      });
    });
  }

  const saveButtons: HTMLButtonElement[] = [saveButton, dockButton];
  const saveStatusNodes: HTMLElement[] = [saveStatus, dockStatus];

  const collectSettings = (): ServerSettings => ({
    serverUrl: serverInput.value.trim(),
    tenantId: tenantInput.value.trim(),
    apiKey: keyInput.value,
  });

  const sameTarget = (settings: ServerSettings): boolean => {
    const current = collectSettings();
    return current.serverUrl === settings.serverUrl && current.tenantId === settings.tenantId;
  };

  const syncTarget = (): void => {
    dockTarget.textContent = tenantInput.value.trim()
      ? tr('Организация: {tenant}', { tenant: tenantInput.value.trim() })
      : tr('Укажите организацию в настройках подключения.');
  };
  syncTarget();
  tenantInput.addEventListener('input', syncTarget);

  const setSaveStatus = (message: string, tone: 'info' | 'success' | 'error'): void => {
    for (const node of saveStatusNodes) {
      node.textContent = message;
      node.dataset.tone = tone;
      node.hidden = false;
    }
  };

  const setBusy = (busy: boolean): void => {
    for (const item of [...saveButtons, loadButton]) item.disabled = busy;
  };

  const persistSettings = debounce(() => {
    saveServerSettings(collectSettings());
    updateSnippet();
  }, 300);

  for (const input of [serverInput, tenantInput, keyInput]) {
    input.addEventListener('input', persistSettings);
  }

  loadButton.addEventListener('click', () => {
    void (async () => {
      const settings = collectSettings();
      const previous = deps.getConfig();
      const isCurrent = () => sameTarget(settings) && deps.getConfig() === previous;
      setBusy(true);
      setSaveStatus(tr('Загружаем опубликованные настройки…'), 'info');
      try {
        const { config, base } = await loadTenantConfig(settings);
        if (isCurrent() && JSON.stringify(config) !== JSON.stringify(previous)) {
          const confirmed = await confirmAction({
            title: tr('Заменить локальный черновик?'),
            message: tr('Будут загружены опубликованные настройки организации «{tenant}».', { tenant: settings.tenantId }),
            confirmLabel: tr('Загрузить'),
          });
          if (!confirmed) {
            setSaveStatus(tr('Загрузка отменена. Черновик сохранён.'), 'info');
            return;
          }
        }
        if (!isCurrent()) {
          setSaveStatus(tr('Черновик или организация изменились. Повторите загрузку.'), 'info');
          return;
        }
        saveServerSettings(settings);
        deps.setBase(base);
        deps.applyImported(config);
        setSaveStatus(tr('Загружены настройки организации «{tenant}».', { tenant: settings.tenantId }), 'success');
      } catch (error) {
        setSaveStatus(error instanceof Error ? error.message : tr('Не удалось загрузить настройки.'), 'error');
      } finally {
        setBusy(false);
      }
    })();
  });

  const performSave = async (trigger: HTMLButtonElement): Promise<void> => {
    if (trigger.disabled) return;
    const checkFields = (): boolean => {
      const issue = deps.checkDraftFields();
      if (issue === undefined) return true;
      setSaveStatus(issue, 'error');
      return false;
    };
    if (!checkFields()) return;
    const settings = collectSettings();
    if (!settings.apiKey.trim()) {
      setSaveStatus(tr('Укажите API-ключ (для разработки — dev-key).'), 'error');
      return;
    }
    saveServerSettings(settings);
    const config = deps.getConfig();
    setBusy(true);
    try {
      if (config.tenantId !== settings.tenantId && settings.tenantId) {
        const confirmed = await confirmAction({
          title: tr('Сохранить в другой организации?'),
          message: tr('Черновик «{draft}» будет опубликован в организации «{tenant}».', { draft: config.tenantId, tenant: settings.tenantId }),
          confirmLabel: tr('Продолжить'),
        });
        if (!confirmed) return;
      }
      const draftBase = deps.getBase();
      const base = draftBase && draftBase.serverUrl === normalizeServerUrl(settings.serverUrl) && draftBase.tenantId === settings.tenantId
        ? draftBase : (await loadTenantConfig(settings)).base;
      if (deps.beforeSave) {
        setSaveStatus(tr('Проверяем риски изменения…'), 'info');
        if (!(await deps.beforeSave(settings, config))) {
          setSaveStatus(tr('Сохранение отменено: изменение не подтверждено.'), 'info');
          return;
        }
      }
      if (deps.getConfig() !== config) {
        setSaveStatus(tr('Черновик изменился во время проверки. Сохраните его ещё раз.'), 'info');
        return;
      }
      if (!checkFields()) return;
      if (!sameTarget(settings) || keyInput.value !== settings.apiKey) {
        setSaveStatus(tr('Настройки подключения изменились. Повторите сохранение.'), 'info');
        return;
      }
      setSaveStatus(tr('Сохраняем…'), 'info');
      const result = await saveTenantConfig(config, settings, base.etag);
      if (result.ok) {
        if (deps.getConfig().tenantId === base.tenantId) deps.setBase({ ...base, etag: result.etag });
        const draftChanged = deps.getConfig() !== config;
        setSaveStatus(
          draftChanged
            ? tr('Версия сохранена. В черновике есть более новые изменения.')
            : tr('Настройки сохранены в организации «{tenant}».', { tenant: settings.tenantId }),
          'success',
        );
      } else {
        const code = result.code ? ` [${result.code}]` : '';
        const hint = result.hint ? ` — ${result.hint}` : '';
        setSaveStatus(`${result.message}${code}${hint}`, 'error');
      }
    } catch {
      setSaveStatus(tr('Не удалось проверить или сохранить настройки. Повторите попытку.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  for (const item of saveButtons) item.addEventListener('click', () => void performSave(item));

  /* ---------------------------------------------------------------- */
  /* Import                                                           */
  /* ---------------------------------------------------------------- */

  const importCard = card(tr('Импорт JSON'), {
    hint: tr('Импорт меняет черновик. Можно загрузить полный JSON или только нужные поля. Организацию для публикации задаёт поле «Идентификатор организации».'),
  });
  const fileInput = el('input', 'input input-file');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.setAttribute('aria-label', tr('Выбрать JSON-файл'));
  const importArea = el('textarea', 'input json-area import-area');
  importArea.dataset.testid = 'import-json';
  importArea.spellcheck = false;
  importArea.rows = 5;
  importArea.placeholder = '{\n  "theme": { "scheme": "dark" }\n}';
  importArea.setAttribute('aria-label', tr('JSON для импорта'));
  const importButton = button(tr('Импортировать'), 'btn btn-small', 'upload');
  importButton.dataset.testid = 'import-config';
  importCard.body.append(fileInput, importArea, importButton, issuesHost);
  root.append(importCard.root);

  const showProblem = (message: string): void => {
    issuesHost.replaceChildren(badge(tr('Ошибка'), 'fail'), el('p', 'issue-message', message));
  };

  const showIssues = (error: z.ZodError): void => {
    const list = el('ul', 'issues');
    for (const issue of error.issues) {
      const item = el('li', 'issue');
      item.append(
        el('code', 'issue-path', issue.path.join('.') || '(root)'),
        el('span', 'issue-message', issue.message),
      );
      list.append(item);
    }
    issuesHost.replaceChildren(badge(tr('Ошибок: {count}', { count: error.issues.length }), 'fail'), list);
  };

  let fileReadRequest = 0;
  importArea.addEventListener('input', () => {
    fileReadRequest++;
    importButton.disabled = false;
    issuesHost.replaceChildren();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    const request = ++fileReadRequest;
    importButton.disabled = true;
    issuesHost.replaceChildren();
    try {
      const text = await file.text();
      if (request === fileReadRequest) importArea.value = text;
    } catch {
      if (request === fileReadRequest) deps.notify(tr('Не удалось прочитать файл'), 'error');
    } finally {
      if (request === fileReadRequest) importButton.disabled = false;
    }
  });

  const handleImport = (): void => {
    issuesHost.replaceChildren();
    const text = importArea.value.trim();
    if (!text) {
      showProblem(tr('Вставьте JSON или выберите файл.'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      showProblem(tr('Некорректный JSON: {detail}', { detail: error instanceof Error ? error.message : tr('ошибка разбора') }));
      deps.notify(tr('Некорректный JSON'), 'error');
      return;
    }
    const result = tenantConfigPatchSchema.safeParse(parsed);
    if (!result.success) {
      showIssues(result.error);
      deps.notify(tr('JSON не соответствует схеме — проверьте поля с ошибками'), 'error');
      return;
    }
    try {
      const current = deps.getConfig();
      const tenantId = collectSettings().tenantId || current.tenantId;
      const full = tenantConfigSchema.safeParse(parsed);
      const config = full.success
        ? { ...full.data, tenantId }
        : resolveTenantConfig({ ...result.data, tenantId }, current);
      deps.applyImported(config);
      importArea.value = '';
      deps.notify(tr('Конфигурация импортирована'), 'success');
    } catch (error) {
      if (error instanceof z.ZodError) {
        showIssues(error);
        deps.notify(tr('Конфигурация не соответствует схеме'), 'error');
        return;
      }
      showProblem(tr('Не удалось применить конфигурацию: {detail}', { detail: error instanceof Error ? error.message : String(error) }));
      deps.notify(tr('Не удалось применить конфигурацию'), 'error');
    }
  };

  importButton.addEventListener('click', handleImport);

  /* ---------------------------------------------------------------- */
  /* Reset                                                            */
  /* ---------------------------------------------------------------- */

  const resetCard = card(tr('Сброс'), {
    hint: tr('Возвращает исходные настройки (defaultConfig) и перезаписывает черновик.'),
  });
  const resetButton = button(tr('Сбросить к настройкам по умолчанию'), 'btn btn-danger btn-reset', 'reset');
  resetButton.dataset.testid = 'reset-config';
  resetButton.addEventListener('click', () => {
    void (async () => {
      const confirmed = await confirmAction({
        title: tr('Сбросить настройки?'),
        message: tr('Сбросить все настройки к исходным? Черновик будет перезаписан.'),
        confirmLabel: tr('Сбросить'),
        danger: true,
      });
      if (!confirmed) return;
      deps.resetConfig();
      deps.notify(tr('Настройки сброшены к исходным'), 'success');
    })();
  });
  resetCard.body.append(resetButton);
  root.append(resetCard.root);

  /* ---------------------------------------------------------------- */
  /* Sync                                                             */
  /* ---------------------------------------------------------------- */

  const updateSnippet = (): void => {
    if (document.activeElement === snippetArea) return;
    const config = deps.getConfig();
    snippetArea.value = buildEmbedSnippet(collectSettings(), config.theme.scheme);
  };

  const sync = (config: TenantConfig): void => {
    const text = JSON.stringify(config, null, 2);
    if (document.activeElement !== jsonArea && jsonArea.value !== text) jsonArea.value = text;
    const bytes = new TextEncoder().encode(text).length;
    const over = bytes > MAX_CONFIG_CHARS;
    const size = formatNumber.format(Math.round(bytes / 1024));
    jsonMeta.textContent = tr('{chars} символов · {size} КБ из 1 МБ · версия конфигурации {version}', {
      chars: formatNumber.format(text.length),
      size,
      version: config.configVersion,
    }) + (over ? tr(' · лимит близко: уменьшите фоновое изображение или данные') : '');
    jsonMeta.classList.toggle('is-limit', over);
    jsonMeta.title = over
      ? tr('Сервер принимает конфигурацию до 1 МБ (JSON_BODY_LIMIT). Сейчас {size} КБ: сохранение может быть отклонено.', { size })
      : tr('Размер конфигурации в JSON. Сервер принимает до 1 МБ (JSON_BODY_LIMIT).');
    updateSnippet();
  };

  updateSnippet();
  return { sync };
}
