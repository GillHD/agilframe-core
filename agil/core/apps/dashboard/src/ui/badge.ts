/** Status badges and severity chips. */
import { h } from '../dom.js';
import { t } from '../i18n.js';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeOptions {
  dot?: boolean;
  title?: string;
  className?: string;
}

export function badge(label: string, tone: BadgeTone = 'neutral', options: BadgeOptions = {}): HTMLElement {
  const node = h('span', {
    class: `badge badge-${tone}${options.className ? ` ${options.className}` : ''}`,
    attrs: options.title ? { title: options.title } : undefined,
  });
  if (options.dot) node.appendChild(h('span', { class: 'badge-dot', attrs: { 'aria-hidden': 'true' } }));
  node.appendChild(document.createTextNode(label));
  return node;
}

const SEVERITY_TONES: Record<string, BadgeTone> = {
  info: 'info',
  warn: 'warning',
  critical: 'danger',
};

export function severityBadge(severity: string): HTMLElement {
  const tone = SEVERITY_TONES[severity] ?? 'neutral';
  const label = severity === 'info' || severity === 'warn' || severity === 'critical' ? t(`audit.${severity}`) : severity;
  return badge(label, tone, { dot: true, title: t('audit.severityCode', { code: severity }) });
}

export function boolBadge(value: boolean, trueLabel = 'Да', falseLabel = 'Нет'): HTMLElement {
  return badge(value ? trueLabel : falseLabel, value ? 'success' : 'neutral');
}

const ROLE_LABELS: Record<string, string> = {
  host: 'Организатор',
  moderator: 'Модератор',
  guest: 'Гость',
};

export function roleBadge(role: string): HTMLElement {
  const tone: BadgeTone = role === 'host' ? 'primary' : role === 'moderator' ? 'info' : 'neutral';
  return badge(roleLabel(role), tone);
}

export function roleLabel(role: string): string {
  return Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role]! : role;
}
