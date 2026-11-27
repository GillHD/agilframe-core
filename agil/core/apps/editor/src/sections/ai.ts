/**
 * AI section: corporate AI agent and its compliance policy rules.
 * The knowledge-base (RAG) agent lives in the dedicated "Knowledge-агент" section.
 */
import { aiAgentConfigSchema } from '@agil/protocol';
import { card, renderSchema, tableField, type Sync } from '../fields';
import { tr } from '../i18n';
import type { SectionDefinition } from './types';

const AI_LABELS: Record<string, string> = {
  enabled: 'Включить ИИ-агента',
  mode: 'Режим',
  endpoint: 'Адрес сервиса агента',
  apiKeyEnv: 'Переменная окружения с ключом',
  timeoutMs: 'Тайм-аут ожидания, мс',
  sendTranscripts: 'Отправлять расшифровки',
  sendChat: 'Отправлять чат',
  batchSize: 'Размер пакета',
  retentionMin: 'Хранение анализа, минут',
  notifyModerators: 'Уведомлять модераторов',
  policyText: 'Текст политики',
  policyRules: 'Правила политики',
};

const AI_HINTS: Record<string, string> = {
  mode: 'local — только локальные правила, без внешних вызовов; external — вызов корпоративного ИИ-сервиса; hybrid — нейросеть плюс локальные правила.',
  endpoint: 'Адрес сервиса агента (только https); нужен в режимах external и hybrid.',
  apiKeyEnv: 'Сервер не хранит ключ — только имя переменной окружения с ним.',
  timeoutMs: 'От 500 до 30 000 мс. При ошибке сервера или сети запрос повторяется один раз.',
  sendTranscripts: 'Разрешает отправку фрагментов расшифровки в корпоративный ИИ-сервис. Локальная проверка продолжает работать.',
  sendChat: 'Разрешает отправку сообщений чата в корпоративный ИИ-сервис. Если оба переключателя выключены, Core не обращается к этому сервису.',
  batchSize: 'Сколько фрагментов расшифровки отправлять за один вызов (1–200).',
  retentionMin: 'Срок хранения отчёта, замечаний и заметок в Core. От 1 до 10 080 минут. У расшифровки и журнала аудита отдельные правила хранения.',
  policyText: 'Текст политики передаётся агенту в запросе. По правилам проверяются фрагменты расшифровки.',
  notifyModerators: 'Показывать замечания в звонке организатору и модераторам с правом проверки соответствия. Результаты анализа доступны администратору.',
};

const RULE_LABELS: Record<string, string> = {
  id: 'Идентификатор',
  name: 'Название',
  type: 'Тип',
  pattern: 'Шаблон',
  severity: 'Важность',
  action: 'Действие',
  enabled: 'Включено',
};

const RULE_HINTS: Record<string, string> = {
  type: 'phrase — поиск подстроки; regex — регулярное выражение; pii — телефоны, почта, номера карт; external — внешний сервис проверки.',
  pattern: 'Используется для phrase и regex; для pii и external не нужен.',
  action: 'flag — пометить; warn — предупредить; mute — выключить микрофон; block — исключить участника.',
};

export const aiSection: SectionDefinition = {
  id: 'ai',
  title: 'ИИ-агент',
  icon: 'sparkles',
  description: 'Корпоративный ИИ-агент (искусственный интеллект), пакетная отправка расшифровок и правила проверки соответствия.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const agentCard = card('Корпоративный ИИ-агент', {
      hint: 'Как работает: расшифровка → локальные правила → (в режимах external и hybrid) пакет уходит в ИИ-сервис → замечания и заметки.',
    });
    const fields = renderSchema(aiAgentConfigSchema, 'session.aiAgent', ctx, {
      labels: AI_LABELS,
      hints: AI_HINTS,
      skip: ['policyRules'],
      multiline: ['policyText'],
    });
    agentCard.body.append(fields.node);
    root.append(agentCard.root);
    syncs.push(...fields.syncs);

    const rulesCard = card('Правила проверки соответствия', {
      hint: 'Локальные правила без ИИ работают всегда и без интернета. Пустой список — проверок нет.',
    });
    syncs.push(
      tableField(
        ctx,
        rulesCard.body,
        'session.aiAgent.policyRules',
        aiAgentConfigSchema.shape.policyRules.element,
        'Правила',
        {
          labels: RULE_LABELS,
          hints: RULE_HINTS,
          idPrefix: 'rule',
          addLabel: 'Добавить правило',
          defaults: { name: tr('Новое правило'), type: 'phrase', pattern: '' },
          emptyText: 'Правил нет — добавьте первое (например, фразу «конфиденциально»).',
        },
      ),
    );
    root.append(rulesCard.root);

    return syncs;
  },
};
