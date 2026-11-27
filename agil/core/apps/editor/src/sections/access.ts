/**
 * Access section (contract §18): per-role feature grants, global denials and
 * per-user overrides, with a live effective-permissions preview computed by the
 * real `resolveAccess` from `@agil/protocol` (the same function the server uses).
 */
import {
  accessPolicySchema,
  featureKeys,
  resolveAccess,
  resolveKnowledgeAgentAccess,
  securitySchema,
  type FeatureKey,
  type AccessResolution,
  type KnowledgeAgentAccess,
  type Role,
} from '@agil/protocol';
import { badge, button, el, iconButton, setBadge } from '../dom';
import { card, readStringArray, renderSchema, tableField, type FieldCtx, type Sync } from '../fields';
import { localize, tr } from '../i18n';
import { FEATURE_LABELS, flagBadge } from './feature-metadata';
import type { SectionDefinition } from './types';

const ROLES: readonly Role[] = ['host', 'moderator', 'guest'];

const ROLE_LABELS: Record<Role, string> = localize({
  host: 'Организатор (host)',
  moderator: 'Модератор',
  guest: 'Гость',
});

const ROLE_PATHS: Record<Role, string> = {
  host: 'security.accessPolicy.roleDefaults.host',
  moderator: 'security.accessPolicy.roleDefaults.moderator',
  guest: 'security.accessPolicy.roleDefaults.guest',
};

const POLICY_LABELS: Record<string, string> = {
  ...FEATURE_LABELS,
  mode: 'Режим доступа',
  deniedFeatures: 'Глобально запрещённые функции (deniedFeatures)',
};

const POLICY_HINTS: Record<string, string> = {
  mode: 'В обычном режиме начальные права берутся из матрицы. В строгом режиме нужны явно выданные права из своей роли, персональной настройки или токена.',
  deniedFeatures: 'Запреты действуют для всех участников, включая тех, у кого есть своя роль, персональные права или токен.',
};

const RESERVED_ROLE_IDS = new Set(['host', 'moderator', 'guest', 'anonymous', 'system', 'admin']);
const ROLE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

const CUSTOM_ROLE_LABELS: Record<string, string> = {
  ...FEATURE_LABELS,
  id: 'Идентификатор (id)',
  name: 'Название',
  description: 'Описание',
  baseRole: 'Базовая роль',
  features: 'Функции',
  canModerate: 'Может модерировать',
  color: 'Цвет (hex-код)',
};

const ACCESS_SOURCES: Record<AccessResolution['source'], string> = {
  'role-defaults': 'Права роли по умолчанию',
  'user-override': 'Персональные права',
  token: 'Права из токена',
  strict: 'Строгий режим',
  'custom-role': 'Своя роль',
};

const KNOWLEDGE_REASONS: Record<NonNullable<KnowledgeAgentAccess['reason']>, string> = {
  disabled: 'выключен',
  role: 'роль не допущена',
  permission: 'нет разрешения',
  not_configured: 'не настроен',
};

const CUSTOM_ROLE_HINTS: Record<string, string> = {
  id: 'Латинские строчные буквы, цифры, _ и -, от 1 до 40 символов. Идентификаторы host, moderator и guest заняты встроенными ролями.',
  baseRole: 'Техническая роль для модерации и аудита. Что реально доступно участнику, задаёт список функций.',
  features: 'Итоговые права: функции роли, которые включены у организации, минус глобально запрещённые функции.',
  canModerate: 'Подсказка для интерфейса и аудита. Сервер проверяет фактические права участника.',
  color: tr('Например, #4f8cff — цвет метки роли в интерфейсе.'),
};

function readCustomRoles(ctx: FieldCtx): Array<Record<string, unknown>> {
  const value = ctx.get('security.accessPolicy.customRoles');
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
}

/** Company-defined roles table + validation (built-in roles are edited above). */
function customRolesBlock(ctx: FieldCtx, parent: HTMLElement): Sync[] {
  const rolesCard = card(tr('Свои роли (customRoles)'), {
    hint: tr('Встроенные роли host, moderator и guest удалить нельзя — их права настраиваются в матрице выше. Своя роль выдаётся через roleId в токене участника и заменяет права роли по умолчанию.'),
  });
  const warningsHost = el('div', 'provider-summary');
  const table = tableField(
    ctx,
    rolesCard.body,
    'security.accessPolicy.customRoles',
    accessPolicySchema.shape.customRoles.element,
    tr('Свои роли'),
    {
      labels: CUSTOM_ROLE_LABELS,
      hints: CUSTOM_ROLE_HINTS,
      idPrefix: 'role',
      addLabel: tr('Добавить роль'),
      emptyText: tr('Своих ролей нет — работают только встроенные роли.'),
      defaults: () => ({
        id: `role-${Math.random().toString(36).slice(2, 8)}`,
        name: tr('Новая роль'),
        description: '',
        baseRole: 'guest',
        features: [],
        canModerate: false,
        color: '#4f8cff',
      }),
    },
  );
  rolesCard.body.append(warningsHost);
  rolesCard.body.append(
    el(
      'p',
      'field-hint',
      tr('Лимит — 30 ролей. Удаление роли само по себе не отзывает выданные токены.'),
    ),
  );
  parent.append(rolesCard.root);

  const validate: Sync = () => {
    const roles = readCustomRoles(ctx);
    const warnings: string[] = [];
    const seen = new Set<string>();
    if (roles.length > 30) warnings.push(tr('Ролей {count} — больше лимита 30. Сервер отклонит сохранение.', { count: roles.length }));
    for (const [index, role] of roles.entries()) {
      const id = typeof role.id === 'string' ? role.id : '';
      const name = typeof role.name === 'string' ? role.name : '';
      const baseRole = typeof role.baseRole === 'string' ? role.baseRole : 'guest';
      const features = Array.isArray(role.features)
        ? role.features.filter((feature): feature is string => typeof feature === 'string')
        : [];
      const label = id || `#${index + 1}`;
      if (typeof role.id !== 'string' || !ROLE_ID_RE.test(role.id)) {
        warnings.push(tr('Роль {role}: идентификатор должен состоять из латинских строчных букв, цифр, _ и - (шаблон [a-z0-9][a-z0-9_-]*).', { role: label }));
      }
      if (RESERVED_ROLE_IDS.has(id)) warnings.push(tr('Роль {role}: идентификатор занят встроенной или системной ролью.', { role: label }));
      if (id && seen.has(id)) warnings.push(tr('Роль {role}: такой идентификатор уже есть.', { role: label }));
      seen.add(id);
      if (!name.trim()) warnings.push(tr('Роль {role}: пустое название.', { role: label }));
      if (features.length === 0) warnings.push(tr('Роль {role}: не выбрано ни одной функции — участник ничего не увидит.', { role: label }));
      if (baseRole === 'guest' && features.includes('recording')) {
        warnings.push(tr('Роль {role}: базовая роль guest с записью — убедитесь, что это осознанное решение и согласие участников получено.', { role: label }));
      }
    }
    warningsHost.replaceChildren(
      ...(warnings.length === 0
        ? [el('p', 'a11y-ok', tr('Свои роли заполнены корректно.'))]
        : warnings.map((warning) => el('p', 'field-error', `⚠ ${warning}`))),
    );
  };
  validate();
  return [table, validate];
}

function toggleFeature(ctx: FieldCtx, path: string, feature: FeatureKey): void {
  const current = readStringArray(ctx, path);
  const next = current.includes(feature)
    ? current.filter((value) => value !== feature)
    : [...current, feature];
  // Keep the canonical (schema declaration) order to avoid noisy diffs.
  ctx.set(
    path,
    featureKeys.filter((key) => next.includes(key)),
  );
}

/** role × feature matrix. */
function roleMatrix(ctx: FieldCtx, parent: HTMLElement): Sync[] {
  const syncs: Sync[] = [];
  const matrixCard = card(tr('Матрица «роль × функция»'), {
    hint: tr('Отмеченная функция выдаётся роли по умолчанию. Но она должна быть включена и в разделе «Функции», иначе итоговые права её отключат.'),
  });
  const enabledNote = el('p', 'field-hint');
  matrixCard.body.append(enabledNote);

  for (const role of ROLES) {
    const row = el('div', 'role-row');
    const head = el('div', 'role-head');
    head.append(el('strong', 'role-name', ROLE_LABELS[role]));
    const count = badge(tr('Отмечено: {count}', { count: 0 }), 'muted');
    head.append(count);
    const enabledCount = el('span', 'field-hint role-enabled-count');
    head.append(enabledCount);
    row.append(head);

    const chips = el('div', 'chips chips-scroll role-chips');
    const chipButtons = new Map<FeatureKey, HTMLButtonElement>();
    for (const feature of featureKeys) {
      const chip = el('button', 'chip', FEATURE_LABELS[feature]);
      chip.type = 'button';
      chip.title = `${FEATURE_LABELS[feature]} (${feature})`;
      chip.setAttribute('aria-pressed', 'false');
      const tone = flagBadge(feature);
      if (tone) chip.classList.add(`chip-${tone}`);
      chip.addEventListener('click', () => toggleFeature(ctx, ROLE_PATHS[role], feature));
      chipButtons.set(feature, chip);
      chips.append(chip);
    }
    row.append(chips);
    matrixCard.body.append(row);

    syncs.push(() => {
      const config = ctx.config();
      const granted = new Set(readStringArray(ctx, ROLE_PATHS[role]));
      const effective = resolveAccess({ config, role }).allowed.length;
      for (const [feature, chip] of chipButtons) {
        const isGranted = granted.has(feature);
        chip.setAttribute('aria-pressed', isGranted ? 'true' : 'false');
      }
      setBadge(
        count,
        tr('Отмечено: {count}', { count: granted.size }),
        effective === 0 ? 'warn' : 'muted',
        tr('Количество отметок в матрице'),
      );
      enabledCount.textContent = tr('Доступно роли: {count}', { count: effective });
    });
  }

  // How many feature flags are globally enabled (context for the matrix).
  syncs.push(() => {
    const config = ctx.config();
    const enabled = featureKeys.filter((feature) => config.features[feature]).length;
    enabledNote.textContent = tr('Включено функций: {count} из {total}.', { count: enabled, total: featureKeys.length });
  });

  parent.append(matrixCard.root);
  return syncs;
}

interface OverrideRowRefs {
  userId: string;
  input: HTMLInputElement;
  chips: Map<FeatureKey, HTMLButtonElement>;
  count: HTMLElement;
}

/** userOverrides editor: userId → explicit feature list (replaces role defaults). */
function userOverridesEditor(ctx: FieldCtx, parent: HTMLElement): Sync[] {
  const overrideCard = card(tr('Персональные права (userOverrides)'), {
    hint: tr('Список функций для пользователя (userId) заменяет права его роли целиком, а не дополняет их. Пустой список — участник не получит ничего сверх прав из токена.'),
  });
  const rows: OverrideRowRefs[] = [];
  const list = el('div', 'override-list');

  const getOverrides = (): Record<string, string[]> => {
    const value = ctx.get('security.accessPolicy.userOverrides');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const out: Record<string, string[]> = {};
    for (const [key, features] of Object.entries(value as Record<string, unknown>)) {
      out[key] = Array.isArray(features)
        ? features.filter((item): item is string => typeof item === 'string')
        : [];
    }
    return out;
  };

  const setOverrides = (next: Record<string, string[]>): void => {
    ctx.set('security.accessPolicy.userOverrides', next);
    ctx.refresh();
  };

  const entries = Object.entries(getOverrides());
  if (entries.length === 0) {
    list.append(el('p', 'field-hint', tr('Персональных прав нет — работают только роли и токены.')));
  }

  for (const [userId, features] of entries) {
    const row = el('div', 'override-row');
    row.dataset.userId = userId;
    const head = el('div', 'override-head');
    const input = el('input', 'input input-text');
    input.type = 'text';
    input.value = userId;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', tr('Идентификатор пользователя (userId) для персональных прав'));
    input.addEventListener('change', () => {
      const nextId = input.value.trim();
      if (!nextId || nextId === userId) {
        input.value = userId;
        return;
      }
      const current = getOverrides();
      if (nextId in current) {
        ctx.toast(tr('Пользователь «{user}» уже есть в списке', { user: nextId }), 'error');
        input.value = userId;
        return;
      }
      const next: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(current)) {
        next[key === userId ? nextId : key] = value;
      }
      setOverrides(next);
    });
    const count = badge('0', 'muted');
    const remove = iconButton('trash', tr('Удалить персональные права для {user}', { user: userId }), 'icon-button icon-button-danger');
    remove.addEventListener('click', () => {
      const current = getOverrides();
      delete current[userId];
      setOverrides(current);
    });
    head.append(input, count, remove);
    row.append(head);

    const chips = el('div', 'chips chips-scroll');
    const chipButtons = new Map<FeatureKey, HTMLButtonElement>();
    for (const feature of featureKeys) {
      const chip = el('button', 'chip', FEATURE_LABELS[feature]);
      chip.type = 'button';
      chip.dataset.feature = feature;
      chip.setAttribute('aria-pressed', 'false');
      const tone = flagBadge(feature);
      if (tone) chip.classList.add(`chip-${tone}`);
      chip.addEventListener('click', () => {
        const current = getOverrides();
        const listForUser = current[userId] ?? [];
        const next = listForUser.includes(feature)
          ? listForUser.filter((value) => value !== feature)
          : [...listForUser, feature];
        current[userId] = featureKeys.filter((key) => next.includes(key));
        ctx.set('security.accessPolicy.userOverrides', current);
      });
      chipButtons.set(feature, chip);
      chips.append(chip);
    }
    row.append(chips);
    list.append(row);
    rows.push({ userId, input, chips: chipButtons, count });
    void features;
  }

  const addRow = el('div', 'inline-row');
  const addInput = el('input', 'input input-text');
  addInput.type = 'text';
  addInput.placeholder = tr('Например, user-42');
  addInput.setAttribute('aria-label', tr('Идентификатор пользователя для персональных прав'));
  const add = button(tr('Добавить пользователя'), 'btn btn-small', 'plus');
  const commitAdd = (): void => {
    const userId = addInput.value.trim();
    if (!userId) {
      addInput.setAttribute('aria-invalid', 'true');
      return;
    }
    if (userId in getOverrides()) {
      ctx.toast(tr('Пользователь «{user}» уже есть в списке', { user: userId }), 'error');
      return;
    }
    addInput.setAttribute('aria-invalid', 'false');
    addInput.value = '';
    setOverrides({ ...getOverrides(), [userId]: [] });
  };
  add.addEventListener('click', commitAdd);
  addInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitAdd();
    }
  });
  addRow.append(addInput, add);
  overrideCard.body.append(list, addRow);
  parent.append(overrideCard.root);

  const syncs: Sync[] = rows.map((row) => () => {
    const current = getOverrides()[row.userId] ?? [];
    const set = new Set(current);
    for (const [feature, chip] of row.chips) {
      chip.setAttribute('aria-pressed', set.has(feature) ? 'true' : 'false');
    }
    setBadge(row.count, String(set.size), 'muted');
    if (document.activeElement !== row.input) row.input.value = row.userId;
  });
  return syncs;
}

/** Live effective permissions for every role (same logic as the server). */
function effectivePreview(ctx: FieldCtx, parent: HTMLElement): Sync[] {
  const previewCard = card(tr('Итоговые права встроенных ролей'), {
    hint: tr('Здесь показаны права организатора, модератора и гостя без персональных настроек и токена.'),
  });
  const rows = new Map<
    Role,
    { counts: HTMLElement; source: HTMLElement; knowledge: HTMLElement; allowed: HTMLElement }
  >();

  for (const role of ROLES) {
    const row = el('div', 'effective-row');
    const name = el('strong', 'effective-role', ROLE_LABELS[role]);
    const counts = el('span', 'effective-counts');
    const source = el('span', 'effective-source');
    const knowledge = el('span', 'effective-knowledge');
    const allowed = el('span', 'effective-list');
    row.append(name, counts, source, knowledge, allowed);
    previewCard.body.append(row);
    rows.set(role, { counts, source, knowledge, allowed });
  }

  parent.append(previewCard.root);

  const sync: Sync = () => {
    const config = ctx.config();
    for (const role of ROLES) {
      const refs = rows.get(role);
      if (!refs) continue;
      const resolution = resolveAccess({ config, role });
      refs.counts.textContent = tr('Разрешено: {count} из {total}', {
        count: resolution.allowed.length,
        total: resolution.allowed.length + resolution.denied.length,
      });
      refs.source.textContent = tr(ACCESS_SOURCES[resolution.source]);
      const first = resolution.allowed.slice(0, 8).map((feature) => FEATURE_LABELS[feature] ?? feature);
      refs.allowed.textContent =
        first.length > 0
          ? tr('Разрешено: {list}', { list: first.join(', ') + (resolution.allowed.length > first.length ? '…' : '') })
          : tr('Ничего не разрешено');
      const knowledge = resolveKnowledgeAgentAccess({ config, role });
      refs.knowledge.textContent = knowledge.allowed
        ? tr('Ассистент по базе знаний: доступен')
        : tr('Ассистент по базе знаний: {reason}', { reason: tr(KNOWLEDGE_REASONS[knowledge.reason ?? 'disabled']) });
      refs.knowledge.className = knowledge.allowed
        ? 'effective-knowledge is-ok'
        : 'effective-knowledge is-off';
    }
  };
  sync();
  return [sync];
}

export const accessSection: SectionDefinition = {
  id: 'access',
  title: 'Доступы',
  icon: 'key',
  description:
    'Кто что может: права роли по умолчанию, персональные права, права из токена и запреты — с живым расчётом итоговых прав.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const policyCard = card(tr('Политика доступа'), {
    hint: tr('Приоритет прав: токен, персональная настройка, своя роль, встроенная роль. Затем учитываются запреты и флаги организации.'),
    });
    const policyFields = renderSchema(securitySchema.shape.accessPolicy, 'security.accessPolicy', ctx, {
      labels: POLICY_LABELS,
      hints: POLICY_HINTS,
      skip: ['roleDefaults', 'userOverrides', 'customRoles'],
    });
    policyCard.body.append(policyFields.node);
    root.append(policyCard.root);
    syncs.push(...policyFields.syncs);

    syncs.push(...roleMatrix(ctx, root));
    syncs.push(...userOverridesEditor(ctx, root));
    syncs.push(...customRolesBlock(ctx, root));
    syncs.push(...effectivePreview(ctx, root));

    return syncs;
  },
};
