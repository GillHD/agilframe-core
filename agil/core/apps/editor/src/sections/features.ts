/**
 * Features section: every flag from `featureFlagsSchema`, grouped into core
 * flags and roadmap/beta ones, with a live enabled counter.
 */
import { enabledFeatures, type FeatureKey } from '@agil/protocol';
import { el } from '../dom';
import { card, toggleField, type Sync } from '../fields';
import { tr } from '../i18n';
import {
  ALL_FEATURES,
  CORE_FEATURES,
  FEATURE_LABELS,
  ROADMAP_FEATURES,
  SERVICE_FEATURES,
  flagBadge,
} from './feature-metadata';
import type { SectionDefinition } from './types';

export const featuresSection: SectionDefinition = {
  id: 'features',
  title: 'Функции',
  icon: 'check',
  description:
    'Включайте возможности для организации и проверяйте, какие требуют настройки сервиса.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const summary = card(tr('Включено флагов'));
    const summaryLine = el('div', 'feature-summary');
    const count = el('strong', 'feature-count', '0');
    const total = el('span', 'feature-total', tr('из {count}', { count: ALL_FEATURES.length }));
    const progress = el('div', 'progress');
    const fill = el('span', 'progress-fill');
    progress.append(fill);
    summaryLine.append(count, total);
    summary.body.append(summaryLine, progress);
    root.append(summary.root);

    syncs.push(() => {
      const enabled = enabledFeatures(ctx.config()).length;
      count.textContent = String(enabled);
      fill.style.width = `${Math.round((enabled / ALL_FEATURES.length) * 100)}%`;
    });

    const addFeatureCard = (title: string, hint: string, flags: readonly FeatureKey[]): void => {
      const featureCard = card(tr(title), { hint: tr(hint) });
      for (const flag of flags) {
        syncs.push(
          toggleField(ctx, featureCard.body, `features.${flag}`, FEATURE_LABELS[flag], {
            badge: flagBadge(flag),
          }),
        );
      }
      root.append(featureCard.root);
    };

    addFeatureCard(
      'Функции платформы',
      'Флаги задают доступность функций для организации. Права роли и выбранный режим звонка также влияют на доступ.',
      CORE_FEATURES,
    );
    addFeatureCard(
      'Требуется настройка сервиса',
      'Для трансляции настройте Egress и адрес RTMP, для SIP — шлюз, для перевода — движок перевода.',
      SERVICE_FEATURES,
    );
    addFeatureCard(
      'План развития',
      'Эти флаги доступны в конфигурации. Они сами по себе не включают рабочий сценарий.',
      ROADMAP_FEATURES,
    );

    return syncs;
  },
};
