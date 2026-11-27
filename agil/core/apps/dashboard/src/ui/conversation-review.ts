import { conversationReviewPolicySchema, type ConversationReviewPolicy, type ConversationReviewReport } from '@agil/protocol';
import type { AppContext } from '../context.js';
import { h, setButtonLoading } from '../dom.js';
import { formatDateTime } from '../format.js';
import { describeError } from '../errors.js';
import { card } from './card.js';
import { button, field, formGrid, selectInput, textInput } from './controls.js';

type Rule = Extract<ConversationReviewPolicy, { enabled: true }>['rules'][number];
const categories = [{ value: 'ethics', label: 'Правила общения' }, { value: 'disclosure', label: 'Раскрытие данных' }];
const severities = [{ value: 'warn', label: 'Проверить' }, { value: 'critical', label: 'Срочно проверить' }];

export async function renderConversationReview(ctx: AppContext, roomId: string, panel: HTMLElement): Promise<void> {
  const root = h('div', { class: 'stack' });
  panel.replaceChildren(root);
  const report = h('div');
  const rowsHost = h('div', { class: 'stack' });
  const status = h('p', { class: 'notice', attrs: { role: 'status' } });
  const retention = textInput({ type: 'number', value: '30', min: 1, max: 120 });
  const rows: Array<{ id: HTMLInputElement; phrase: HTMLInputElement; category: HTMLSelectElement; severity: HTMLSelectElement }> = [];

  function addRule(rule?: Rule): void {
    if (rows.length >= 30) return;
    const id = textInput({ value: rule?.id ?? '', spellcheck: false, placeholder: 'internal-project' });
    const phrase = textInput({ value: rule?.phrase ?? '', spellcheck: false, autocomplete: 'off' });
    id.maxLength = 48;
    phrase.maxLength = 120;
    const category = selectInput(categories, { value: rule?.category ?? 'ethics' });
    const severity = selectInput(severities, { value: rule?.severity ?? 'warn' });
    const controls = { id, phrase, category, severity };
    const row = h('div', { class: 'stack' }, formGrid(
      field('Идентификатор правила', id), field('Фраза', phrase), field('Категория', category), field('Приоритет', severity),
    ), h('div', { class: 'actions' }, button('Убрать правило', { variant: 'subtle', onClick: () => {
      rows.splice(rows.indexOf(controls), 1);
      row.remove();
    } })));
    rows.push(controls);
    rowsHost.append(row);
  }

  function renderFindings(data: ConversationReviewReport): void {
    status.textContent = data.policy.enabled ? 'Проверка включена. Для работы нужно согласие всех участников.' : 'Проверка выключена.';
    report.replaceChildren(data.findings.length ? h('ul', {}, ...data.findings.map((finding) => h('li', {
      text: `${formatDateTime(finding.at)} · ${categories.find((item) => item.value === finding.category)?.label} · ${finding.ruleId} · ${severities.find((item) => item.value === finding.severity)?.label}`,
    }))) : h('p', { text: 'Сигналов для проверки пока нет.' }));
  }

  async function save(enabled: boolean, action: HTMLButtonElement): Promise<void> {
    const parsed = conversationReviewPolicySchema.safeParse(enabled ? {
      enabled, retentionMin: Number(retention.value), rules: rows.map(({ id, phrase, category, severity }) => ({
        id: id.value.trim(), phrase: phrase.value, category: category.value, severity: severity.value,
      })),
    } : { enabled });
    if (!parsed.success) {
      status.textContent = 'Укажите от 1 до 30 разных идентификаторов, фразы от 3 до 120 символов и срок от 1 до 120 минут.';
      return;
    }
    setButtonLoading(action, true);
    try { renderFindings(await ctx.api.conversationReview(roomId, parsed.data)); }
    catch (error) { status.textContent = describeError(error).title; }
    finally { setButtonLoading(action, false); }
  }

  try {
    const data = await ctx.api.conversationReview(roomId);
    if (data.policy.enabled) {
      retention.value = String(data.policy.retentionMin);
      data.policy.rules.forEach(addRule);
    } else addRule();
    renderFindings(data);
    const enable = button('Применить правила', { variant: 'primary', onClick: () => void save(true, enable) });
    const disable = button('Выключить и очистить', { variant: 'subtle', onClick: () => void save(false, disable) });
    root.append(card({ title: 'Проверка разговора', subtitle: 'Серверная проверка субтитров после согласия всех участников', body: [
      h('p', { text: 'Укажите буквальные фразы. Сигнал показывает совпадение для проверки человеком. Применение правил заново очищает сигналы и запрашивает новое согласие.' }),
      field('Хранить сигналы, минут', retention), rowsHost,
      h('div', { class: 'actions' }, button('Добавить правило', { variant: 'subtle', onClick: () => addRule() }), enable, disable), status,
    ] }), card({ title: 'Сигналы', actions: [button('Обновить', { variant: 'subtle', onClick: () => {
      void ctx.api.conversationReview(roomId).then(renderFindings).catch((error: unknown) => { status.textContent = describeError(error).title; });
    } })], body: report }));
  } catch (error) {
    status.textContent = describeError(error).title;
    root.append(status);
  }
}
