/** Clipboard helpers + a "copy" button with a toast. */
import { button } from './controls.js';
import { toast } from './toast.js';

/** Copies text via the async clipboard API, falling back to execCommand. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface CopyButtonOptions {
  label?: string;
  title?: string;
  size?: 'sm' | 'md';
  iconOnly?: boolean;
  successMessage?: string;
  className?: string;
}

/** `value` may be a getter so dynamically generated links/snippets stay fresh. */
export function copyButton(value: string | (() => string), options: CopyButtonOptions = {}): HTMLButtonElement {
  const getValue = typeof value === 'function' ? value : () => value;
  const node = button(options.iconOnly ? undefined : (options.label ?? 'Копировать'), {
    variant: 'ghost',
    size: options.size ?? 'sm',
    icon: 'copy',
    title: options.title ?? 'Скопировать',
    className: options.className,
  });
  node.addEventListener('click', () => {
    void (async () => {
      const ok = await copyText(getValue());
      if (ok) toast(options.successMessage ?? 'Скопировано в буфер обмена', 'success');
      else toast('Не удалось скопировать — выделите и скопируйте вручную.', 'error');
    })();
  });
  return node;
}
