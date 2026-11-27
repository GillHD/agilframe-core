/** Read-only code block with language label, custom actions and a copy button. */
import { h } from '../dom.js';
import { copyButton } from './copy-button.js';

export interface CodeBlockOptions {
  title?: string;
  language?: string;
  actions?: HTMLElement[];
}

export function codeBlock(code: string, options: CodeBlockOptions = {}): HTMLElement {
  const root = h('div', { class: 'code-block' });
  const head = h('div', { class: 'code-head' });
  head.appendChild(
    h('span', {
      class: 'code-title',
      text: options.title ?? options.language ?? 'Код',
    }),
  );
  const actions = h('div', { class: 'code-actions' });
  for (const action of options.actions ?? []) actions.appendChild(action);
  actions.appendChild(copyButton(code, { iconOnly: true, title: 'Скопировать код' }));
  head.appendChild(actions);
  const pre = h('pre');
  pre.appendChild(h('code', { text: code }));
  root.append(head, pre);
  return root;
}
