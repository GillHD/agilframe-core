import { h } from '../dom.js';
import { t } from '../i18n.js';
import { button, field, textInput } from './controls.js';

/** Filters a loaded list while leaving its controls mounted during refreshes. */
export function tableSearch(label: string, placeholder: string, onChange: () => void) {
  const input = textInput({ type: 'search', ariaLabel: label, placeholder });
  const status = h('span', { class: 'notice', attrs: { role: 'status' } });
  let words: string[] = [];
  const reset = (): void => {
    input.value = '';
    words = [];
    clear.disabled = true;
  };
  const clear = button(t('table.clearSearch'), {
    variant: 'subtle', size: 'sm', disabled: true,
    onClick: () => {
      reset();
      input.focus();
      onChange();
    },
  });
  input.addEventListener('input', () => {
    words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    clear.disabled = words.length === 0;
    onChange();
  });
  return {
    el: h('div', { class: 'filters table-search' }, field(label, input), clear, status),
    input,
    get active() { return words.length > 0; },
    reset,
    matches(...values: Array<string | number | null | undefined>): boolean {
      if (words.length === 0) return true;
      const text = values.join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    },
    setCount(visible: number, total: number): void {
      const text = t('table.searchCount', { visible, total });
      if (status.textContent !== text) status.textContent = text;
    },
  };
}
