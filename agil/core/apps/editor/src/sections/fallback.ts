/**
 * Fallback section: low-bandwidth thresholds, strategy, reconnect and ICE restart.
 */
import { lowBandwidthSchema } from '@agil/protocol';
import { card, renderSchema } from '../fields';
import { tr } from '../i18n';
import type { SectionDefinition } from './types';

const FALLBACK_LABELS: Record<string, string> = {
  enabled: 'Включено',
  strategy: 'Что делать при слабой связи',
  enterThreshold: 'Порог ухудшения',
  restoreThreshold: 'Порог восстановления',
  autoReconnect: 'Автоматическое переподключение',
  rttMs: 'Задержка RTT, мс',
  lossPct: 'Потери пакетов, %',
  jitterMs: 'Дрожание задержки (джиттер), мс',
  minBitrateKbps: 'Минимальная доступная скорость отправки, кбит/с',
  attempts: 'Число попыток',
  backoffMs: 'Пауза между попытками, мс',
  maxBackoffMs: 'Максимальная пауза, мс',
  iceRestartOnFailure: 'Перезапуск ICE при сбое',
};

const FALLBACK_HINTS: Record<string, string> = {
  strategy: 'При слабой связи можно снизить качество видео или приостановить камеры. Активная демонстрация экрана сохраняется. Чат работает, пока доступен сервер сигналинга.',
  enterThreshold: 'Если связь хуже этих значений, включается резервный режим.',
  restoreThreshold: 'Когда связь снова лучше этих значений, качество возвращается.',
};

const FALLBACK_GROUPS: Record<string, string> = {
  enterThreshold: 'Порог ухудшения',
  restoreThreshold: 'Порог восстановления',
  autoReconnect: 'Автоматическое переподключение',
};

export const fallbackSection: SectionDefinition = {
  id: 'fallback',
  title: 'Резервный режим',
  icon: 'layers',
  description: 'Что происходит при слабой связи: пороги задержки и потерь, стратегия ухудшения качества и переподключение.',
  render(ctx, root) {
    const fallbackCard = card(tr('Низкая пропускная способность'));
    const fields = renderSchema(lowBandwidthSchema, 'fallback.lowBandwidth', ctx, {
      labels: FALLBACK_LABELS,
      hints: FALLBACK_HINTS,
      groupLabels: FALLBACK_GROUPS,
      // The built-in chat always uses signaling. Keep the legacy key in the JSON.
      skip: ['chatOverSignaling'],
    });
    fallbackCard.body.append(fields.node);
    root.append(fallbackCard.root);
    return fields.syncs;
  },
};
