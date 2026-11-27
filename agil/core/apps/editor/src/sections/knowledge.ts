/**
 * Knowledge-agent section (contract §18): corporate wiki/RAG assistant settings
 * plus a live access preview (role check → feature permission → endpoint).
 */
import { resolveKnowledgeAgentAccess, sessionSchema, type Role } from '@agil/protocol';
import { el } from '../dom';
import { card, renderSchema, type FieldCtx, type Sync } from '../fields';
import { tr } from '../i18n';
import type { SectionDefinition } from './types';

const ROLES: readonly Role[] = ['host', 'moderator', 'guest'];
const ROLE_LABELS: Record<Role, string> = {
  host: 'Организатор (host)',
  moderator: 'Модератор',
  guest: 'Гость',
};

const REASON_LABELS = {
  disabled: 'ассистент выключен (enabled=false)',
  role: 'роли нет в списке разрешённых',
  permission: 'нет права knowledgeAgent или функция выключена',
  not_configured: 'не задан адрес сервиса',
};

const KNOWLEDGE_LABELS: Record<string, string> = {
  enabled: 'Включить ассистента по базе знаний',
  endpoint: 'Адрес сервиса компании (RAG/wiki)',
  apiKeyEnv: 'Переменная окружения с ключом',
  timeoutMs: 'Тайм-аут ожидания, мс',
  allowedRoles: 'Роли с доступом',
  requirePermission: 'Требовать право knowledgeAgent',
  citations: 'Показывать цитаты',
  maxAnswerChars: 'Максимум символов ответа',
  systemPrompt: 'Системная инструкция (system prompt)',
  denyMessage: 'Сообщение при отказе',
};

const KNOWLEDGE_HINTS: Record<string, string> = {
  endpoint: 'Адрес сервиса компании (только https): сервер передаёт вопрос и проверяет ответ по схеме. Содержимое базы знаний у нас не хранится.',
  apiKeyEnv: 'Только имя переменной окружения — ключ никогда не хранится в конфигурации.',
  timeoutMs: 'От 500 до 30 000 мс. При ошибке или тайм-ауте сервер вернёт отказ, звонок продолжит работать.',
  allowedRoles: 'Проверяется до права knowledgeAgent. Пустой список — никто не может спрашивать.',
  requirePermission: 'Дополнительно требует включённой функции knowledgeAgent в итоговых правах (см. раздел «Доступы»).',
  citations: 'Цитаты приходят как внешние ссылки, которым нельзя доверять. Интерфейс открывает их безопасно (rel="noopener noreferrer").',
  maxAnswerChars: 'От 100 до 20 000 символов: более длинный ответ сервер обрезает.',
  systemPrompt: 'Дополнительная инструкция для RAG-агента компании (не секрет).',
  denyMessage: 'Показывается участнику, когда доступ запрещён (answer с error=forbidden).',
};

/** Shows, per role, why the knowledge agent is (not) available. */
function accessPreview(ctx: FieldCtx, parent: HTMLElement): Sync[] {
  const previewCard = card('Кто может спросить ассистента', {
    hint: 'Предпросмотр учитывает настройки сервиса, роли и права. Наличие ключа проверяется на сервере.',
  });
  const rows = new Map<Role, { status: HTMLElement; detail: HTMLElement }>();

  for (const role of ROLES) {
    const row = el('div', 'effective-row');
    const name = el('strong', 'effective-role', tr(ROLE_LABELS[role]));
    const status = el('span', 'effective-knowledge');
    const detail = el('span', 'effective-list');
    row.append(name, status, detail);
    previewCard.body.append(row);
    rows.set(role, { status, detail });
  }
  parent.append(previewCard.root);

  const sync: Sync = () => {
    const config = ctx.config();
    const agent = config.session.knowledgeAgent;
    for (const role of ROLES) {
      const refs = rows.get(role);
      if (!refs) continue;
      const access = agent.enabled && !agent.endpoint.trim()
        ? { allowed: false, reason: 'not_configured' as const }
        : resolveKnowledgeAgentAccess({ config, role });
      refs.status.textContent = access.allowed ? tr('доступен') : tr('нет: {reason}', {
        reason: tr(REASON_LABELS[access.reason ?? 'disabled']),
      });
      refs.status.className = access.allowed ? 'effective-knowledge is-ok' : 'effective-knowledge is-off';
      if (access.allowed) {
        refs.detail.textContent = agent.citations ? tr('Может задавать вопросы и получать цитаты.') : tr('Может задавать вопросы. Цитаты скрыты.');
      } else if (access.reason === 'disabled' || access.reason === 'not_configured') {
        refs.detail.textContent = tr('Запросы к сервису недоступны.');
      } else {
        refs.detail.textContent = access.denyMessage
          ? tr('Участник увидит: «{message}»', { message: access.denyMessage })
          : tr('Участник получит ответ с ошибкой доступа (error=forbidden).');
      }
    }
  };
  sync();
  return [sync];
}

export const knowledgeSection: SectionDefinition = {
  id: 'knowledge',
  title: 'База знаний',
  icon: 'book',
  description:
    'Ассистент по внутренней базе знаний компании: адрес сервиса, роли, права, цитаты и отказ. Содержимое базы знаний не храним.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const settingsCard = card('Корпоративный ассистент по базе знаний (wiki / RAG)', {
      hint: 'Сервер проверяет формат ответа и подписывает запросы HMAC, если на сервере задан секрет.',
    });
    const fields = renderSchema(sessionSchema.shape.knowledgeAgent, 'session.knowledgeAgent', ctx, {
      labels: { ...KNOWLEDGE_LABELS, ...ROLE_LABELS },
      hints: KNOWLEDGE_HINTS,
      multiline: ['systemPrompt', 'denyMessage'],
    });
    settingsCard.body.append(fields.node);
    root.append(settingsCard.root);
    syncs.push(...fields.syncs);

    syncs.push(...accessPreview(ctx, root));

    return syncs;
  },
};
