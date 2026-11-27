/** Audit event rendering shared by the Security feed and the Audit table. */
import { auditEventTypes, nodeFeaturesSchema, nodeModuleActionSchema, nodeModuleKindSchema, type AuditEntry, type AuditEventType } from '@agil/protocol';
import { h } from '../dom.js';
import { countryLabel, formatDateTime } from '../format.js';
import { currentLocale, t } from '../i18n.js';
import { icon } from '../icons.js';
import { severityBadge } from './badge.js';

/** Types that matter most for the security screen ("только безопасность"). */
export const SECURITY_AUDIT_TYPES: readonly AuditEventType[] = [
  'geo.blocked',
  'password.failed',
  'lockout',
  'knowledge.query',
  'knowledge.denied',
  'webhook.failed',
  'integrity.flagged',
  'join.denied',
  'public_abuse.threshold',
];

export const OTHER_AUDIT_TYPES = auditEventTypes.filter((type) => !SECURITY_AUDIT_TYPES.includes(type));

const AUDIT_TYPE_LABELS: Record<AuditEventType, readonly [ru: string, en: string]> = {
  'room.created': ['Создание комнаты', 'Room created'],
  'room.closed': ['Закрытие комнаты', 'Room closed'],
  'room.locked': ['Блокировка комнаты', 'Room locked'],
  'join.allowed': ['Вход разрешён', 'Join allowed'],
  'join.denied': ['Вход отклонён', 'Join denied'],
  'public_abuse.threshold': ['Превышен лимит публичного доступа', 'Public access threshold reached'],
  'password.failed': ['Неверный пароль', 'Incorrect password'],
  'geo.blocked': ['Гео-блокировка', 'Blocked by location'],
  'lockout': ['Блокировка после неудачных попыток', 'Locked after failed attempts'],
  'config.updated': ['Настройки обновлены', 'Settings updated'],
  'recording.started': ['Запись начата', 'Recording started'],
  'recording.saved': ['Запись сохранена', 'Recording saved'],
  'file.shared': ['Файл передан', 'File shared'],
  'file.scanned': ['Файл проверен антивирусом', 'File scanned'],
  'file.quarantined': ['Файл помещён в карантин', 'File quarantined'],
  'file.quarantine_failed': ['Не удалось изолировать заражённый файл', 'File quarantine failed'],
  'file.scan_unavailable': ['Антивирусная проверка недоступна', 'File scanning unavailable'],
  'liveness.challenge': ['Запрошена проверка присутствия', 'Liveness challenge issued'],
  'liveness.verified': ['Присутствие подтверждено', 'Liveness verified'],
  'liveness.failed': ['Проверка присутствия не пройдена', 'Liveness check failed'],
  'liveness.unavailable': ['Проверка присутствия недоступна', 'Liveness check unavailable'],
  'chat.sent': ['Сообщение в чате', 'Chat message sent'],
  'call.ended': ['Звонок завершён', 'Call ended'],
  'integrity.flagged': ['Подозрение на подмену медиа', 'Suspected media tampering'],
  'session.bound': ['Событие сессии', 'Session event'],
  'knowledge.query': ['Запрос к базе знаний', 'Knowledge base query'],
  'knowledge.denied': ['Отказ ассистента', 'Knowledge access denied'],
  'access.updated': ['Доступы обновлены', 'Access updated'],
  'webhook.delivered': ['Вебхук доставлен', 'Webhook delivered'],
  'webhook.failed': ['Ошибка вебхука', 'Webhook delivery failed'],
  'admin.action': ['Действие администратора', 'Administrator action'],
  'lobby.pending': ['Заявка в зале ожидания', 'Waiting room request'],
  'lobby.admitted': ['Заявка допущена', 'Waiting room request approved'],
  'lobby.rejected': ['Заявка отклонена', 'Waiting room request declined'],
  'lobby.expired': ['Заявка истекла', 'Waiting room request expired'],
  'domain.updated': ['Домен обновлён', 'Domain updated'],
  'domain.verified': ['Домен подтверждён', 'Domain verified'],
  'domain.verify_failed': ['Домен не подтверждён', 'Domain verification failed'],
  'route.created': ['Маршрут создан', 'Route created'],
  'route.updated': ['Маршрут обновлён', 'Route updated'],
  'route.deleted': ['Маршрут удалён', 'Route deleted'],
  'route.tested': ['Маршрут проверен', 'Route tested'],
  'route.matched': ['Маршрут выбран', 'Route matched'],
  'route.egress.started': ['Выгрузка по маршруту началась', 'Route egress started'],
  'route.egress.failed': ['Ошибка выгрузки по маршруту', 'Route egress failed'],
  'route.edge_token_issued': ['Токен Edge выдан', 'Edge token issued'],
  'route.edge_token_revoked': ['Токен Edge отозван', 'Edge token revoked'],
  'edge.joined': ['Edge подключился', 'Edge connected'],
  'flow.created': ['Пайплайн создан', 'Flow created'],
  'flow.updated': ['Пайплайн обновлён', 'Flow updated'],
  'flow.deleted': ['Пайплайн удалён', 'Flow deleted'],
  'flow.tested': ['Пайплайн проверен', 'Flow tested'],
  'flow.matched': ['Пайплайн выбран', 'Flow matched'],
  'flow.started': ['Пайплайн запущен', 'Flow started'],
  'flow.pending': ['Пайплайн ожидает запуска', 'Flow waiting'],
  'flow.failed': ['Ошибка пайплайна', 'Flow failed'],
  'flow.schedule.tick': ['Сработало расписание пайплайна', 'Flow schedule triggered'],
  'poll.created': ['Опрос создан', 'Poll created'],
  'poll.voted': ['Голос учтён', 'Poll vote recorded'],
  'poll.closed': ['Опрос закрыт', 'Poll closed'],
  'breakout.started': ['Сессии по комнатам запущены', 'Breakout rooms opened'],
  'breakout.closed': ['Сессии по комнатам закрыты', 'Breakout rooms closed'],
  'whiteboard.opened': ['Доска открыта', 'Whiteboard opened'],
  'whiteboard.cleared': ['Доска очищена', 'Whiteboard cleared'],
  'whiteboard.closed': ['Доска закрыта', 'Whiteboard closed'],
  'annotation.cleared': ['Аннотации очищены', 'Annotations cleared'],
  'session.resumed': ['Сессия возобновлена', 'Session resumed'],
  'room.restored': ['Комната восстановлена', 'Room restored'],
  'room.draining': ['Изменён режим вывода узла комнаты', 'Room node drain changed'],
  'sip.dialin.started': ['Входящий вызов SIP начат', 'SIP dial-in started'],
  'sip.dialin.stopped': ['Входящий вызов SIP остановлен', 'SIP dial-in stopped'],
  'sip.dialin.failed': ['Ошибка входящего вызова SIP', 'SIP dial-in failed'],
  'transcript.consent': ['Изменено согласие на расшифровку', 'Transcript consent changed'],
  'transcript.purged': ['Расшифровка удалена', 'Transcript deleted'],
};

export function auditTypeLabel(type: string): string {
  if (!Object.hasOwn(AUDIT_TYPE_LABELS, type)) return type;
  return AUDIT_TYPE_LABELS[type as AuditEventType][currentLocale() === 'en' ? 1 : 0];
}

const LEAVE_REASONS: Record<string, string> = {
  disconnected: 'соединение прервано',
  left: 'вышел',
  kicked: 'исключён',
  timeout: 'истекло время',
  closed: 'комната закрыта',
  removed: 'удалён',
  unknown: 'причина неизвестна',
};

const DENY_REASONS: Record<string, string> = {
  no_token: 'нет токена',
  invalid_token: 'недействительный токен',
  token_expired: 'токен истёк',
  session_invalid: 'сессия недействительна',
  forbidden: 'нет доступа',
  rate_limited: 'слишком много попыток',
  geo_blocked: 'гео-блокировка',
  room_locked: 'комната закрыта',
  room_full: 'нет свободных мест',
  password_required: 'нужен пароль',
  password_invalid: 'неверный пароль',
};

function reasonLabel(value: string, dictionary: Record<string, string>): string {
  const key = value.trim().toLowerCase();
  return dictionary[key] ?? value;
}

function bytesLabel(value: string): string {
  return value
    .replace(/(\d+)\s*bytes/gi, '$1 Б')
    .replace(/(\d+)\s*chars/gi, '$1 симв.')
    .replace(/(\d+)\s*ms/gi, '$1 мс')
    .replace(/(\d+)\s*s\b/gi, '$1 с');
}

/**
 * Turns the server's English audit prose into a human Russian sentence.
 * Unknown messages fall back to the Russian event-type label; the original
 * English text is still exposed as a tooltip/title by the screens.
 */
export function localizeAuditMessage(message: string, type?: string): string {
  const text = message.trim();
  if (!text) return type ? auditTypeLabel(type) : t('audit.event');
  if (currentLocale() === 'en') return text;
  let match: RegExpExecArray | null;

  if ((match = /^(?:WebSocket join|Join) allowed for (.+)$/i.exec(text))) {
    return `Вход разрешён: ${match[1]}`;
  }
  if ((match = /^Join denied:\s*(.+)$/i.exec(text))) {
    return `Вход отклонён: ${reasonLabel(match[1] ?? '', DENY_REASONS)}`;
  }
  if ((match = /^Join blocked by geo policy \((.+)\)$/i.exec(text))) {
    return `Вход заблокирован гео-политикой: ${match[1]}`;
  }
  if ((match = /^Wrong room password \(attempt (\d+)\)$/i.exec(text))) {
    return `Неверный пароль комнаты (попытка ${match[1]})`;
  }
  if ((match = /^Join lockout after (\d+) failed attempts$/i.exec(text))) {
    return `Вход заблокирован после ${match[1]} неудачных попыток`;
  }
  if ((match = /^Waiting-room request from (.+)$/i.exec(text))) {
    return `Заявка в зале ожидания: ${match[1]}`;
  }
  if (/^Waiting-room request expired$/i.test(text)) {
    return 'Заявка в зале ожидания истекла';
  }
  if ((match = /^Lobby request (admitted|rejected|expired):\s*(.*)$/i.exec(text))) {
    const action = match[1]?.toLowerCase();
    const who = match[2]?.trim();
    const label = action === 'admitted' ? 'Заявка допущена' : action === 'rejected' ? 'Заявка отклонена' : 'Заявка истекла';
    return who ? `${label}: ${who}` : label;
  }
  if ((match = /^Room created \((.*)\)$/i.exec(text)) || (match = /^Admin created room (.+)$/i.exec(text))) {
    return `Комната создана: ${match[1]}`;
  }
  if (/^Room closed$/i.test(text) || /^Admin closed the room$/i.test(text)) {
    return 'Комната закрыта';
  }
  if ((match = /^Participant left \((.+)\)$/i.exec(text))) {
    return `Участник покинул комнату (${reasonLabel(match[1] ?? '', LEAVE_REASONS)})`;
  }
  if ((match = /^Participant left$/i.exec(text))) {
    return 'Участник покинул комнату';
  }
  if ((match = /^(.+) left the call$/i.exec(text))) {
    return `${match[1]} покинул звонок`;
  }
  if ((match = /^(.+) joined the call$/i.exec(text))) {
    return `${match[1]} присоединился к звонку`;
  }
  if (/^The call ended \(room is empty\)$/i.test(text)) {
    return 'Звонок завершён: в комнате не осталось участников';
  }
  if ((match = /^Participant flagged by media-integrity heuristics \(score ([\d.]+)\)$/i.exec(text))) {
    return `Участник отмечен проверкой подлинности медиа (оценка ${match[1]})`;
  }
  if ((match = /^Participant shared a consent-based GPS location$/i.exec(text))) {
    return 'Участник поделился геолокацией (с согласия)';
  }
  if ((match = /^(Admin )?Knowledge query (answered|denied|failed):?\s*(.*)$/i.exec(text))) {
    const admin = match[1] ? 'Администратор: ' : '';
    const action = match[2]?.toLowerCase();
    const rest = match[3]?.trim();
    const label = action === 'answered' ? 'ответ на запрос к базе знаний' : action === 'denied' ? 'запрос к базе знаний отклонён' : 'ошибка запроса к базе знаний';
    return `${admin}${label}${rest ? `: ${rest}` : ''}`;
  }
  if (/^Room password removed$/i.test(text)) return 'Пароль комнаты снят';
  if (/^Participant kicked$/i.test(text)) return 'Участник исключён из комнаты';
  if ((match = /^(?:Chat message|Chat) injected from admin API \((.+)\)$/i.exec(text))) {
    return `Сообщение от администратора (${match[1]})`;
  }
  if ((match = /^Access token issued for (.+)$/i.exec(text))) {
    return `Выдан токен доступа: ${match[1]}`;
  }
  if ((match = /^Recording saved \((.+)\)$/i.exec(text))) {
    return `Запись сохранена (${bytesLabel(match[1] ?? '')})`;
  }
  if ((match = /^Recording deleted:\s*(.+)$/i.exec(text))) {
    return `Запись удалена: ${match[1]}`;
  }
  if ((match = /^Config (replaced|patched) \(etag (.+)\)$/i.exec(text))) {
    return `Настройки ${match[1]?.toLowerCase() === 'replaced' ? 'заменены' : 'обновлены'} (версия ${match[2]})`;
  }
  if (/^Access policy updated$/i.test(text)) return 'Политика доступов обновлена';
  if ((match = /^Webhook endpoints replaced \((\d+)\)$/i.exec(text))) {
    return `Вебхуки обновлены (${match[1]})`;
  }
  if ((match = /^Webhook test (.+) for (.+)$/i.exec(text))) {
    return `Проверка вебхука ${match[1]}: ${match[2]}`;
  }
  if ((match = /^Webhook (\d+): (.+) -> (.+)$/i.exec(text))) {
    return `Вебхук ${match[1]}: ${match[2]} → ${match[3]}`;
  }
  if ((match = /^Capability providers updated \((.*)\)$/i.exec(text))) {
    return `Провайдеры обновлены${match[1]?.trim() ? `: ${match[1]}` : ''}`;
  }
  if ((match = /^Provider test (.+): (ok|failed) \((\d+)ms\)$/i.exec(text))) {
    return `Проверка провайдера ${match[1]}: ${match[2]?.toLowerCase() === 'ok' ? 'успешно' : 'ошибка'} (${match[3]} мс)`;
  }
  if ((match = /^Custom role (created|updated|deleted): (.+?)(?: \((.+)\))?$/i.exec(text))) {
    const action = match[1]?.toLowerCase();
    const verb = action === 'created' ? 'создана' : action === 'updated' ? 'обновлена' : 'удалена';
    return `Своя роль ${verb}: ${match[2]}${match[3] ? ` (${match[3]})` : ''}`;
  }
  if (/^AI agent settings updated$/i.test(text)) return 'Настройки ИИ-агента обновлены';
  if (/^Knowledge agent settings updated$/i.test(text)) return 'Настройки ассистента по базе знаний обновлены';
  if (/^In-call assistant settings updated$/i.test(text)) return 'Настройки ассистента в звонке обновлены';
  if ((match = /^Tenant (created|deleted): (.+)$/i.exec(text))) {
    return match[1]?.toLowerCase() === 'created' ? `Организация создана: ${match[2]}` : `Организация удалена: ${match[2]}`;
  }
  if (/^Tenant settings updated$/i.test(text)) return 'Настройки организации обновлены';
  if (/^Tenant API key rotated$/i.test(text)) return 'API-ключ организации перевыпущен';
  if ((match = /^Document (updated|uploaded|reset|restored): (.+)$/i.exec(text))) {
    const verb = match[1]?.toLowerCase();
    const labels: Record<string, string> = { updated: 'обновлён', uploaded: 'загружен', reset: 'сброшен', restored: 'восстановлен' };
    return `Документ ${labels[verb ?? ''] ?? 'изменён'}: ${match[2]}`;
  }
  if ((match = /^Default document changed: (.+)$/i.exec(text))) {
    return `Документ по умолчанию: ${match[1]}`;
  }
  if ((match = /^Scale configuration updated \((.*)\)$/i.exec(text))) {
    return `Настройки масштабирования обновлены (${match[1]})`;
  }
  if ((match = /^TURN configuration test (ok|failed): (.+)$/i.exec(text))) {
    return `Проверка TURN: ${match[1]?.toLowerCase() === 'ok' ? 'успешно' : 'ошибка'} (${match[2]})`;
  }
  if ((match = /^Invite created \((.+)\)$/i.exec(text))) {
    return `Создано приглашение (${match[1]})`;
  }
  if (/^Custom domain removed$/i.test(text)) return 'Свой домен удалён';
  if ((match = /^Breakout rooms started \((\d+) rooms\)$/i.exec(text))) {
    return `Сессии по комнатам запущены (${match[1]})`;
  }
  if ((match = /^Breakout rooms closed \((.+)\)$/i.exec(text))) {
    return `Сессии по комнатам закрыты (${match[1]})`;
  }
  if ((match = /^Poll created:\s*(.+)$/i.exec(text))) {
    return `Опрос создан: ${match[1]}`;
  }
  if ((match = /^Vote recorded for poll (.+)$/i.exec(text))) {
    return `Голос учтён в опросе ${match[1]}`;
  }
  if ((match = /^Poll closed:\s*(.+)$/i.exec(text))) {
    return `Опрос закрыт: ${match[1]}`;
  }
  if (/^Dashboard assistant answered$/i.test(text)) return 'Ассистент панели ответил';
  if ((match = /^Guard assessed (.+) change \((.+)\)$/i.exec(text))) {
    return `Проверка рисков (${match[1]}): ${match[2]}`;
  }
  if ((match = /^Compliance finding \((.+)\): (.+)$/i.exec(text))) {
    return `Нарушение соответствия (${match[1]}): ${match[2]}`;
  }
  if ((match = /^Analysis run \((.+)\): (\d+) findings, (\d+) segments$/i.exec(text))) {
    return `Анализ (${match[1]}): находок ${match[2]}, сегментов ${match[3]}`;
  }
  if ((match = /^Analysis ready: (\d+) findings$/i.exec(text))) {
    return `Анализ готов: находок ${match[1]}`;
  }
  if ((match = /^In-call assistant request \((.+)\)$/i.exec(text))) {
    return `Запрос ассистента в звонке (${match[1]})`;
  }
  if ((match = /^Session bound to (.+)$/i.exec(text))) {
    return `Сессия привязана: ${match[1]}`;
  }

  // Already Russian (or a mixed message with a Russian explanation) — keep it.
  if (/[\u0400-\u04FF]/.test(text)) return text;

  // Unknown English prose: show the human event type instead of raw protocol text.
  return type ? auditTypeLabel(type) : t('audit.event');
}

function severityIcon(severity: AuditEntry['severity']): 'alert-triangle' | 'info' | 'check' {
  return severity === 'critical' ? 'alert-triangle' : severity === 'warn' ? 'alert-triangle' : 'info';
}

export function auditEntryMessage(entry: AuditEntry): string {
  const details = entry.details;
  if (entry.type === 'public_abuse.threshold' && details) {
    const action = t(details.action === 'room.create' ? 'audit.publicAbuseCreate' : 'audit.publicAbuseJoin');
    const scope = t(details.scope === 'organization' ? 'audit.publicAbuseOrganization' :
      details.scope === 'installation_source' ? 'audit.publicAbuseInstallationSource' : 'audit.publicAbuseSource');
    return t(details.mode === 'observe' ? 'audit.publicAbuseObserved' : 'audit.publicAbuseBlocked', { action, scope });
  }
  if (entry.type === 'admin.action' && details && typeof details.nodeId === 'string') {
    const vars = { node: details.nodeId };
    if (details.kind === 'cluster.node.drain' && typeof details.drain === 'boolean') {
      return t(details.drain ? 'infra.node.inMaintenance' : 'infra.node.resumed', vars);
    }
    if (details.kind === 'cluster.node.disabled' && typeof details.disabled === 'boolean') {
      return t(details.disabled ? 'infra.node.disabled' : 'infra.node.enabled', vars);
    }
    if (details.kind === 'cluster.node.deleted') return t('infra.node.deleted', vars);
    if (details.kind === 'cluster.node.updated') {
      const before = nodeFeaturesSchema.safeParse(details.featuresBefore);
      const after = nodeFeaturesSchema.safeParse(details.featuresAfter);
      const modulesBefore = nodeModuleKindSchema.array().safeParse(details.disabledModulesBefore);
      const modulesAfter = nodeModuleKindSchema.array().safeParse(details.disabledModulesAfter);
      const changes: string[] = [];
      if (before.success && after.success) {
        changes.push(t('audit.nodeFeaturesChanged', {
          ...vars, before: before.data.join(', ') || '—', after: after.data.join(', ') || '—',
        }));
      }
      if (modulesBefore.success && modulesAfter.success) {
        changes.push(t('audit.nodeModulePolicyChanged', {
          ...vars, before: modulesBefore.data.join(', ') || '—', after: modulesAfter.data.join(', ') || '—',
        }));
      }
      return changes.join(' · ') || t('infra.edit.updated', vars);
    }
  }
  if (entry.type === 'admin.action' && details && typeof details.nodeId === 'string' && typeof details.moduleId === 'string') {
    const action = nodeModuleActionSchema.safeParse(details.action);
    if (action.success) {
      const vars = { action: t(`infra.module.action.${action.data}`), node: details.nodeId, module: details.moduleId };
      if (details.kind === 'cluster.node.module.command') return t('audit.moduleQueued', vars);
      if (details.kind === 'cluster.node.module.result' && typeof details.ok === 'boolean') {
        return t(details.ok ? 'audit.moduleSucceeded' : 'audit.moduleFailed', vars);
      }
    }
  }
  return localizeAuditMessage(entry.message, entry.type);
}

/** Compact feed row for the Security screen. */
export function auditEntryRow(entry: AuditEntry): HTMLElement {
  const row = h('div', { class: 'feed-item' });
  const message = auditEntryMessage(entry);
  row.append(
    h('span', {
      class: 'feed-icon',
      attrs: { 'aria-hidden': 'true', style: 'display:inline-flex;margin-top:2px' },
    }, icon(severityIcon(entry.severity), 15)),
    h(
      'div',
      { class: 'feed-body' },
      h(
        'div',
        { class: 'feed-title' },
        severityBadge(entry.severity),
        h('span', { class: 'small', attrs: { title: t('audit.eventCode', { code: entry.type }) }, text: auditTypeLabel(entry.type) }),
      ),
      h('div', { class: 'feed-message', attrs: { title: entry.message }, text: message }),
      h(
        'div',
        { class: 'feed-meta' },
        h('span', { text: formatDateTime(entry.ts) }),
        entry.roomId ? h('a', { attrs: { href: `#/rooms/${encodeURIComponent(entry.roomId)}` }, text: t('audit.roomLink', { id: entry.roomId }) }) : null,
        entry.participantId ? h('span', { class: 'mono', text: entry.participantId }) : null,
        entry.country ? h('span', { text: countryLabel(entry.country) }) : null,
        entry.ipHash ? h('span', { class: 'mono', attrs: { title: t('audit.ipHashHint') }, text: `IP: ${entry.ipHash.slice(0, 10)}…` }) : null,
      ),
    ),
  );
  if (entry.details) {
    row.title = JSON.stringify(entry.details).slice(0, 500);
  }
  return row;
}
