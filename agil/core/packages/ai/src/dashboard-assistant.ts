/**
 * Local (no-LLM) fallback for the dashboard mascot assistant.
 *
 * Used when AGIL_DEEPSEEK_API_KEY is not configured or the provider is down:
 * answers from a small rule engine, always includes risk warnings for
 * destructive intents and suggests safer next steps. No network calls.
 */
import type { DashboardAssistantRequest, DashboardAssistantResponse, DashboardAssistantRole } from '@agil/protocol';
import { assessChange } from './guard.js';

const SUGGESTIONS: Record<DashboardAssistantRole, string[]> = {
  assistant: ['Открыть «Комнаты» и создать тестовую комнату', 'Проверить роли и права', 'Экспортировать конфиг (JSON)'],
  'config-guardian': ['Показать последствия изменения', 'Экспортировать текущий конфиг', 'Проверить в тестовой комнате'],
  'security-reviewer': ['Проверить, что demo/docs закрыты на проде', 'Выдать минимальные права ролям', 'Включить пароль на внешние комнаты'],
  onboarding: ['Настроить бренд и тему', 'Создать первую комнату', 'Пригласить коллегу по ссылке'],
  'api-helper': ['Открыть /docs/api-guide.md', 'Выдать join-токен через POST /v1/tokens', 'Проверить /openapi.json'],
  'scaling-advisor': ['Проверить лимит участников', 'Настроить TURN-пул', 'Открыть docs/scaling.md'],
  'roles-admin': ['Создать роль «Наблюдатель»', 'Проверить matrix ролей', 'Экспортировать конфиг'],
};

const RISK_WORDS = /(отключ|выключ|удал|сброс|стереть|disable|delete|remove|off|strict|гео|пароль|запис|файл|чат|cors|публик|docs|mcp|sfu|broadcast|лимит)/i;

function lastUserMessage(request: DashboardAssistantRequest): string {
  return [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function localAnswer(role: DashboardAssistantRole, question: string): string {
  const intro = 'Я работаю в локальном режиме (внешняя нейросеть не настроена), но могу подсказать по панели.';
  if (/с чего начать|новичок|впервые|онбординг/i.test(question)) {
    return `${intro}\n\nНачните так:\n1. «Бренд» — название и логотип.\n2. «Комнаты» — создайте тестовую комнату и пригласите коллегу.\n3. «Доступы» — проверьте роли: гость не должен видеть запись/файлы/знания.\n4. «Безопасность» — пароль на внешние комнаты, гео-политика, аудит.\n5. «Интеграции» — вебхуки/AI только после теста.\n\nПеред публикацией закройте docs/MCP и смените demo-ключ.`;
  }
  if (/роль|права|доступ/i.test(question)) {
    return `${intro}\n\nКоротко о правах: встроенные роли host/moderator/guest задают базу; свои роли (baseRole + features) можно создавать/удалять в «Доступах». Итоговые права: token permissions → userOverride → своя роль → roleDefaults → deniedFeatures → включённые features тенанта.\n\nВнешним подрядчикам не давайте recording, fileShare и knowledgeAgent без необходимости. Удаление роли не обрывает звонок, но при переподключении участник получит baseRole.`;
  }
  if (/api|токен|curl|mcp|openapi/i.test(question)) {
    return `${intro}\n\nAPI: ключ x-api-key — только на вашем сервере, в браузер его отдавать нельзя. Токен участника выпускается POST /v1/tokens (roleId — для своей роли, permissions — точечно). Примеры и коды ошибок — /docs/api-guide.md, полный справочник — /docs/api.md, спецификация — /openapi.json. MCP: agil/core/packages/mcp (stdio или HTTP /mcp с Bearer/allowlist).`;
  }
  if (/масштаб|участник|вебинар|turn|sfu|нагрузк/i.test(question)) {
    return `${intro}\n\nMVP: mesh-комнаты до 8 видео, broadcast/вебинарный режим и лимиты — в контракте; SFU/мульти-нода/CDN — roadmap. Для больших комнат нужен TURN-пул и SFU: повышение maxParticipants без них ухудшит связь. Проверьте TURN-тест в «Интеграциях → Масштабирование» и docs/scaling.md.`;
  }
  if (/безопасн|пароль|гео|аудит|вебхук/i.test(question)) {
    return `${intro}\n\nПеред публикацией: пароль на внешние комнаты, waiting room, минимальные права ролям, гео-политика (в проде — ipapi, не header), docs/MCP закрыты, ключи ротированы, аудит включён, вебхуки только https с проверкой подписи. Все изменения безопасности фиксируются в аудите.`;
  }
  return `${intro}\n\nЯ могу помочь с брендом, комнатами, ролями, безопасностью, интеграциями, масштабированием и API. Уточните, какой экран открыт и что хотите изменить — я разберу последствия и предложу безопасный порядок действий.`;
}

export function localAssistantReply(request: DashboardAssistantRequest): DashboardAssistantResponse {
  const role = request.role ?? 'assistant';
  const question = lastUserMessage(request);
  let reply = localAnswer(role, question);
  let risk: DashboardAssistantResponse['risk'];

  if (RISK_WORDS.test(question) && request.context?.currentConfig && /(выключ|отключ|удал|strict|sfu|broadcast|лимит|публик|ослаб)/i.test(question)) {
    risk = assessChange(
      { kind: 'config', next: {}, intent: question },
      request.context.currentConfig,
      {},
    );
    reply += `\n\n⚠️ ${risk.message}`;
  }

  return {
    reply,
    role,
    model: 'local-rules',
    fallback: true,
    risk,
    suggestions: SUGGESTIONS[role],
  };
}
