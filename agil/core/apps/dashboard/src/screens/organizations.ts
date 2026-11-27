/**
 * SaaS organizations screen (platform key only): list, create wizard, API key
 * once, key rotation, embed copy, delete and platform-side config patch.
 *
 * Backend `/v1/admin/tenants*` may be unavailable (404) — in that case the
 * screen shows a clear fallback while the platform mode stays usable.
 */
import type { FeatureKey, TenantCreateRequest, TenantSummary } from '@agil/protocol';
import { ApiError } from '../api.js';
import type { AppContext, ScreenFactory } from '../context.js';
import { h } from '../dom.js';
import { describeError } from '../errors.js';
import { formatDateTime, formatNumber } from '../format.js';
import { icon } from '../icons.js';
import { docsRoute } from '../links.js';
import { badge } from '../ui/badge.js';
import { copyText } from '../ui/copy-button.js';
import { button, checkboxField, field, formGrid, selectInput, textInput, textareaInput } from '../ui/controls.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { emptyState } from '../ui/empty-state.js';
import { guardedSave } from '../ui/guard.js';
import { openModal } from '../ui/modal.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { alert, errorState, pageHeader, refreshButton, toastError } from './common.js';

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const PRESETS = [
  { value: 'default', label: 'Обычный старт (default)' },
  { value: 'corporate', label: 'Строгая безопасность (corporate)' },
  { value: 'minimal', label: 'Только звонки (minimal)' },
];
const SCHEMES = [
  { value: 'auto', label: 'Как в системе (auto)' },
  { value: 'light', label: 'Светлая (light)' },
  { value: 'dark', label: 'Тёмная (dark)' },
];
const PREMIUM_FEATURES: ReadonlyArray<{ id: FeatureKey; label: string; hint: string }> = [
  { id: 'recording', label: 'Запись звонков', hint: 'Разрешает функцию записи. Хранилище и права настраиваются отдельно.' },
  { id: 'fileShare', label: 'Файлы', hint: 'Обмен файлами в чате звонка' },
  { id: 'aiAssistant', label: 'ИИ-ассистент', hint: 'Ассистент во время звонка' },
  { id: 'knowledgeAgent', label: 'База знаний', hint: 'Ответы по внутренней базе знаний' },
  { id: 'meetingNotes', label: 'Заметки встречи', hint: 'Краткое содержание и решения' },
];

function embedFor(tenantId: string, serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/embed.html?tenant=${encodeURIComponent(tenantId)}&room=ROOM_ID`;
}

export const organizationsScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  let tenants: TenantSummary[] = [];
  let loading = true;
  let error: unknown = null;
  let fallback = false;
  let search = '';
  let destroyed = false;

  const renderCards = (): HTMLElement => {
    const query = search.trim().toLowerCase();
    const filtered = tenants.filter(
      (tenant) =>
        !query ||
        `${tenant.name} ${tenant.organizationName} ${tenant.tenantId} ${tenant.productName}`.toLowerCase().includes(query),
    );
    const list = h('div', { class: 'org-grid' });
    if (filtered.length === 0) {
      list.appendChild(
        emptyState({
          title: tenants.length === 0 ? 'Организаций пока нет' : 'Ничего не найдено',
          message: tenants.length === 0 ? 'Создайте первую организацию — платформа выдаст ключ один раз.' : 'Измените поиск.',
          iconName: 'globe',
          compact: true,
        }),
      );
      return list;
    }
    for (const tenant of filtered) {
      const card = h('article', { class: 'org-card' });
      const head = h(
        'div',
        { class: 'org-card-head' },
        tenant.logoUrl
          ? h('img', { class: 'org-logo', attrs: { src: tenant.logoUrl, alt: '', width: 38, height: 38, decoding: 'async' } })
          : h('span', { class: 'org-logo org-logo-fallback', text: (tenant.name || tenant.tenantId).slice(0, 2).toUpperCase() }),
        h(
          'div',
          { class: 'cell-stack' },
          h('strong', { class: 'org-name', text: tenant.name || tenant.tenantId }),
          h('span', { class: 'org-id mono', text: tenant.tenantId }),
        ),
        badge(tenant.apiKeyConfigured ? 'ключ есть' : 'ключа нет', tenant.apiKeyConfigured ? 'success' : 'warning', { dot: true }),
      );
      card.appendChild(head);
      card.appendChild(
        h(
          'div',
          { class: 'org-meta' },
          h('span', { text: tenant.organizationName || 'Организация не указана' }),
          h('span', { text: tenant.productName || 'AGIL Calls' }),
          badge(`тема: ${tenant.scheme}`, 'neutral'),
        ),
      );
      card.appendChild(
        h(
          'div',
          { class: 'org-stats' },
          h('span', { text: `Комнаты: ${formatNumber(tenant.rooms)}` }),
          h('span', { text: `Участники: ${formatNumber(tenant.participants)}` }),
          h('span', { text: `Записи: ${formatNumber(tenant.recordings)}` }),
          tenant.createdAt ? h('span', { text: `Создана ${formatDateTime(tenant.createdAt)}` }) : null,
        ),
      );
      const actions = h('div', { class: 'actions org-actions' });
      actions.append(
        button('Новый ключ', {
          variant: 'ghost',
          size: 'sm',
          icon: 'key',
          onClick: () => void rotateKey(tenant),
        }),
        button('Скопировать шаблон ссылки', {
          variant: 'ghost',
          size: 'sm',
          icon: 'copy',
          onClick: () => void copyEmbed(tenant),
        }),
        button('Открыть конфигурацию', {
          variant: 'ghost',
          size: 'sm',
          icon: 'settings',
          onClick: () => openConfigDialog(tenant),
        }),
        button('Удалить', {
          variant: 'danger-ghost',
          size: 'sm',
          icon: 'trash',
          onClick: () => void deleteTenant(tenant),
        }),
      );
      card.appendChild(actions);
      list.appendChild(card);
    }
    return list;
  };

  const showKeyOnce = (tenant: TenantSummary, apiKey: string): void => {
    const embedUrl = embedFor(tenant.tenantId, ctx.credentials.serverUrl);
    let handle: { close: () => void } | null = null;
    const copy = button('Скопировать ключ', { variant: 'primary', icon: 'copy' });
    const body = h(
      'div',
      { class: 'stack' },
      alert(
        'warning',
        'API-ключ показывается один раз',
        'Сервер хранит только хэш. Скопируйте ключ сейчас и передайте администратору организации; позже посмотреть его нельзя.',
      ),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'API-ключ организации' }), h('code', { class: 'org-key', text: apiKey })),
      h('div', { class: 'actions' }, copy, h('span', { class: 'notice', text: `tenantId: ${tenant.tenantId}` })),
      h('div', { class: 'field' },
        h('span', { class: 'field-label', text: 'Шаблон ссылки для встраивания' }),
        h('div', { class: 'link-row' }, h('code', { class: 'link-value', text: embedUrl })),
        h('span', { class: 'field-hint', text: 'Замените ROOM_ID на идентификатор комнаты этой организации. Для закрытой комнаты добавьте персональный токен входа.' }),
        h('div', { class: 'actions' }, button('Скопировать шаблон ссылки', { variant: 'ghost', size: 'sm', icon: 'copy', onClick: () => void copyEmbed(tenant) })),
      ),
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'btn btn-subtle', attrs: { href: docsRoute('saas.md') } }, icon('book', 16), h('span', { text: 'Руководство по организациям' })),
      ),
    );
    copy.addEventListener('click', () => {
      void copyText(apiKey).then((ok) => ctx.toast(ok ? 'Ключ скопирован' : 'Не удалось скопировать ключ', ok ? 'success' : 'error'));
    });
    handle = openModal({
      title: `Ключ организации ${tenant.tenantId}`,
      size: 'md',
      body,
      footer: [button('Закрыть', { variant: 'ghost', onClick: () => handle?.close() })],
      onClose: () => {
        void refresh();
      },
    });
  };

  const copyEmbed = async (tenant: TenantSummary): Promise<void> => {
    const embed = embedFor(tenant.tenantId, ctx.credentials.serverUrl);
    const ok = await copyText(embed);
    ctx.toast(ok ? 'Шаблон скопирован. Укажите идентификатор комнаты.' : 'Не удалось скопировать шаблон', ok ? 'success' : 'error');
  };

  const rotateKey = async (tenant: TenantSummary): Promise<void> => {
    const confirmed = await confirmDialog({
      title: 'Выпустить новый API-ключ?',
      message: `Старый ключ организации «${tenant.name}» перестанет работать. Новый ключ покажется один раз.`,
      confirmLabel: 'Новый ключ',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await guardedSave('integrations', { tenantId: tenant.tenantId, rotateKey: true }, `выпустить новый ключ организации «${tenant.name}»`, async () =>
        ctx.api.rotateTenantKey(tenant.tenantId),
      );
      if (!result.allowed || !result.value) return;
      showKeyOnce(tenant, result.value.apiKey);
    } catch (error) {
      toastError(ctx, error);
    }
  };

  const deleteTenant = async (tenant: TenantSummary): Promise<void> => {
    const confirmed = await confirmDialog({
      title: 'Удалить организацию?',
      message: `Комнаты организации «${tenant.name}» (${tenant.tenantId}) закроются, а ключ будет отозван. Настройки архивируются, записи и файлы сохраняются по правилам хранения.`,
      confirmLabel: 'Удалить организацию',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await guardedSave('integrations', { tenantId: tenant.tenantId, delete: true }, `удалить организацию «${tenant.name}»`, async () =>
        ctx.api.deleteTenant(tenant.tenantId),
      );
      if (!result.allowed) return;
      ctx.toast('Организация удалена', 'success');
      await refresh();
    } catch (error) {
      toastError(ctx, error);
    }
  };

  const openConfigDialog = (tenant: TenantSummary): void => {
    let handle: { close: () => void } | null = null;
    const editor = textareaInput({ rows: 12, className: 'mono' });
    const initial: Record<string, Record<string, string>> = {
      branding: { productName: tenant.productName, organizationName: tenant.organizationName, logoUrl: tenant.logoUrl },
      theme: { scheme: tenant.scheme },
    };
    editor.value = JSON.stringify(initial, null, 2);
    const status = h('div', { attrs: { 'aria-live': 'polite' } });
    const save = button('Сохранить конфигурацию', {
      variant: 'primary',
      icon: 'check',
      onClick: () => {
        void (async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(editor.value);
          } catch {
            status.replaceChildren(alert('danger', 'Некорректный JSON', 'Проверьте синтаксис конфигурации.'));
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            status.replaceChildren(alert('danger', 'Нужен объект', 'Конфигурация должна быть JSON-объектом.'));
            return;
          }
          const patch = { ...parsed } as Record<string, unknown>;
          for (const [section, previous] of Object.entries(initial)) {
            const proposed = patch[section];
            if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) continue;
            const changed = Object.entries(proposed).filter(([key, value]) => !Object.hasOwn(previous, key) || previous[key] !== value);
            if (changed.length > 0) patch[section] = Object.fromEntries(changed);
            else delete patch[section];
          }
          if (Object.keys(patch).length === 0) {
            status.replaceChildren(alert('info', 'Изменений нет', 'Измените поля оформления и повторите сохранение.'));
            return;
          }
          save.disabled = true;
          try {
            const result = await guardedSave('integrations', patch, `изменить конфигурацию организации «${tenant.name}»`, async () =>
              ctx.api.patchTenantConfig(tenant.tenantId, patch),
            );
            if (!result.allowed) return;
            ctx.toast('Конфигурация организации сохранена', 'success');
            handle?.close();
            await refresh();
          } catch (error) {
            const info = describeError(error);
            status.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
          } finally {
            save.disabled = false;
          }
        })();
      },
    });
    handle = openModal({
      title: `Конфигурация организации ${tenant.tenantId}`,
      size: 'lg',
      body: h('div', { class: 'stack' }, alert('info', 'Оформление организации', 'Здесь можно изменить поля branding и theme. Остальные настройки доступны администратору организации в визуальном редакторе.'), field('JSON оформления', editor), status),
      footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), save],
    });
  };

  const openCreateWizard = (): void => {
    let handle: { close: () => void } | null = null;
    const idInput = textInput({ placeholder: 'acme', className: 'mono' });
    const nameInput = textInput({ placeholder: 'Acme Corp' });
    const orgInput = textInput({ placeholder: 'ООО «Acme»' });
    const presetSelect = selectInput(PRESETS, { value: 'default' });
    const productInput = textInput({ placeholder: 'Использовать название организации' });
    const logoInput = textInput({ placeholder: 'https://cdn.example.com/logo.svg' });
    const primaryInput = textInput({ placeholder: '#2563eb' });
    const backgroundInput = textInput({ placeholder: 'Цвет из темы' });
    const surfaceInput = textInput({ placeholder: 'Цвет из темы' });
    const schemeSelect = selectInput(SCHEMES, { value: 'auto' });
    const featureInputs = new Map<FeatureKey, HTMLInputElement>();
    const featureHost = h('div', { class: 'checkbox-grid' });
    for (const feature of PREMIUM_FEATURES) {
      const input = h('input', { attrs: { type: 'checkbox' } });
      featureInputs.set(feature.id, input);
      featureHost.appendChild(
        h(
          'label',
          { class: 'checkbox-row' },
          input,
          h('span', { class: 'checkbox-text' }, h('span', { class: 'checkbox-title', text: feature.label }), h('span', { class: 'checkbox-desc', text: feature.hint })),
        ),
      );
    }
    const status = h('div', { attrs: { 'aria-live': 'polite' } });
    const submit = button('Создать организацию', { variant: 'primary', icon: 'plus' });
    submit.addEventListener('click', () => {
      void (async () => {
        const tenantId = idInput.value.trim().toLowerCase();
        const name = nameInput.value.trim();
        if (!TENANT_ID_PATTERN.test(tenantId)) {
          status.replaceChildren(alert('danger', 'Проверьте идентификатор организации', 'Латинские строчные буквы, цифры и дефис; начинается с буквы или цифры, от 2 до 41 символа.'));
          idInput.focus();
          return;
        }
        if (!name) {
          status.replaceChildren(alert('danger', 'Нужно название', 'Укажите название организации.'));
          nameInput.focus();
          return;
        }
        for (const value of [primaryInput.value, backgroundInput.value, surfaceInput.value]) {
          if (value.trim() && !/^#[0-9a-f]{6}$/i.test(value.trim())) {
            status.replaceChildren(alert('danger', 'Цвет в формате #rrggbb', 'Исправьте цвета бренда.'));
            return;
          }
        }
        const request: TenantCreateRequest = {
          tenantId,
          name,
          organizationName: orgInput.value.trim() || name,
          preset: presetSelect.value as 'default' | 'corporate' | 'minimal',
          branding: {
            productName: productInput.value.trim() || undefined,
            logoUrl: logoInput.value.trim() || undefined,
          },
          theme: {
            preset: presetSelect.value,
            scheme: schemeSelect.value as 'light' | 'dark' | 'auto',
            colors: {
              ...(primaryInput.value.trim() ? { primary: primaryInput.value.trim() } : {}),
              ...(backgroundInput.value.trim() ? { background: backgroundInput.value.trim() } : {}),
              ...(surfaceInput.value.trim() ? { surface: surfaceInput.value.trim() } : {}),
            },
          },
          features: Object.fromEntries(Array.from(featureInputs.entries()).filter(([, input]) => input.checked).map(([id]) => [id, true])),
        };
        submit.disabled = true;
        status.replaceChildren();
        try {
          const result = await guardedSave('integrations', request, `создать организацию «${name}»`, async () => ctx.api.createTenant(request));
          if (!result.allowed || !result.value) return;
          handle?.close();
          ctx.toast(`Организация «${name}» создана`, 'success');
          showKeyOnce(result.value.tenant, result.value.apiKey);
          await refresh();
        } catch (error) {
          const info = describeError(error);
          status.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
        } finally {
          submit.disabled = false;
        }
      })();
    });
    handle = openModal({
      title: 'Создать организацию',
      size: 'lg',
      body: h(
        'div',
        { class: 'stack' },
        alert('info', 'Создание организации', 'Идентификатор (tenantId) задаётся при создании. После сохранения панель покажет API-ключ и шаблон ссылки для встраивания.'),
        formGrid(
          field('Идентификатор организации (tenantId)', idInput, { hint: 'Например, acme. Латинские буквы, цифры и дефис; 2–41 символ.' }),
          field('Название', nameInput),
          field('Организация', orgInput),
          field('Шаблон настроек', presetSelect, { hint: 'Готовый набор: безопасность и функции как у платформы либо упрощённый старт.' }),
        ),
        h('div', { class: 'section-title', text: 'Бренд' }),
        formGrid(field('Название продукта', productInput), field('Логотип URL', logoInput)),
        formGrid(field('Основной цвет', primaryInput), field('Цвет фона', backgroundInput), field('Цвет поверхностей', surfaceInput)),
        field('Тема', schemeSelect),
        h('div', { class: 'section-title', text: 'Включить дополнительно к шаблону' }),
        featureHost,
        status,
      ),
      footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), submit],
    });
  };

  const renderPage = (): void => {
    root.replaceChildren(
      pageHeader({
        eyebrow: 'Платформа',
        title: 'Организации',
        subtitle: 'Организации платформы: ключи, брендинг, темы, расширенные функции и встраивание.',
        actions: [
          refreshButton(() => void refresh()),
          ...(ctx.platform && !loading && !fallback && error === null
            ? [button('Создать организацию', { variant: 'primary', icon: 'plus', onClick: () => openCreateWizard() })]
            : []),
        ],
      }),
      body,
    );
    if (!ctx.platform) {
      body.replaceChildren(
        emptyState({
          title: 'Доступно только платформенному ключу',
          message: 'Войдите с платформенным ключом (AGIL_PLATFORM_KEY) или включите «Платформенный ключ» на экране входа. Для ключа организации раздел скрыт.',
          iconName: 'globe',
        }),
      );
      return;
    }
    if (loading) {
      body.replaceChildren(loadingPanel('Загружаем организации…'), skeletonTable(4, 5));
      return;
    }
    if (fallback) {
      body.replaceChildren(
        alert(
          'warning',
          'API организаций появится после обновления сервера',
          'Платформенный режим включён, но сервер пока не отдаёт список организаций. Список, создание, ключи и удаление включатся после обновления сервера — менять панель не нужно.',
        ),
        h('div', { class: 'actions' }, h('a', { class: 'btn btn-subtle', attrs: { href: docsRoute('saas.md') } }, icon('book', 16), h('span', { text: 'docs/saas.md' }))),
      );
      return;
    }
    if (error !== null) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        const forbidden = error.status === 403;
        body.replaceChildren(
          emptyState({
            title: forbidden ? 'Раздел доступен только платформенному ключу' : 'Платформенный ключ не принят',
            message: forbidden
              ? 'Сервер отклонил ключ (403). Раздел «Организации» работает только с платформенным ключом AGIL_PLATFORM_KEY. Войдите с платформенным ключом или снимите галочку «Платформенный ключ» на экране входа — ключ организации этот раздел не открывает.'
              : 'Сервер не принял ключ (401). Проверьте, что в поле введён действующий платформенный ключ AGIL_PLATFORM_KEY, и повторите вход.',
            iconName: 'lock',
            action: h(
              'div',
              { class: 'actions' },
              button('Сменить ключ', { variant: 'primary', icon: 'key', onClick: () => ctx.logout() }),
              refreshButton(() => void refresh()),
            ),
          }),
        );
        return;
      }
      body.replaceChildren(errorState(error, () => void refresh()));
      return;
    }
    body.replaceChildren(
      h(
        'div',
        { class: 'filters' },
        field('Поиск', textInput({
          value: search,
          placeholder: 'Название или tenantId',
          type: 'search',
          onInput: (value) => {
            search = value;
            const host = body.querySelector('.org-grid');
            if (host) host.replaceWith(renderCards());
          },
        })),
        h('span', { class: 'spacer' }),
        h('span', { class: 'notice', text: `Всего организаций: ${tenants.length}` }),
        h('a', { class: 'btn btn-subtle btn-sm', attrs: { href: docsRoute('saas.md') } }, icon('book', 16), h('span', { text: 'docs/saas.md' })),
      ),
      renderCards(),
    );
  };

  const refresh = async (): Promise<void> => {
    loading = true;
    error = null;
    fallback = false;
    renderPage();
    try {
      const response = await ctx.api.tenants();
      tenants = response.tenants;
      if (!response.platform) {
        ctx.setPlatformMode(false);
        renderPage();
        return;
      }
      ctx.setPlatformMode(true);
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err.status === 404 || err.status === 405 || err.status === 501)) {
        fallback = true;
      } else {
        error = err;
      }
    } finally {
      loading = false;
      if (!destroyed) renderPage();
    }
  };

  void refresh();
  return {
    el: root,
    destroy: () => {
      destroyed = true;
    },
  };
};
