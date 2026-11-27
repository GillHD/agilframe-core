/**
 * Access: role × feature matrix, strict/role-defaults mode, global denials,
 * per-user overrides and token issuance with pinned permissions (§18).
 */
import { featureKeys, resolveAccess } from '@agil/protocol';
import type {
  AccessPolicy,
  AccessPolicyExpected,
  AccessPolicyPatch,
  AccessPolicyResponse,
  AdminRoomSummary,
  FeatureKey,
  RoleDefinition,
  RoleWriteRequest,
  TenantConfig,
  TokenResponse,
} from '@agil/protocol';
import { ApiError } from '../api.js';
import type { ScreenFactory } from '../context.js';
import { append, h, setButtonLoading } from '../dom.js';
import { describeError } from '../errors.js';
import { formatDateTime } from '../format.js';
import { t } from '../i18n.js';
import { featureLabel, groupFeatureKeys } from '../features.js';
import { icon } from '../icons.js';
import { demoJoinUrl } from '../links.js';
import { badge } from '../ui/badge.js';
import { card, kvGrid } from '../ui/card.js';
import { codeBlock } from '../ui/code-block.js';
import { button, field, formGrid, selectInput, textInput, textareaInput } from '../ui/controls.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { copyButton } from '../ui/copy-button.js';
import { emptyState } from '../ui/empty-state.js';
import { guardedSave } from '../ui/guard.js';
import { openModal, type ModalHandle } from '../ui/modal.js';
import { loadingPanel, skeletonTable } from '../ui/skeleton.js';
import { tableSearch } from '../ui/table-search.js';
import { alert, errorState, offlinePanel, pageHeader, refreshButton, toastError } from './common.js';

type Role = 'host' | 'moderator' | 'guest';

const ROLES: readonly Role[] = ['host', 'moderator', 'guest'];
const ROLE_LABELS: Record<Role, string> = {
  host: 'Организатор (host)',
  moderator: 'Модератор (moderator)',
  guest: 'Гость (guest)',
};
const HUMAN_ROLE_LABELS: Record<Role, string> = {
  host: 'Организатор',
  moderator: 'Модератор',
  guest: 'Гость',
};
const BUILTIN_ROLE_DESCRIPTIONS: Record<Role, string> = {
  host: 'Полный доступ: управление комнатой, запись, участники, модерация.',
  moderator: 'Помогает вести звонок: модерация, участники, запись — по правам матрицы.',
  guest: 'Обычный участник: может только то, что разрешено матрицей для гостя.',
};
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const TTL_OPTIONS = [
  { value: '900', label: '15 минут' },
  { value: '3600', label: '1 час' },
  { value: '86400', label: '24 часа' },
];

function sameFeatures(previous: readonly FeatureKey[] | undefined, next: readonly FeatureKey[]): boolean {
  return previous?.length === next.length && next.every((feature) => previous.includes(feature));
}

interface OverrideRow {
  userId: string;
  features: Set<FeatureKey>;
}

function featureGrid(
  keys: readonly FeatureKey[],
  selected: Set<FeatureKey>,
  onChange: (key: FeatureKey, checked: boolean) => void,
): HTMLElement {
  const grid = h('div', { class: 'checkbox-grid' });
  const groups = groupFeatureKeys(keys);
  for (const group of groups) {
    grid.appendChild(h('div', { class: 'eyebrow', attrs: { style: 'grid-column:1/-1;margin-top:6px' }, text: group.title }));
    for (const key of group.keys) {
      const input = h('input', { attrs: { type: 'checkbox', 'aria-label': featureLabel(key) } });
      input.checked = selected.has(key);
      input.addEventListener('change', () => onChange(key, input.checked));
      grid.appendChild(h('label', { class: 'checkbox-row', attrs: { style: 'padding:3px 0' } }, input, h('span', { class: 'checkbox-title', text: featureLabel(key) })));
    }
  }
  return grid;
}

export const accessScreen: ScreenFactory = (ctx) => {
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  const policyNotice = h('div', { class: 'access-policy-notice', attrs: { hidden: '' } });
  let destroyed = false;
  let config: TenantConfig | null = null;
  let access: AccessPolicyResponse | null = null;
  let policy: AccessPolicy | null = null;
  let featureList: FeatureKey[] = [];
  let rooms: AdminRoomSummary[] = [];
  let overrideRows: OverrideRow[] = [];
  let roleSets: Record<Role, Set<FeatureKey>> = { host: new Set(), moderator: new Set(), guest: new Set() };
  let deniedSet = new Set<FeatureKey>();
  let matrixHost: HTMLElement | null = null;
  let effectiveHost: HTMLElement | null = null;
  const rolesHost = h('div', { class: 'stack' });
  let tokenCardHost: HTMLElement | null = null;
  let roles: RoleDefinition[] = [];
  let rolesError: unknown = null;
  let saveButton: HTMLButtonElement;

  /* ------------------------------ token state ------------------------- */
  let tokenRoomId = '';
  let tokenName = 'Гость';
  let tokenRole: Role = 'guest';
  let tokenRoleId = '';
  let tokenUserId = '';
  let tokenTtl = 86400;
  let restrictPermissions = false;
  let tokenFeatures = new Set<FeatureKey>();
  const tokenResultHost = h('div', { class: 'stack' });

  const refresh = refreshButton(() => load());

  saveButton = button('Сохранить политику', { variant: 'primary', icon: 'check' });
  saveButton.disabled = true;

  root.appendChild(
    pageHeader({
      eyebrow: `Организация ${ctx.tenantId}`,
      title: 'Доступы',
      subtitle: 'Кто какие функции получает: права роли, строгий режим, глобальные запреты и токены с правами.',
      actions: [refresh, saveButton],
    }),
  );
  root.append(policyNotice, body);

  const computeEffective = (role: Role, userId?: string): FeatureKey[] => {
    if (!config || !policy) return access?.effective[role] ?? [];
    const draftPolicy: AccessPolicy = {
      mode: policy.mode,
      roleDefaults: {
        host: [...roleSets.host],
        moderator: [...roleSets.moderator],
        guest: [...roleSets.guest],
      },
      deniedFeatures: [...deniedSet],
      userOverrides: Object.fromEntries(
        overrideRows.filter((row) => row.userId).map((row) => [row.userId, [...row.features]]),
      ),
      customRoles: policy.customRoles,
    };
    const previewConfig: TenantConfig = {
      ...config,
      security: { ...config.security, accessPolicy: draftPolicy },
    };
    try {
      return resolveAccess({ config: previewConfig, role, userId: userId || undefined }).allowed;
    } catch {
      return access?.effective[role] ?? [];
    }
  };

  const renderEffective = (): void => {
    if (!effectiveHost) return;
    const rows = ROLES.map((role) => {
      const allowed = computeEffective(role);
      return h(
        'div',
        { class: 'excerpt' },
        h(
          'div',
          { class: 'excerpt-meta' },
          badge(ROLE_LABELS[role], role === 'host' ? 'primary' : role === 'moderator' ? 'info' : 'neutral'),
          h('span', { text: `${allowed.length} из ${featureList.length} функций` }),
        ),
        h('div', { class: 'chips' }, ...allowed.slice(0, 14).map((key) => badge(featureLabel(key), 'neutral'))),
        allowed.length > 14
          ? h('details', {}, h('summary', { class: 'cell-sub', text: `ещё ${allowed.length - 14}` }), h('div', { class: 'chips' }, ...allowed.slice(14).map((key) => badge(featureLabel(key), 'neutral'))))
          : null,
      );
    });
    effectiveHost.replaceChildren(
      card({
        title: 'Эффективные права',
        subtitle: 'права роли + персональные права + запреты − отключённые функции',
        body: h('div', { class: 'stack' }, ...rows),
      }),
    );
  };

  let filterMatrix = (): void => {};
  let renderOverrides = (): void => {};
  const matrixSearch = tableSearch(t('table.searchFeatures'), t('table.searchFeaturesHint'), () => filterMatrix());
  const overrideSearch = tableSearch(t('table.searchOverrides'), t('table.searchOverridesHint'), () => renderOverrides());
  const rolesSearch = tableSearch(t('table.searchRoles'), t('table.searchRolesHint'), () => renderRoleList());

  const renderMatrix = (): void => {
    if (!matrixHost || !policy) return;
    const strictMode = policy.mode === 'strict';
    const modeSelect = selectInput(
      [
        { value: 'role-defaults', label: 'Права роли по умолчанию (role-defaults)' },
        { value: 'strict', label: 'Строгий режим (strict) — только явно выданные права' },
      ],
      {
        value: policy.mode,
        onChange: (value) => {
          policy!.mode = value as AccessPolicy['mode'];
          renderMatrix();
          renderEffective();
          matrixHost?.querySelector('select')?.focus({ preventScroll: true });
        },
      },
    );
    matrixHost.replaceChildren();
    matrixHost.appendChild(
      formGrid(
        field('Режим политики', modeSelect, {
          hint: 'В строгом режиме права роли по умолчанию не учитываются: доступ только по правам токена или персональным правам.',
        }),
      ),
    );

    const table = h('table', { class: 'data access-matrix' });
    const thead = h('thead');
    const headRow = h('tr');
    const bulkActions: HTMLButtonElement[] = [];
    headRow.appendChild(h('th', { text: 'Функция', attrs: { scope: 'col' } }));
    for (const role of ROLES) {
      const th = h('th', { attrs: { scope: 'col', style: 'text-align:center;min-width:110px' } });
      th.appendChild(h('span', { text: ROLE_LABELS[role] }));
      th.appendChild(document.createElement('br'));
      const toggleAll = button('все', {
        variant: 'subtle', size: 'sm', disabled: strictMode,
        ariaLabel: t('table.toggleAllRoleFeatures', { role: HUMAN_ROLE_LABELS[role] }),
      });
      bulkActions.push(toggleAll);
      toggleAll.addEventListener('click', () => {
        const set = roleSets[role];
        const allChecked = featureList.every((key) => set.has(key));
        for (const key of featureList) {
          if (allChecked) set.delete(key);
          else set.add(key);
        }
        renderMatrix();
        renderEffective();
      });
      th.appendChild(toggleAll);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = h('tbody');
    const groups = groupFeatureKeys(featureList).map((group) => {
      const groupRow = h('tr', { class: 'group-row' }, h('td', { attrs: { colspan: '4' }, text: group.title }));
      tbody.appendChild(groupRow);
      const rows = group.keys.map((key) => {
        const row = h('tr');
        row.appendChild(h('td', {}, h('span', { text: featureLabel(key) }), h('span', { class: 'cell-sub', text: ` ${key}` })));
        for (const role of ROLES) {
          const td = h('td', { attrs: { style: 'text-align:center' } });
          const input = h('input', { attrs: { type: 'checkbox', 'aria-label': `${featureLabel(key)} для ${role}` } });
          input.checked = roleSets[role].has(key);
          input.disabled = strictMode;
          input.addEventListener('change', () => {
            if (input.checked) roleSets[role].add(key);
            else roleSets[role].delete(key);
            renderEffective();
          });
          td.appendChild(input);
          row.appendChild(td);
        }
        tbody.appendChild(row);
        return { key, row };
      });
      return { title: group.title, header: groupRow, rows };
    });
    table.appendChild(tbody);
    const noFeatures = emptyState({ title: t('table.noMatches'), compact: true });
    const matrix = h('div', { class: 'table-wrap' }, table);
    filterMatrix = () => {
      let count = 0;
      for (const group of groups) {
        let groupVisible = false;
        for (const { key, row } of group.rows) {
          const matches = matrixSearch.matches(key, featureLabel(key), group.title);
          row.hidden = !matches;
          if (matches) count += 1;
          groupVisible ||= matches;
        }
        group.header.hidden = !groupVisible;
      }
      for (const action of bulkActions) action.hidden = matrixSearch.active;
      matrix.hidden = count === 0;
      noFeatures.hidden = count !== 0;
      matrixSearch.setCount(count, featureList.length);
    };
    matrixHost.append(matrixSearch.el, matrix, noFeatures);
    filterMatrix();

    /* -------------------------- denied features ------------------------- */
    const deniedDetails = h('details', { attrs: { style: 'margin-top:10px' } });
    deniedDetails.appendChild(
      h('summary', { class: 'section-title', text: `Глобально запрещённые функции (${deniedSet.size})` }),
    );
    deniedDetails.appendChild(
      featureGrid(featureList, deniedSet, (key, checked) => {
        if (checked) deniedSet.add(key);
        else deniedSet.delete(key);
        renderEffective();
      }),
    );
    matrixHost.appendChild(deniedDetails);

    /* --------------------------- user overrides ------------------------- */
    const overridesHost = h('div', { class: 'stack' });
    renderOverrides = () => {
      overridesHost.replaceChildren();
      let visible = 0;
      if (overrideRows.length === 0) {
        overridesHost.appendChild(
          h('p', { class: 'notice', text: 'Персональных прав нет: участники получают права по своей роли.' }),
        );
      }
      overrideRows.forEach((row, index) => {
        if (!overrideSearch.matches(row.userId)) return;
        visible += 1;
        const userIdInput = textInput({ value: row.userId, placeholder: 'user-123', ariaLabel: t('table.searchOverridesHint') });
        userIdInput.addEventListener('input', () => {
          row.userId = userIdInput.value.trim();
        });
        const details = h('details', {});
        details.appendChild(h('summary', { class: 'cell-sub', text: `Права (${row.features.size})` }));
        details.appendChild(
          featureGrid(featureList, row.features, (key, checked) => {
            if (checked) row.features.add(key);
            else row.features.delete(key);
            renderEffective();
            const summary = details.querySelector('summary');
            if (summary) summary.textContent = `Права (${row.features.size})`;
          }),
        );
        overridesHost.appendChild(
          h(
            'div',
            { class: 'excerpt' },
            h(
              'div',
              { class: 'row' },
              h('span', { class: 'kv-label', text: 'Пользователь (userId)' }),
              h('div', { attrs: { style: 'flex:1;min-width:160px' } }, userIdInput),
              button(undefined, {
                variant: 'danger-ghost',
                size: 'sm',
                icon: 'trash',
                title: 'Удалить персональные права',
                onClick: () => {
                  overrideRows.splice(index, 1);
                  renderOverrides();
                  renderEffective();
                },
              }),
            ),
            details,
          ),
        );
      });
      overrideSearch.setCount(visible, overrideRows.length);
      if (overrideRows.length > 0 && visible === 0) {
        overridesHost.appendChild(emptyState({ title: t('table.noMatches'), compact: true }));
      }
      overridesHost.appendChild(
        button('Добавить пользователя', {
          variant: 'ghost',
          size: 'sm',
          icon: 'plus',
          onClick: () => {
            overrideSearch.reset();
            overrideRows.push({ userId: '', features: new Set() });
            renderOverrides();
            overridesHost.querySelectorAll<HTMLInputElement>('input[placeholder="user-123"]')[overrideRows.length - 1]?.focus();
          },
        }),
      );
    };
    renderOverrides();
    matrixHost.appendChild(h('div', { class: 'section-title', text: 'Персональные права пользователей' }));
    matrixHost.append(overrideSearch.el, overridesHost);
  };

  const savePolicy = (): void => {
    if (!policy || !access) return;
    const previous = access.policy;
    const mode = policy.mode;
    void (async () => {
      const entries = new Map<string, FeatureKey[]>();
      for (const row of overrideRows) {
        if (!row.userId) continue;
        if (entries.has(row.userId)) {
          ctx.toast(t('table.duplicateOverride', { id: row.userId }), 'error');
          return;
        }
        entries.set(row.userId, [...row.features]);
      }
      const overrides = Object.fromEntries(entries);
      const previousOverride = (userId: string) => Object.hasOwn(previous.userOverrides, userId)
        ? previous.userOverrides[userId] : undefined;
      const changedOverrides = Object.fromEntries(Object.entries(overrides)
        .filter(([userId, features]) => !sameFeatures(previousOverride(userId), features)));
      const clearUserOverrides = Object.keys(previous.userOverrides).filter((userId) => !Object.hasOwn(overrides, userId));
      const changedRoleDefaults: NonNullable<AccessPolicyPatch['roleDefaults']> = {};
      const previousRoleDefaults: NonNullable<AccessPolicyExpected['roleDefaults']> = {};
      for (const role of ROLES) {
        const features = [...roleSets[role]];
        if (!sameFeatures(previous.roleDefaults[role], features)) {
          changedRoleDefaults[role] = features;
          previousRoleDefaults[role] = previous.roleDefaults[role];
        }
      }
      const deniedFeatures = [...deniedSet];
      const next: AccessPolicyPatch = {
        ...(mode !== previous.mode ? { mode } : {}),
        ...(Object.keys(changedRoleDefaults).length ? { roleDefaults: changedRoleDefaults } : {}),
        ...(!sameFeatures(previous.deniedFeatures, deniedFeatures) ? { deniedFeatures } : {}),
        ...(Object.keys(changedOverrides).length ? { userOverrides: changedOverrides } : {}),
      };
      const touchedUsers = [...Object.keys(changedOverrides), ...clearUserOverrides];
      const expectedPolicy: AccessPolicyExpected = {
        ...(next.mode !== undefined ? { mode: previous.mode } : {}),
        ...(next.deniedFeatures !== undefined ? { deniedFeatures: previous.deniedFeatures } : {}),
        ...(next.roleDefaults ? { roleDefaults: previousRoleDefaults } : {}),
        ...(touchedUsers.length ? { userOverrides: Object.fromEntries(touchedUsers.map((userId) =>
          [userId, previousOverride(userId) ?? null],
        )) } : {}),
      };
      setButtonLoading(saveButton, true);
      try {
        const result = await guardedSave('access', { ...next, clearUserOverrides }, 'сохранить матрицу доступов и персональные права', async () =>
          ctx.api.updateAccessPolicy(next, clearUserOverrides, expectedPolicy),
        );
        if (!result.allowed || !result.value) return;
        policyNotice.hidden = true;
        policyNotice.replaceChildren();
        const response = result.value;
        access = response;
        policy = structuredClone(response.policy);
        roleSets = {
          host: new Set(response.policy.roleDefaults.host),
          moderator: new Set(response.policy.roleDefaults.moderator),
          guest: new Set(response.policy.roleDefaults.guest),
        };
        deniedSet = new Set(response.policy.deniedFeatures);
        overrideRows = Object.entries(response.policy.userOverrides).map(([userId, features]) => ({
          userId,
          features: new Set(features),
        }));
        ctx.toast('Политика доступа сохранена', 'success');
        renderMatrix();
        renderEffective();
        syncPolicyCustomRoles();
        void loadRoles();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'access_policy_conflict') {
          const warning = alert('warning', t('access.policyConflict'), t('access.policyConflictHint'),
            button(t('access.reloadPolicy'), { variant: 'ghost', onClick: () => void load() }));
          warning.tabIndex = -1;
          policyNotice.replaceChildren(warning);
          policyNotice.hidden = false;
          warning.focus();
        } else toastError(ctx, error);
      } finally {
        setButtonLoading(saveButton, false);
      }
    })();
  };

  saveButton.addEventListener('click', savePolicy);

  /* ------------------------------- roles ------------------------------- */

  const syncPolicyCustomRoles = (): void => {
    if (!policy) return;
    policy.customRoles = roles
      .filter((role) => !role.builtin)
      .map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description,
        baseRole: role.baseRole,
        features: role.features,
        canModerate: role.canModerate,
        color: role.color,
      }));
  };

  const focusRoleDefaults = (role: Role): void => {
    if (!matrixHost) return;
    matrixHost.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = matrixHost.querySelector<HTMLInputElement>(`input[aria-label$="для ${role}"]`);
    input?.focus();
    ctx.toast(`Права встроенной роли «${HUMAN_ROLE_LABELS[role]}» меняются в матрице ниже`, 'info');
  };

  const renderRoleRow = (role: RoleDefinition): HTMLElement => {
    const row = h('div', { class: 'excerpt' });
    const safeColor = COLOR_PATTERN.test(role.color ?? '') ? role.color : '#64748b';
    const head = h('div', { class: 'row' });
    append(
      head,
      h('span', {
        class: 'avatar',
        attrs: { style: `background:${safeColor};color:#ffffff`, 'aria-hidden': 'true' },
        text: role.name.slice(0, 2).toUpperCase(),
      }),
      h(
        'div',
        { class: 'cell-stack' },
        h('span', { class: 'section-title', text: role.name }),
        h('span', { class: 'cell-sub', text: role.id }),
      ),
      role.builtin ? badge('встроенная', 'neutral', { dot: true }) : badge('своя роль', 'primary', { dot: true }),
      badge(`Базовая роль: ${HUMAN_ROLE_LABELS[role.baseRole]}`, 'info', {
        title: 'Техническая роль для модерации, записей и аудита; функции берутся из набора роли.',
      }),
      role.canModerate ? badge('может модерировать', 'warning') : null,
      h('span', { class: 'spacer' }),
      !role.builtin ? badge(`Участников: ${role.assigned ?? 0}`, 'neutral', { title: 'Сколько участников получили эту роль' }) : null,
    );
    row.appendChild(head);
    row.appendChild(
      h('p', {
        class: 'feed-message',
        text:
          role.description ||
          (role.builtin ? BUILTIN_ROLE_DESCRIPTIONS[role.baseRole] : 'Без описания — добавьте, чтобы коллегам было понятно назначение роли.'),
      }),
    );
    row.appendChild(h('div', { class: 'section-title', text: `Функции (${role.features.length})` }));
    row.appendChild(
      h(
        'div',
        { class: 'chips' },
        ...role.features.slice(0, 10).map((key) => badge(featureLabel(key), 'neutral')),
        role.features.length > 10
          ? badge(`+${role.features.length - 10}`, 'neutral', { title: role.features.map((key) => featureLabel(key)).join(', ') })
          : null,
      ),
    );
    const actions = h('div', { class: 'actions' });
    if (role.builtin) {
      actions.appendChild(
        button('Изменить права', {
          variant: 'ghost',
          size: 'sm',
          icon: 'shield-check',
          onClick: () => focusRoleDefaults(role.baseRole),
        }),
      );
    } else {
      actions.append(
        button('Редактировать', {
          variant: 'ghost',
          size: 'sm',
          icon: 'settings',
          onClick: () => openRoleDialog(role),
        }),
        button('Удалить', {
          variant: 'danger-ghost',
          size: 'sm',
          icon: 'trash',
          onClick: () => void deleteRole(role),
        }),
      );
    }
    row.appendChild(actions);
    return row;
  };

  const roleList = h('div', { class: 'stack' });
  const renderRoleList = (): void => {
    const visible = roles.filter((role) => rolesSearch.matches(
      role.id, role.name, role.description, role.baseRole, HUMAN_ROLE_LABELS[role.baseRole],
    )).sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.name.localeCompare(b.name, 'ru');
    });
    rolesSearch.setCount(visible.length, roles.length);
    roleList.replaceChildren(...(visible.length > 0 ? visible.map(renderRoleRow) : [
      emptyState({ title: t(rolesSearch.active ? 'table.noMatches' : 'table.noRoles'), compact: true }),
    ]));
  };

  const renderRoles = (): void => {
    const restoreFocus = document.activeElement === rolesSearch.input;
    rolesHost.replaceChildren();
    if (rolesError) {
      const info = describeError(rolesError);
      rolesHost.appendChild(
        alert(
          'warning',
          'Не удалось загрузить роли',
          [info.message, info.hint].filter(Boolean).join(' '),
          button('Повторить', { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void loadRoles() }),
        ),
      );
      return;
    }
    rolesHost.appendChild(
      alert(
        'info',
        'Роль = набор функций',
        'Встроенные роли удалить нельзя — их права меняются в матрице ниже. Свои роли создаются здесь и выдаются участнику токеном (roleId).',
      ),
    );
    rolesHost.append(rolesSearch.el, roleList);
    renderRoleList();
    if (restoreFocus) rolesSearch.input.focus({ preventScroll: true });
    rolesHost.appendChild(
      h(
        'div',
        { class: 'actions' },
        button('Создать роль', { variant: 'primary', size: 'sm', icon: 'plus', onClick: () => openRoleDialog() }),
      ),
    );
  };

  const loadRoles = async (): Promise<void> => {
    try {
      roles = await ctx.api.roles();
      rolesError = null;
      syncPolicyCustomRoles();
    } catch (error) {
      rolesError = error;
      const info = describeError(error);
      if (info.offline) ctx.setServerStatus('offline');
    }
    renderRoles();
    if (tokenCardHost) tokenCardHost.replaceChildren(renderTokenCard());
  };

  const deleteRole = async (role: RoleDefinition): Promise<void> => {
    const confirmed = await confirmDialog({
      title: `Удалить роль «${role.name}»?`,
      message: `Активных назначений: ${role.assigned ?? 0}. Звонки не завершаются — у участников с этой ролью применится базовая роль «${HUMAN_ROLE_LABELS[role.baseRole]}».`,
      confirmLabel: 'Удалить роль',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await guardedSave('roles', { deleteRoleId: role.id, id: role.id }, `удалить роль «${role.name}»`, async () =>
        ctx.api.deleteRole(role.id),
      );
      if (!result.allowed || !result.value) return;
      const response = result.value;
      await loadRoles();
      ctx.toast(
        `Роль «${role.name}» удалена${typeof response.affectedParticipants === 'number' ? `, затронуто участников: ${response.affectedParticipants}` : ''}`,
        'success',
      );
    } catch (error) {
      toastError(ctx, error);
    }
  };

  const openRoleDialog = (existing?: RoleDefinition): void => {
    let handle: ModalHandle | null = null;
    const isEdit = Boolean(existing);
    const idInput = textInput({
      value: existing?.id ?? '',
      placeholder: 'streamer',
      disabled: isEdit,
      onInput: (value) => {
        idInput.value = value.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      },
    });
    const nameInput = textInput({ value: existing?.name ?? '', placeholder: 'Стример' });
    (isEdit ? nameInput : idInput).setAttribute('data-autofocus', '');
    const descriptionInput = textareaInput({
      value: existing?.description ?? '',
      rows: 2,
      placeholder: 'Например: ведёт трансляцию',
    });
    const baseRoleSelect = selectInput(
      [
        { value: 'host', label: 'Организатор (host)' },
        { value: 'moderator', label: 'Модератор (moderator)' },
        { value: 'guest', label: 'Гость (guest)' },
      ],
      { value: existing?.baseRole ?? 'guest' },
    );
    const colorInput = textInput({ value: existing?.color || '#2563eb', placeholder: '#2563eb' });
    const canModerateInput = h('input', { attrs: { type: 'checkbox' } });
    canModerateInput.checked = existing?.canModerate ?? false;
    const canModerateRow = h(
      'label',
      { class: 'checkbox-row' },
      canModerateInput,
      h(
        'span',
        { class: 'checkbox-text' },
        h('span', { class: 'checkbox-title', text: 'Роль может модерировать (canModerate)' }),
        h('span', { class: 'checkbox-desc', text: 'Дополнительно к базовой роли (baseRole); влияет на доступ к модерации в звонке.' }),
      ),
    );

    const features = new Set<FeatureKey>(existing?.features ?? []);
    const featuresSummary = h('summary', { class: 'section-title', text: `Функции (${features.size})` });
    const featureHost = h('div', { class: 'stack role-features', attrs: { style: 'margin-top:8px', tabindex: '0' } });
    featureHost.appendChild(
      featureGrid(featureList, features, (key, checked) => {
        if (checked) features.add(key);
        else features.delete(key);
        featuresSummary.textContent = `Функции (${features.size})`;
      }),
    );
    const featuresDetails = h('details', { class: 'excerpt', attrs: { open: '' } }, featuresSummary, featureHost);

    const alertBox = h('div', { attrs: { 'aria-live': 'polite' } });
    const save = button(isEdit ? 'Сохранить роль' : 'Создать роль', { variant: 'primary', icon: 'check' });

    const submit = (): void => {
      void (async () => {
        const id = idInput.value.trim();
        const name = nameInput.value.trim();
        const description = descriptionInput.value.trim();
        const color = colorInput.value.trim();
        const errors: string[] = [];
        if (!ROLE_ID_PATTERN.test(id) || id.length > 40) errors.push('id: только латиница в нижнем регистре, цифры, _ и -, начинается с буквы или цифры (до 40 символов).');
        if (!name) errors.push('Название: укажите понятное название роли.');
        if (name.length > 80) errors.push('Название: до 80 символов.');
        if (description.length > 300) errors.push('Описание: до 300 символов.');
        if (features.size === 0) errors.push('Выберите хотя бы одну функцию.');
        if (color && !COLOR_PATTERN.test(color)) errors.push('Цвет: формат #rrggbb.');
        if (errors.length > 0) {
          alertBox.replaceChildren(alert('danger', 'Проверьте роль', errors.join(' · ')));
          return;
        }
        const request: RoleWriteRequest = {
          id,
          name,
          description,
          baseRole: baseRoleSelect.value as Role,
          features: [...features],
          canModerate: canModerateInput.checked,
          color: color || '#2563eb',
        };
        setButtonLoading(save, true);
        alertBox.replaceChildren();
        try {
          const result = await guardedSave('roles', request, isEdit ? `изменить роль «${name}»` : `создать роль «${name}»`, async () => {
            if (isEdit) await ctx.api.updateRole(existing!.id, request);
            else await ctx.api.createRole(request);
          });
          if (!result.allowed) return;
          handle?.close();
          ctx.toast(isEdit ? `Роль «${name}» обновлена` : `Роль «${name}» создана`, 'success');
          await loadRoles();
        } catch (error) {
          const info = describeError(error);
          let message = [info.message, info.hint].filter(Boolean).join(' ');
          if (error instanceof ApiError) {
            if (error.status === 409 || error.code === 'conflict') {
              message = 'Роль с таким id уже существует. Выберите другой id или отредактируйте существующую роль.';
            } else if (error.status === 403 || error.code === 'forbidden') {
              message = 'Недостаточно прав: ключ должен принадлежать организации и иметь доступ к административному API.';
            } else if (error.status === 400 || error.code === 'validation_failed') {
              message = `Сервер отклонил роль: ${error.message}`;
            }
          }
          alertBox.replaceChildren(alert('danger', isEdit ? 'Не удалось сохранить роль' : 'Не удалось создать роль', message));
        } finally {
          setButtonLoading(save, false);
        }
      })();
    };
    save.addEventListener('click', submit);

    handle = openModal({
      title: isEdit ? `Редактировать роль «${existing?.name ?? ''}»` : 'Создать роль',
      size: 'lg',
      body: h(
        'div',
        { class: 'stack' },
        alert(
          'info',
          'Роль = набор функций',
          'Сотруднику выдаётся токен с roleId (в блоке «Выдать токен»). Базовая роль (baseRole) — техническая роль для модерации и аудита; итоговые права = функции роли → запреты организации → права токена.',
        ),
        formGrid(
          field('ID роли (id)', idInput, { hint: isEdit ? 'id не меняется после создания.' : 'Латиница в нижнем регистре, цифры, _ и -.' }),
          field('Название (name)', nameInput, { hint: 'Название для людей, например «Стример».' }),
          field('Базовая роль (baseRole)', baseRoleSelect, { hint: 'Техническая роль; функции задаются ниже.' }),
          field('Цвет (color)', colorInput, { hint: 'Необязательный цвет метки (#rrggbb).' }),
        ),
        field('Описание (description)', descriptionInput, { hint: 'Для кого роль и что она разрешает.' }),
        canModerateRow,
        h('p', { class: 'notice', text: `Доступны все ${featureList.length} функций: список прокручивается внутри рамки.` }),
        featuresDetails,
        alertBox,
      ),
      footer: [button('Отмена', { variant: 'ghost', onClick: () => handle?.close() }), save],
    });
  };

  /* ------------------------------ token card --------------------------- */

  const renderTokenCard = (): HTMLElement => {
    if (!rooms.some((item) => item.room.id === tokenRoomId)) tokenRoomId = rooms[0]?.room.id ?? '';
    if (!roles.some((role) => !role.builtin && role.id === tokenRoleId)) tokenRoleId = '';
    const roomOptionLabel = (room: (typeof rooms)[number]): string => {
      const name = room.room.name || room.room.id;
      const shortName = name.length > 28 ? `${name.slice(0, 27)}…` : name;
      return `${shortName} · ${room.room.id.slice(0, 6)}`;
    };
    const roomSelect = selectInput(
      rooms.length > 0
        ? rooms.map((room) => ({ value: room.room.id, label: roomOptionLabel(room) }))
        : [{ value: '', label: 'Нет комнат — создайте в разделе «Комнаты»' }],
      {
        value: tokenRoomId,
        onChange: (value) => {
          tokenRoomId = value;
          const room = rooms.find((item) => item.room.id === value);
          roomSelect.title = room ? `${room.room.name || room.room.id} · ${room.room.id}` : value;
        },
      },
    );
    if (rooms.length === 0) roomSelect.disabled = true;
    const selectedRoom = rooms.find((item) => item.room.id === tokenRoomId);
    roomSelect.title = selectedRoom ? `${selectedRoom.room.name || selectedRoom.room.id} · ${selectedRoom.room.id}` : tokenRoomId;

    const nameInput = textInput({
      value: tokenName,
      onInput: (value) => {
        tokenName = value;
      },
    });
    const roleSelect = selectInput(
      ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
      {
        value: tokenRole,
        onChange: (value) => {
          tokenRole = value as Role;
        },
      },
    );
    const userIdInput = textInput({
      value: tokenUserId,
      placeholder: 'Например, user-123',
      spellcheck: false,
      onInput: (value) => {
        tokenUserId = value.trim();
      },
    });
    userIdInput.maxLength = 64;
    const customRoleSelect = selectInput(
      [
        { value: '', label: '— без своей роли (по базовой)' },
        ...roles
          .filter((role) => !role.builtin)
          .map((role) => ({ value: role.id, label: `${role.name} · ${role.id}` })),
      ],
      {
        value: tokenRoleId,
        onChange: (value) => {
          tokenRoleId = value;
        },
      },
    );
    if (roles.filter((role) => !role.builtin).length === 0) {
      customRoleSelect.disabled = true;
      customRoleSelect.title = 'Сначала создайте свою роль в разделе «Роли»';
    }
    const ttlSelect = selectInput(TTL_OPTIONS, {
      value: String(tokenTtl),
      onChange: (value) => {
        tokenTtl = Number(value);
      },
    });

    const restrictDetails = h('details', {});
    restrictDetails.appendChild(h('summary', { class: 'section-title', text: 'Ограничить права токена' }));
    restrictDetails.appendChild(
      h('p', {
        class: 'notice',
        text: 'Права в токене заменяют права роли по умолчанию — тот, кто выдаёт токен, решает, что доступно участнику. Пусто — права по роли.',
      }),
    );
    restrictDetails.appendChild(
      featureGrid(featureList, tokenFeatures, (key, checked) => {
        if (checked) tokenFeatures.add(key);
        else tokenFeatures.delete(key);
      }),
    );

    const copyNote = h(
      'label',
      { class: 'checkbox-row' },
      (() => {
        const input = h('input', { attrs: { type: 'checkbox' } });
        input.checked = restrictPermissions;
        input.addEventListener('change', () => {
          restrictPermissions = input.checked;
          restrictDetails.open = input.checked;
        });
        return input;
      })(),
      h('span', {
        class: 'checkbox-title',
        attrs: { title: 'Зафиксировать точный список прав из матрицы' },
        text: 'Зафиксировать точный список прав из матрицы',
      }),
    );

    const issue = button('Выдать токен', { variant: 'primary', icon: 'key' });
    issue.addEventListener('click', () => {
      void (async () => {
        if (!tokenRoomId) {
          ctx.toast('Сначала создайте комнату', 'warning');
          return;
        }
        if (!tokenName.trim()) {
          ctx.toast('Укажите имя участника', 'warning');
          return;
        }
        if (tokenUserId.length > 64) {
          ctx.toast('ID участника должен быть не длиннее 64 символов', 'warning');
          userIdInput.focus();
          return;
        }
        if (restrictPermissions && tokenFeatures.size === 0) {
          ctx.toast('Выберите хотя бы одну функцию или снимите ограничение', 'warning');
          return;
        }
        setButtonLoading(issue, true);
        try {
          const participant = {
            name: tokenName.trim(),
            role: tokenRole,
            ...(tokenRoleId ? { roleId: tokenRoleId } : {}),
            ...(tokenUserId ? { participantId: tokenUserId } : {}),
          };
          const response: TokenResponse = await ctx.api.createToken({
            tenantId: ctx.tenantId,
            roomId: tokenRoomId,
            participant,
            ttlSec: tokenTtl,
            permissions: restrictPermissions ? [...tokenFeatures] : undefined,
          });
          renderTokenResult(response, participant);
          ctx.toast('Токен выдан', 'success');
        } catch (error) {
          toastError(ctx, error);
        } finally {
          setButtonLoading(issue, false);
        }
      })();
    });

    const demoLink = (response: TokenResponse): HTMLElement =>
      h(
        'a',
        {
          class: 'btn btn-ghost btn-sm',
          attrs: {
            href: demoJoinUrl(ctx.credentials.serverUrl, response.roomId, response.token, ctx.tenantId),
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        },
        icon('play', 16),
        h('span', { text: 'Открыть демо' }),
      );

    const renderTokenResult = (response: TokenResponse, participant: { name: string; role: Role; participantId?: string }): void => {
      const roleLabel = response.roleName
        ? `${response.roleName}${response.roleId ? ` (${response.roleId})` : ''}`
        : (response.roleId ?? participant.role);
      tokenResultHost.replaceChildren(
        alert(
          'warning',
          'Токен — это доступ к комнате',
          'Не публикуйте токен в открытых каналах. Срок действия ограничен; по истечении выдайте новый.',
        ),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label', text: `Токен для ${participant.name} · ${roleLabel}` }),
          codeBlock(response.token, { title: 'JWT' }),
        ),
        kvGrid([
          { label: 'Комната', value: response.roomId },
          { label: 'Роль', value: roleLabel },
          ...(participant.participantId ? [{ label: 'ID участника', value: participant.participantId }] : []),
          { label: 'Действует до', value: formatDateTime(response.expiresAt) },
          { label: 'Эффективные права', value: String(response.permissions.length) },
        ]),
        h(
          'div',
          { class: 'chips' },
          ...response.permissions.map((key) => badge(featureLabel(key), 'neutral')),
        ),
        h(
          'div',
          { class: 'actions' },
          copyButton(response.token, { label: 'Копировать токен' }),
          demoLink(response),
        ),
      );
    };

    return card({
      title: 'Выдать токен',
      subtitle: 'токен доступа для участника',
      subtitleTitle: 'POST /v1/tokens · x-api-key',
      body: h(
        'div',
        { class: 'stack' },
        rooms.length === 0
          ? alert('warning', 'Нет комнат', 'Создайте комнату, чтобы выдать токен.', h('a', { class: 'btn btn-ghost btn-sm', attrs: { href: '#/rooms' } }, 'К комнатам'))
          : null,
        formGrid(
          field('Комната', roomSelect),
          field('Имя участника', nameInput),
          field('Роль', roleSelect),
          field('Своя роль (roleId)', customRoleSelect, {
            hint: 'Своя роль из блока «Роли»: её функции станут итоговыми правами токена.',
          }),
          field('ID участника', userIdInput, { hint: 'Укажите ID для персональных прав. Для закрытой корпоративной комнаты нужен ID из её списка участников.' }),
          field('Срок действия', ttlSelect),
        ),
        copyNote,
        restrictDetails,
        h('div', { class: 'actions' }, issue),
        tokenResultHost,
      ),
    });
  };

  /* ------------------------------ page load ---------------------------- */

  let loadPromise: Promise<void> | null = null;
  const load = async (): Promise<void> => {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      body.replaceChildren(loadingPanel('Загружаем политику доступов…'), skeletonTable(4, 4));
      const [accessResult, configResult, roomsResult, rolesResult] = await Promise.allSettled([
        ctx.api.accessPolicy(),
        ctx.api.getConfig(ctx.tenantId),
        ctx.api.rooms(),
        ctx.api.roles(),
      ]);
      if (destroyed) return;
      if (accessResult.status === 'rejected') {
        const info = describeError(accessResult.reason);
        if (info.offline) ctx.setServerStatus('offline');
        const fragments: HTMLElement[] = [errorState(accessResult.reason, () => void load())];
        if (info.offline) fragments.push(offlinePanel(() => void load()));
        body.replaceChildren(...fragments);
        return;
      }
      ctx.setServerStatus('online');
      const returningFromConflict = !policyNotice.hidden;
      policyNotice.hidden = true;
      policyNotice.replaceChildren();
      access = accessResult.value;
      saveButton.disabled = false;
      config = configResult.status === 'fulfilled' ? configResult.value : null;
      rooms = roomsResult.status === 'fulfilled' ? roomsResult.value : [];
      if (rolesResult.status === 'fulfilled') {
        roles = rolesResult.value;
        rolesError = null;
      } else {
        roles = [];
        rolesError = rolesResult.reason;
      }
      featureList = access.featureKeys.length > 0 ? access.featureKeys : [...featureKeys];
      policy = structuredClone(access.policy);
      syncPolicyCustomRoles();
      roleSets = {
        host: new Set(access.policy.roleDefaults.host),
        moderator: new Set(access.policy.roleDefaults.moderator),
        guest: new Set(access.policy.roleDefaults.guest),
      };
      deniedSet = new Set(access.policy.deniedFeatures);
      overrideRows = Object.entries(access.policy.userOverrides).map(([userId, features]) => ({
        userId,
        features: new Set(features),
      }));
      tokenFeatures = new Set();
      matrixHost = h('div', { class: 'stack' });
      effectiveHost = h('div');
      tokenCardHost = h('div');
      const rolesCard = card({
        title: 'Роли',
        subtitle: 'встроенные роли и свои роли компании',
        body: rolesHost,
      });
      const left = card({
        title: 'Матрица доступа',
        subtitle: 'права роли → персональные права → права токена → запреты организации',
        subtitleTitle: 'Порядок вычисления: role features → userOverrides → token permissions → запреты (features.*)',
        body: matrixHost,
      });
      tokenCardHost.replaceChildren(renderTokenCard());
      body.replaceChildren(
        h(
          'div',
          { class: 'split' },
          h('div', { class: 'stack' }, rolesCard, left),
          h('div', { class: 'stack' }, tokenCardHost, effectiveHost),
        ),
      );
      renderMatrix();
      renderEffective();
      renderRoles();
      if (returningFromConflict) saveButton.focus({ preventScroll: true });
    })().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  };

  void load();
  return { el: root, destroy: () => { destroyed = true; } };
};
