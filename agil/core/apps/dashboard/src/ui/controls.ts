/** Form controls and buttons used by every screen. */
import { h, uid } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export type ButtonVariant = 'primary' | 'ghost' | 'subtle' | 'danger' | 'danger-ghost';

export interface ButtonOptions {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  iconAfter?: IconName;
  title?: string;
  ariaLabel?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
  className?: string;
}

export function button(label?: string, options: ButtonOptions = {}): HTMLButtonElement {
  const classes = ['btn', `btn-${options.variant ?? 'ghost'}`];
  if (options.size === 'sm') classes.push('btn-sm');
  if (!label) classes.push('btn-icon');
  if (options.className) classes.push(options.className);

  const node = h('button', { class: classes.join(' '), attrs: { type: options.type ?? 'button' } });
  if (options.disabled) node.disabled = true;
  if (options.title) node.title = options.title;
  const ariaLabel = options.ariaLabel ?? options.title ?? label;
  if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
  if (options.icon) node.appendChild(icon(options.icon, options.size === 'sm' ? 14 : 16));
  if (label) node.appendChild(h('span', { text: label }));
  if (options.iconAfter) node.appendChild(icon(options.iconAfter, options.size === 'sm' ? 14 : 16));
  if (options.onClick) node.addEventListener('click', options.onClick);
  return node;
}

export interface TextInputOptions {
  value?: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'url' | 'email' | 'number' | 'search' | 'datetime-local';
  id?: string;
  name?: string;
  autocomplete?: string;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  required?: boolean;
  disabled?: boolean;
  spellcheck?: boolean;
  className?: string;
  ariaLabel?: string;
  onInput?: (value: string) => void;
  onChange?: (value: string) => void;
}

export function textInput(options: TextInputOptions = {}): HTMLInputElement {
  const node = h('input', {
    class: `input${options.className ? ` ${options.className}` : ''}`,
    attrs: { type: options.type ?? 'text' },
  });
  if (options.value !== undefined) node.value = options.value;
  if (options.placeholder) node.placeholder = options.placeholder;
  if (options.id) node.id = options.id;
  if (options.name) node.name = options.name;
  if (options.autocomplete) node.setAttribute('autocomplete', options.autocomplete);
  if (options.min !== undefined) node.min = String(options.min);
  if (options.max !== undefined) node.max = String(options.max);
  if (options.step !== undefined) node.step = String(options.step);
  if (options.required) node.required = true;
  if (options.disabled) node.disabled = true;
  if (options.spellcheck === false) node.spellcheck = false;
  if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel);
  if (options.onInput) node.addEventListener('input', () => options.onInput?.(node.value));
  if (options.onChange) node.addEventListener('change', () => options.onChange?.(node.value));
  return node;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function selectInput(
  options: readonly SelectOption[],
  config: { value?: string; id?: string; className?: string; ariaLabel?: string; onChange?: (value: string) => void } = {},
): HTMLSelectElement {
  const node = h('select', {
    class: `select${config.className ? ` ${config.className}` : ''}`,
  });
  if (config.id) node.id = config.id;
  if (config.ariaLabel) node.setAttribute('aria-label', config.ariaLabel);
  for (const option of options) {
    const optionNode = h('option', { text: option.label, attrs: { value: option.value } });
    if (option.disabled) optionNode.disabled = true;
    node.appendChild(optionNode);
  }
  if (config.value !== undefined) node.value = config.value;
  if (config.onChange) node.addEventListener('change', () => config.onChange?.(node.value));
  return node;
}

export interface TextareaOptions {
  value?: string;
  placeholder?: string;
  rows?: number;
  id?: string;
  className?: string;
  ariaLabel?: string;
  onInput?: (value: string) => void;
}

export function textareaInput(options: TextareaOptions = {}): HTMLTextAreaElement {
  const node = h('textarea', { class: `textarea${options.className ? ` ${options.className}` : ''}` });
  node.value = options.value ?? '';
  if (options.placeholder) node.placeholder = options.placeholder;
  if (options.rows) node.rows = options.rows;
  if (options.id) node.id = options.id;
  if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel);
  if (options.onInput) node.addEventListener('input', () => options.onInput?.(node.value));
  return node;
}

export interface FieldOptions {
  hint?: string;
  className?: string;
  required?: boolean;
}

/** Label + control + optional hint. Clicking the label focuses the control. */
export function field(label: string, control: HTMLElement, options: FieldOptions = {}): HTMLElement {
  const wrapper = h('label', { class: `field${options.className ? ` ${options.className}` : ''}` });
  const caption = h('span', { class: 'field-label', text: options.required ? `${label} *` : label });
  wrapper.append(caption, control);
  if (options.hint) {
    const hint = h('span', { class: 'field-hint', text: options.hint });
    wrapper.appendChild(hint);
    if (control.matches('input:not([type="hidden"]), select, textarea')) {
      if (!control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')) {
        caption.id = uid('field-label');
        control.setAttribute('aria-labelledby', caption.id);
      }
      hint.id = uid('field-hint');
      const descriptions = control.getAttribute('aria-describedby');
      control.setAttribute('aria-describedby', descriptions ? `${descriptions} ${hint.id}` : hint.id);
    }
  }
  return wrapper;
}

export interface CheckboxFieldOptions {
  label: string;
  checked?: boolean;
  description?: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

export function checkboxField(options: CheckboxFieldOptions): HTMLElement {
  const input = h('input', { attrs: { type: 'checkbox' } });
  input.checked = options.checked ?? false;
  if (options.disabled) input.disabled = true;
  const text = h(
    'span',
    { class: 'checkbox-text' },
    h('span', { class: 'checkbox-title', text: options.label }),
    options.description ? h('span', { class: 'checkbox-desc', text: options.description }) : null,
  );
  input.addEventListener('change', () => options.onChange?.(input.checked));
  return h('label', { class: 'checkbox-row' }, input, text);
}

export function formGrid(...children: HTMLElement[]): HTMLElement {
  return h('div', { class: 'form-grid' }, ...children);
}

export function formSection(
  title: string,
  description: string,
  ...children: HTMLElement[]
): HTMLElement {
  return h(
    'section',
    { class: 'form-section' },
    h(
      'div',
      { class: 'form-section-head' },
      h('div', {}, h('h3', { text: title }), h('p', { text: description })),
    ),
    ...children,
  );
}

/** Range slider with a live numeric label (used for integrity threshold). */
export function rangeField(options: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  hint?: string;
  format?: (value: number) => string;
  onChange?: (value: number) => void;
}): HTMLElement {
  const input = h('input', {
    attrs: {
      type: 'range',
      min: String(options.min),
      max: String(options.max),
      step: String(options.step),
      value: String(options.value),
      'aria-label': options.label,
    },
  });
  const valueLabel = h('span', {
    class: 'range-value',
    text: options.format ? options.format(options.value) : String(options.value),
  });
  input.addEventListener('input', () => {
    const value = Number(input.value);
    valueLabel.textContent = options.format ? options.format(value) : String(value);
    options.onChange?.(value);
  });
  return field(
    options.label,
    h('div', { class: 'range-row' }, input, valueLabel),
    options.hint ? { hint: options.hint } : {},
  );
}
