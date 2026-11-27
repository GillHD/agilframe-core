/**
 * Critical-change guard: every risky save first asks `POST /v1/admin/guard/assess`.
 * If the server is unavailable (older deployment) a conservative local assessment
 * protects destructive actions; the dialog uses the mascot (alert/angry) and cannot
 * be confirmed until the admin ticks «Я понимаю последствия».
 */
import type { GuardAssessRequest, GuardAssessResponse, GuardFinding, GuardRisk } from '@agil/protocol';
import { ApiError } from '../api.js';
import type { AppContext } from '../context.js';
import { h } from '../dom.js';
import { animateMascot, currentMascotBranding, getGuardContext, mascotImage, notifyGuardRisk } from './mascot.js';
import { badge } from './badge.js';
import { button } from './controls.js';
import { openModal, type ModalHandle } from './modal.js';

export type GuardKind = GuardAssessRequest['kind'];

export interface GuardedSaveOptions {
  /** Current value when the caller already has it (used by the local fallback). */
  current?: unknown;
}

const KIND_LABELS: Record<GuardKind, string> = {
  config: 'настройки организации',
  roles: 'роли и доступы',
  access: 'матрица доступов',
  scale: 'масштабирование',
  providers: 'внешние сервисы',
  webhook: 'вебхуки',
  room: 'комната',
  integrations: 'интеграции',
};

function riskLabel(risk: GuardRisk): string {
  return risk === 'critical' ? 'критический риск' : risk === 'high' ? 'высокий риск' : risk === 'medium' ? 'средний риск' : 'низкий риск';
}

function riskTone(risk: GuardRisk): 'success' | 'warning' | 'danger' {
  if (risk === 'critical' || risk === 'high') return 'danger';
  if (risk === 'medium') return 'warning';
  return 'success';
}

function looksDestructive(intent: string): boolean {
  return /удал|удалить|отключ|выключ|закры|сброс|demo|locking|delete|disable/i.test(intent);
}

/** Conservative offline assessment (the server guard returns richer findings). */
export function localAssess(kind: GuardKind, next: unknown, intent: string, current?: unknown): GuardAssessResponse {
  const destructive = looksDestructive(intent);
  const locksRoom = kind === 'room' && next !== null && typeof next === 'object' && 'locked' in next && next.locked === true;
  const findings: GuardFinding[] = [];
  let risk: GuardRisk = 'low';
  if (destructive) {
    risk = kind === 'roles' || kind === 'room' ? 'high' : 'medium';
    findings.push({
      id: `local-${kind}-destructive`,
      severity: risk === 'high' ? 'critical' : 'warn',
      title: 'Необратимое или ограничивающее действие',
      description: `Вы собираетесь выполнить «${intent}» в разделе «${KIND_LABELS[kind]}».`,
      impact:
        kind === 'roles'
          ? 'Некоторые участники потеряют доступ к функциям; активные звонки не завершатся, но роль применится при следующем подключении участника.'
          : kind === 'room'
            ? locksRoom
              ? 'Вход будет закрыт до открытия комнаты. Подключённые участники останутся в звонке.'
              : 'Участники могут быть отключены от комнаты, ссылки перестанут работать.'
            : 'Изменение затронет участников организации — и новых, и тех, кто уже в звонке.',
      affected: ['участники организации', 'новые подключения'],
      requiresConfirmation: true,
    });
  }
  if (kind === 'access' && next && typeof next === 'object') {
    const denied = (next as { deniedFeatures?: unknown }).deniedFeatures;
    const mode = (next as { mode?: unknown }).mode;
    if (Array.isArray(denied) && denied.length > 0) {
      risk = risk === 'high' ? risk : 'medium';
      findings.push({
        id: 'local-access-denied',
        severity: 'warn',
        title: 'Глобальные запреты в матрице доступов',
        description: `Запрещённых функций: ${denied.length}.`,
        impact: 'Запреты действуют поверх ролей и могут отключить запись, чат или демонстрацию экрана.',
        affected: ['все роли', 'токены с правами'],
        requiresConfirmation: false,
      });
    }
    if (mode === 'strict') {
      findings.push({
        id: 'local-access-strict',
        severity: 'info',
        title: 'Строгий режим (strict)',
        description: 'Права ограничены самым строгим совпадением прав роли и прав токена.',
        impact: 'Участники могут получить меньше прав, чем ожидали.',
        affected: ['все новые токены'],
        requiresConfirmation: false,
      });
    }
  }
  if (kind === 'config' && next && typeof next === 'object') {
    const branding = (next as { branding?: { mascotEnabled?: unknown } }).branding;
    if (branding?.mascotEnabled === false) {
      findings.push({
        id: 'local-branding-mascot',
        severity: 'info',
        title: 'Помощник на экране будет выключен',
        description: 'Помощник и подсказки о рисках скрываются у всех администраторов.',
        impact: 'Администраторы потеряют быстрые подсказки и подтверждения рисков.',
        affected: ['все администраторы'],
        requiresConfirmation: false,
      });
    }
  }
  const summary = destructive ? 'Действие может ограничить доступ участников.' : 'Существенных рисков не обнаружено.';
  return {
    risk,
    requiresConfirmation: findings.some((finding) => finding.requiresConfirmation),
    summary,
    message: destructive
      ? 'Я вижу риск. Проверьте, что это действительно нужно, и подтвердите изменение.'
      : 'Проверка рисков пройдена — можно сохранять.',
    findings,
    recommendations: destructive
      ? ['Проверьте, что изменение не затрагивает активные звонки.', 'Убедитесь, что у вас есть резервная копия конфигурации.', 'При сомнении отмените и уточните у команды.']
      : [],
  };
}

/** Calls the server guard and falls back to the local assessment when unavailable. */
export async function assessChange(
  ctx: AppContext,
  kind: GuardKind,
  next: unknown,
  intent: string,
  current?: unknown,
): Promise<{ assessment: GuardAssessResponse; local: boolean }> {
  try {
    const assessment = await ctx.api.guardAssess({ kind, next, intent, current });
    return { assessment, local: false };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 0 || error.status === 401 || error.status === 403)) {
      return { assessment: localAssess(kind, next, intent, current), local: true };
    }
    return { assessment: localAssess(kind, next, intent, current), local: true };
  }
}

export interface GuardDecision {
  allowed: boolean;
  assessment: GuardAssessResponse;
  local: boolean;
}

/** Mascot guard dialog; resolves false on cancel/Escape. */
export async function confirmGuard(ctx: AppContext, assessment: GuardAssessResponse, local: boolean, intent: string): Promise<boolean> {
  if (!assessment.requiresConfirmation) return true;
  animateMascot(assessment.risk === 'critical' || assessment.risk === 'high' ? 'angry' : 'alert', 0);
  return new Promise<boolean>((resolve) => {
    let handle: ModalHandle | null = null;
    let settled = false;
    const finish = (allowed: boolean): void => {
      if (settled) return;
      settled = true;
      handle?.close();
      animateMascot(allowed ? 'thumbsup' : 'wave');
      resolve(allowed);
    };
    const acknowledge = h('input', { attrs: { type: 'checkbox', id: 'guard-ack' } });
    const confirmButton = button('Всё равно сохранить', {
      variant: 'danger',
      icon: 'alert-triangle',
      disabled: true,
      onClick: () => finish(true),
    });
    const redraw = (): void => {
      confirmButton.disabled = !acknowledge.checked;
    };
    acknowledge.addEventListener('change', redraw);
    const branding = currentMascotBranding(ctx);
    const expression = assessment.risk === 'critical' || assessment.risk === 'high' ? 'angry' : 'alert';
    const findings = h('div', { class: 'guard-findings' });
    for (const finding of assessment.findings) {
      findings.appendChild(
        h(
          'div',
          { class: `guard-finding is-${finding.severity}` },
          h(
            'div',
            { class: 'guard-finding-head' },
            badge(finding.severity, finding.severity === 'critical' ? 'danger' : finding.severity === 'warn' ? 'warning' : 'info'),
            h('strong', { text: finding.title }),
          ),
          h('p', { class: 'guard-finding-desc', text: finding.description }),
          h('p', { class: 'guard-finding-impact', text: `Влияние: ${finding.impact}` }),
          finding.affected.length > 0
            ? h('div', { class: 'chips' }, ...finding.affected.map((item) => badge(item, 'neutral')))
            : null,
        ),
      );
    }
    const recommendations = assessment.recommendations.length > 0
      ? h(
          'div',
          { class: 'guard-recommendations' },
          h('div', { class: 'section-title', text: 'Что советую' }),
          h('ul', {}, ...assessment.recommendations.map((item) => h('li', { text: item }))),
        )
      : null;
    const body = h(
      'div',
      { class: 'guard-body' },
      h(
        'div',
        { class: 'guard-hero' },
        mascotImage(branding, { expression, size: 88 }),
        h(
          'div',
          { class: 'guard-hero-text' },
          h('div', { class: 'chips' }, badge(riskLabel(assessment.risk), riskTone(assessment.risk)), local ? badge('проверка без сервера', 'warning') : badge('проверка на сервере', 'info')),
          h('h3', { class: 'guard-title', text: assessment.summary }),
          h('p', { class: 'guard-message', text: assessment.message }),
          h('p', { class: 'notice', text: `Действие: ${intent}` }),
        ),
      ),
      findings.childElementCount > 0 ? findings : null,
      recommendations,
      h(
        'label',
        { class: 'checkbox-row guard-ack', attrs: { for: 'guard-ack' } },
        acknowledge,
        h(
          'span',
          { class: 'checkbox-text' },
          h('span', { class: 'checkbox-title', text: 'Я понимаю последствия' }),
          h('span', { class: 'checkbox-desc', text: 'Подтверждаю изменение. Оно попадёт в журнал аудита организации.' }),
        ),
      ),
    );
    handle = openModal({
      title: local ? 'Проверка рисков: подтвердите критическое изменение' : 'Проверка рисков: критическое изменение',
      size: 'lg',
      body,
      footer: [
        button('Отмена', {
          variant: 'ghost',
          onClick: () => {
            finish(false);
          },
        }),
        confirmButton,
      ],
      onClose: () => {
        if (!settled) {
          settled = true;
          animateMascot('wave');
          resolve(false);
        }
      },
    });
  });
}

let initialized = false;

export function initGuard(ctx: AppContext): void {
  // The mascot owns the AppContext once initialized; guard only needs it for branding.
  if (!initialized) {
    initialized = true;
    void ctx;
  }
}

/**
 * Central guarded save: assess → optional mascot confirmation → perform.
 * Returns false when the admin cancels the dialog; the perform callback only runs
 * after confirmation (or immediately for low-risk changes).
 */
export async function guardedSave<T>(
  kind: GuardKind,
  next: unknown,
  intent: string,
  perform: () => Promise<T>,
  options: GuardedSaveOptions = {},
): Promise<{ allowed: boolean; value?: T }> {
  const ctx = getGuardContext();
  if (!ctx) {
    return { allowed: true, value: await perform() };
  }
  const { assessment, local } = await assessChange(ctx, kind, next, intent, options.current);
  if (assessment.requiresConfirmation) {
    const confirmed = await confirmGuard(ctx, assessment, local, intent);
    if (!confirmed) return { allowed: false };
    notifyGuardRisk(assessment);
  }
  const value = await perform();
  animateMascot(assessment.risk === 'high' || assessment.risk === 'critical' ? 'celebrate' : 'thumbsup');
  return { allowed: true, value };
}
