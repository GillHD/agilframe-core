/**
 * Integrations section (contract §19): embed origins, postMessage bridge and
 * signed webhooks (stored in `integrations.*`). Identity/SSO lives in `sso.ts`.
 */
import { integrationsConfigSchema, siemConfigSchema, webhookEndpointSchema } from '@agil/protocol';
import { el } from '../dom';
import { card, renderSchema, tableField, type FieldCtx, type Sync } from '../fields';
import { tr } from '../i18n';
import type { SectionDefinition } from './types';

const INTEGRATION_LABELS: Record<string, string> = {
  webhooks: 'Вебхуки (уведомления на ваш сервер)',
  allowedOrigins: 'Разрешённые адреса сайтов для встраивания (origin)',
  embedPostMessage: 'Управление из родительской страницы (postMessage)',
  siem: 'Экспорт аудита в SIEM',
  enabled: 'Включён',
  url: 'Адрес (URL)',
  format: 'Формат (json или cef)',
  secretEnv: 'Переменная окружения с секретом HMAC',
  events: 'События',
  timeoutMs: 'Тайм-аут ожидания, мс',
  retries: 'Повторы',
};

const INTEGRATION_HINTS: Record<string, string> = {
  allowedOrigins: 'Укажите адреса с протоколом и портом, если он нестандартный. Пустой список разрешает любые сайты для организации по умолчанию, для остальных — только сайт звонка.',
  embedPostMessage: 'Разрешает родительской странице управлять встроенным окном (iframe) через сообщения agil:config, theme, scheme и action.',
  siem: 'Отправляет события аудита в SIEM. Если задан секрет, подпись HMAC-SHA256 вычисляется от исходного тела запроса.',
  format: 'json — обычный JSON; cef — формат Common Event Format для SIEM.',
  secretEnv: 'Только имя переменной окружения — сам секрет хранится в настройках сервера.',
  events: 'Пусто — отправлять все события аудита.',
  timeoutMs: 'От 500 до 30 000 мс на одну доставку.',
  retries: 'От 0 до 10 повторов с нарастающей паузой.',
};

const WEBHOOK_LABELS: Record<string, string> = {
  id: 'Идентификатор',
  url: 'Адрес (URL)',
  events: 'События',
  secretEnv: 'Переменная окружения с секретом HMAC',
  enabled: 'Включён',
  retries: 'Повторы',
  timeoutMs: 'Тайм-аут ожидания, мс',
  description: 'Описание',
};

const WEBHOOK_HINTS: Record<string, string> = {
  url: 'В рабочей среде используйте HTTPS. Для проверки подписи возьмите HMAC-SHA256 от x-agil-timestamp, точки и исходного тела запроса.',
  events: 'Выберите хотя бы одно событие для доставки.',
  secretEnv: 'Только имя переменной окружения — сам секрет хранится в настройках сервера.',
  retries: 'От 0 до 10 повторов с нарастающей паузой.',
  timeoutMs: 'От 500 до 30 000 мс на одну доставку.',
};

const WEBHOOK_DEFAULTS = {
  events: ['analysis.ready'],
  enabled: true,
  retries: 3,
  timeoutMs: 5000,
  secretEnv: 'AGIL_WEBHOOK_SECRET',
};

/** Small warning block: catches the most common integration mistakes. */
function integrationWarnings(ctx: FieldCtx, parent: HTMLElement): Sync {
  const box = el('div', 'field-hint integration-warnings');
  parent.append(box);
  const sync: Sync = () => {
    const config = ctx.config();
    const warnings: string[] = [];
    for (const hook of config.integrations.webhooks) {
      const url = hook.url || tr('(без адреса)');
      let protocol: string | undefined;
      try {
        protocol = new URL(hook.url).protocol;
      } catch {
        // An unfinished address is expected while the field is being edited.
      }
      if (protocol === 'http:') {
        warnings.push(tr('Вебхук «{url}»: для рабочей среды нужен HTTPS.', { url }));
      } else if (protocol !== 'https:') {
        warnings.push(tr('Вебхук «{url}»: укажите полный HTTPS-адрес.', { url }));
      }
      if (!hook.enabled) warnings.push(tr('Вебхук «{url}» выключен и не получает события. Включите его, если нужны уведомления.', { url }));
    }
    box.textContent = warnings.length > 0 ? `⚠ ${warnings.join(' ')}` : '';
  };
  sync();
  return sync;
}

export const integrationsSection: SectionDefinition = {
  id: 'integrations',
  title: 'Интеграции',
  icon: 'plug',
  description:
    'Встраивание на сайт, исходящие вебхуки и экспорт аудита.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const identityCard = card('Встраивание на сайт компании', {
      hint: 'Разрешённые домены и postMessage для встроенного окна. Вход через IdP — в отдельной секции «Корпоративный вход».',
    });
    const fields = renderSchema(integrationsConfigSchema, 'integrations', ctx, {
      labels: INTEGRATION_LABELS,
      hints: INTEGRATION_HINTS,
      skip: ['identity', 'webhooks', 'siem'],
    });
    identityCard.body.append(fields.node);
    root.append(identityCard.root);
    syncs.push(...fields.syncs);

    const siemCard = card('Экспорт аудита в SIEM', { hint: INTEGRATION_HINTS.siem });
    const siem = renderSchema(siemConfigSchema, 'integrations.siem', ctx, {
      labels: INTEGRATION_LABELS, hints: INTEGRATION_HINTS,
    });
    siemCard.body.append(siem.node);
    root.append(siemCard.root);
    syncs.push(...siem.syncs);

    const webhookCard = card('Исходящие вебхуки', {
      hint: 'Доставка: POST с JSON-описанием события (WebhookPayload) и заголовками x-agil-signature (подпись HMAC-SHA256), x-agil-delivery, x-agil-event и x-agil-timestamp. Неудачные попытки повторяются с нарастающей паузой.',
    });
    syncs.push(
      tableField(
        ctx,
        webhookCard.body,
        'integrations.webhooks',
        webhookEndpointSchema,
        'Вебхуки',
        {
          labels: WEBHOOK_LABELS,
          hints: WEBHOOK_HINTS,
          idPrefix: 'hook',
          addLabel: 'Добавить вебхук',
          emptyText: 'Вебхуков нет — события звонков никуда не доставляются.',
          defaults: WEBHOOK_DEFAULTS,
        },
      ),
    );
    root.append(webhookCard.root);

    syncs.push(integrationWarnings(ctx, webhookCard.body));

    return syncs;
  },
};
