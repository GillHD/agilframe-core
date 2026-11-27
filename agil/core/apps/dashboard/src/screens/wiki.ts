import { ApiError } from '../api.js';
import type { ScreenFactory } from '../context.js';
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { docsRoute } from '../links.js';
import { card } from '../ui/card.js';
import { button } from '../ui/controls.js';
import { pageHeader } from './common.js';

const pages = [
  { title: 'wiki.handbook', url: '/wiki/index.html', document: 'wiki-handbook.md' },
  { title: 'wiki.setup', url: '/wiki/setup.html', document: 'wiki-setup.md' },
  { title: 'wiki.b2b', url: '/wiki/b2b.html', document: 'wiki-b2b.md' },
] as const;

export const wikiScreen: ScreenFactory = (ctx) => {
  const notice = h('p', { attrs: { role: 'status' } });
  const signIn = button(t('wiki.platformSignIn'), { onClick: ctx.openWikiPlatformLogin });
  const retry = button(t('wiki.retry'), { onClick: () => void checkAccess() });
  const cards = pages.map((page) => {
    const title = t(page.title);
    const edit = action(t('wiki.edit'), title, docsRoute(page.document, 'edit'), true);
    const history = action(t('wiki.history'), title, docsRoute(page.document, 'history'));
    const editActions = [edit, history];
    editActions.forEach((element) => { element.hidden = true; });
    return {
      document: page.document,
      editActions,
      element: card({ title, actions: [action(t('wiki.open'), title, `${ctx.api.baseUrl}${page.url}`), ...editActions] }),
    };
  });
  const root = h('div', { class: 'page' },
    pageHeader({ title: t('nav.wiki'), subtitle: t('wiki.subtitle') }),
    h('div', { class: 'stack' },
      card({ body: h('div', { class: 'stack' }, notice, h('div', { class: 'actions wiki-access-actions' }, signIn, retry)) }),
      ...cards.map(({ element }) => element),
    ),
  );
  let destroyed = false;
  let checking = false;
  retry.hidden = true;
  async function checkAccess(): Promise<void> {
    if (checking) return;
    checking = true;
    notice.textContent = t('wiki.checking');
    signIn.hidden = true;
    retry.setAttribute('aria-disabled', 'true');
    for (const { editActions } of cards) {
      editActions.forEach((element) => { element.hidden = true; });
    }
    try {
      const result = await ctx.api.docs();
      if (destroyed) return;
      const files = new Set(result.docs.map(({ name }) => name));
      let missing = false;
      for (const entry of cards) {
        const exists = files.has(entry.document);
        missing ||= !exists;
        entry.editActions.forEach((element) => { element.hidden = !result.editable || !exists; });
      }
      notice.textContent = result.editable ? t(missing ? 'wiki.missing' : 'wiki.editHint') : t('wiki.readOnly');
      signIn.hidden = result.editable;
      const hadFocus = retry.ownerDocument.activeElement === retry;
      retry.hidden = !result.editable || !missing;
      if (hadFocus && retry.hidden) {
        const target = result.editable ? cards[0]?.editActions[0] : signIn;
        target?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (destroyed) return;
      const signInRequired = error instanceof ApiError && (error.unauthorized || error.status === 403);
      notice.textContent = t(signInRequired ? 'wiki.signInRequired' : 'wiki.failed');
      signIn.hidden = !signInRequired;
      const hadFocus = retry.ownerDocument.activeElement === retry;
      retry.hidden = signInRequired;
      if (signInRequired && hadFocus) signIn.focus({ preventScroll: true });
    } finally {
      checking = false;
      retry.removeAttribute('aria-disabled');
    }
  }
  void checkAccess();
  return { el: root, destroy() { destroyed = true; } };
};

function action(text: string, title: string, href: string, primary = false): HTMLAnchorElement {
  return h('a', { class: `btn${primary ? ' btn-primary' : ''}`, attrs: { href, 'aria-label': `${text} «${title}»` }, text });
}
