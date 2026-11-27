/** Public metadata for dashboard assistant roles and MCP commands. */
import type { AssistantPromptInfo, DashboardAssistantRole } from '@agil/protocol';

export type AssistantPrompt = AssistantPromptInfo;

export const ASSISTANT_PROMPTS: AssistantPrompt[] = [
  {
    role: 'assistant',
    title: 'Помощник панели (маскот Аги)',
    description: 'Общий помощник: объясняет экраны, поля и последствия изменений.',
    starters: [
      'С чего начать настройку компании?',
      'Что делает этот переключатель?',
      'Чем отличаются встроенные и свои роли?',
      'Как проверить, что звонки работают?',
    ],
  },
  {
    role: 'config-guardian',
    title: 'Страж конфигурации',
    description: 'Проверяет рискованные изменения настроек и требует подтверждения.',
    starters: [
      'Можно ли отключить запись?',
      'Что сломается, если включить строгий режим доступа?',
      'Безопасно ли отключить пароль на комнату?',
    ],
  },
  {
    role: 'security-reviewer',
    title: 'Проверка безопасности',
    description: 'Помогает закрыть доступ, настроить роли, гео-политику и аудит.',
    starters: [
      'Как закрыть звонки от посторонних?',
      'Какие роли выдать внешним подрядчикам?',
      'Что проверить перед публикацией демо?',
    ],
  },
  {
    role: 'onboarding',
    title: 'Онбординг',
    description: 'Проводит нового администратора по шагам первого запуска.',
    starters: [
      'Я впервые в панели — с чего начать?',
      'Как создать первую комнату и пригласить коллегу?',
      'Как настроить бренд и тему?',
    ],
  },
  {
    role: 'api-helper',
    title: 'Помощник по API',
    description: 'Объясняет REST/WS/MCP и даёт примеры запросов.',
    starters: [
      'Как выдать токен участнику?',
      'Как подключить MCP к нейросети?',
      'Как проверить подпись вебхука?',
    ],
  },
  {
    role: 'scaling-advisor',
    title: 'Советник по масштабированию',
    description: 'Помогает с лимитами, TURN, мульти-нодой, вебинарами и стримингом.',
    starters: [
      'Сколько участников выдержит комната?',
      'Когда нужен TURN-сервер?',
      'Как подготовиться к вебинару на 5000 человек?',
    ],
  },
  {
    role: 'roles-admin',
    title: 'Администратор ролей',
    description: 'Помогает создавать/удалять роли и не сломать доступ.',
    starters: [
      'Какую роль дать внешнему подрядчику?',
      'Что будет, если удалить роль?',
      'Чем baseRole отличается от features?',
    ],
  },
];

export function promptForRole(role: DashboardAssistantRole | undefined): AssistantPrompt {
  return ASSISTANT_PROMPTS.find((prompt) => prompt.role === role) ?? ASSISTANT_PROMPTS[0]!;
}
