/** Promise-based destructive-action confirmation. */
import { h, type Child } from '../dom.js';
import { t } from '../i18n.js';
import { button } from './controls.js';
import { openModal, type ModalHandle } from './modal.js';

export interface ConfirmDialogOptions {
  title: string;
  message?: Child;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  details?: Child;
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let handle: ModalHandle | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body: Child[] = [];
    if (options.message !== undefined) {
      body.push(h('p', { class: 'muted', text: typeof options.message === 'string' ? options.message : undefined }));
      if (typeof options.message !== 'string') body.push(options.message);
    }
    if (options.details !== undefined) body.push(options.details);

    handle = openModal({
      title: options.title,
      size: 'sm',
      body,
      footer: [
        button(options.cancelLabel ?? t('common.cancel'), {
          variant: 'ghost',
          onClick: () => {
            finish(false);
            handle?.close();
          },
        }),
        button(options.confirmLabel ?? t('common.confirm'), {
          variant: options.danger ? 'danger' : 'primary',
          onClick: () => {
            finish(true);
            handle?.close();
          },
        }),
      ],
      onClose: () => finish(false),
    });
  });
}
