/**
 * Brand section: identity fields, brand colour → palette, and the five
 * protocol theme presets.
 */
import {
  applyBrandColor,
  brandingSchema,
  generatePalette,
  themePresetNames,
  themePresets,
  type ThemePresetName,
} from '@agil/protocol';
import { el } from '../dom';
import { card, colorInput, renderSchema, textField, type Sync } from '../fields';
import { tr } from '../i18n';
import { EXPRESSIONS, type MascotExpression } from '../mascot';
import type { SectionDefinition } from './types';

const BRAND_LABELS: Record<string, string> = {
  productName: 'Название продукта',
  organizationName: 'Организация',
  logoUrl: 'URL логотипа',
  logoHeightPx: 'Высота логотипа, px',
  faviconUrl: 'URL значка сайта (favicon)',
  supportUrl: 'URL поддержки',
  footerText: 'Подпись внизу',
  mascotUrl: 'Ссылка на ассистента Agil',
  mascotName: 'Имя ассистента',
  mascotEnabled: 'Показывать ассистента в панели',
};

const BRAND_HINTS: Record<string, string> = {
  productName: '1–64 символа, показывается в шапке виджета.',
  organizationName: 'До 128 символов; пусто — только название продукта.',
  logoUrl: 'URL или data:image/…; работает офлайн.',
  logoHeightPx: '12–96 px.',
  supportUrl: 'Ссылка «Помощь» в меню виджета.',
  footerText: 'Необязательная подпись внизу экрана.',
  mascotUrl: 'WebP, PNG или GIF. Пусто — встроенный ассистент.',
  mascotName: 'До 40 символов; показывается в подсказках панели.',
  mascotEnabled: 'Помощник в правом нижнем углу панели управления.',
};

const EXPRESSION_LABELS: Record<MascotExpression, string> = {
  wave: 'Приветствие',
  thinking: 'Размышление',
  thumbsup: 'Одобрение',
  alert: 'Предупреждение',
  angry: 'Критическое состояние',
  celebrate: 'Празднование',
};

const PRESET_TITLES: Record<ThemePresetName, string> = {
  light: 'Светлая',
  dark: 'Тёмная',
  corporate: 'Корпоративная',
  night: 'Ночная',
  minimal: 'Минимальная',
};

function presetSwatch(preset: ThemePresetName): HTMLElement {
  const theme = themePresets[preset];
  const dots = el('span', 'preset-dots');
  for (const color of [theme.colors.primary, theme.colors.background, theme.colors.surface]) {
    const dot = el('span', 'preset-dot');
    dot.style.background = color;
    dots.append(dot);
  }
  return dots;
}

export const brandSection: SectionDefinition = {
  id: 'brand',
  title: 'Бренд',
  icon: 'palette',
  description: 'Название, логотип, цвет бренда и готовые темы.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const identity = card(tr('Название и логотип'), {
      hint: tr('Эти поля задают оформление виджета и ассистента в панели.'),
    });
    const identityFields = renderSchema(brandingSchema, 'branding', ctx, {
      labels: BRAND_LABELS,
      hints: BRAND_HINTS,
      // Custom domain is NOT editable here: `PATCH /v1/tenants/:id/config` would
      // bypass the DNS-ownership check (no token, no 409). Domains are managed
      // through `PUT/POST /v1/admin/domain`; the save payload strips the field.
      skip: ['customDomain', 'mascotExpressions'],
    });
    identity.body.append(identityFields.node);
    identity.body.append(
      el(
        'p',
        'field-hint',
        tr('Для своего домена используйте PUT /v1/admin/domain. Добавьте выданные записи TXT и CNAME, затем вызовите POST /v1/admin/domain/verify.'),
      ),
    );
    root.append(identity.root);
    syncs.push(...identityFields.syncs);

    const expressionsCard = card(tr('Изображения ассистента'), {
      hint: tr('Укажите ссылки на изображения для состояний ассистента. Пустое поле использует общее изображение.'),
    });
    for (const expression of EXPRESSIONS) {
      syncs.push(textField(ctx, expressionsCard.body, `branding.mascotExpressions.${expression}`, tr(EXPRESSION_LABELS[expression]), {
        maxLength: 200,
        onChange: (value) => {
          const expressions = { ...ctx.config().branding.mascotExpressions };
          if (value.trim()) expressions[expression] = value.trim();
          else delete expressions[expression];
          ctx.set('branding.mascotExpressions', expressions);
        },
      }));
    }
    root.append(expressionsCard.root);

    const colorCard = card(tr('Цвет бренда'), {
      hint: tr('Постройте палитру оформления из основного цвета бренда.'),
    });
    const picker = colorInput(ctx, 'theme.colors.primary', tr('Основной цвет бренда'));
    colorCard.body.append(picker.root);
    syncs.push(picker.sync);

    const paletteHost = el('div', 'palette');
    colorCard.body.append(paletteHost);

    const applyButton = el('button', 'btn btn-primary');
    applyButton.type = 'button';
    applyButton.textContent = tr('Применить к теме');
    applyButton.addEventListener('click', () => {
      const theme = ctx.config().theme;
      ctx.set('theme', applyBrandColor(theme, theme.colors.primary, { surfaces: true }));
      ctx.toast(tr('Палитра пересчитана от цвета бренда'), 'success');
    });
    colorCard.body.append(applyButton);
    colorCard.body.append(
      el(
        'p',
        'field-hint',
        tr('Меняет цвет панелей, границ, кнопок, акцента и контура фокуса.'),
      ),
    );
    root.append(colorCard.root);

    const syncPalette: Sync = () => {
      const theme = ctx.config().theme;
      const scheme = theme.scheme === 'dark' ? 'dark' : 'light';
      const palette = generatePalette(theme.colors.primary, scheme);
      paletteHost.replaceChildren(
        ...Object.entries(palette).map(([name, value]) => {
          const item = el('div', 'palette-item');
          const chip = el('span', 'palette-chip');
          chip.style.background = value;
          const nameEl = el('span', 'palette-name', name);
        nameEl.title = name;
        item.append(chip, nameEl, el('code', 'palette-hex', value));
          return item;
        }),
      );
    };
    syncPalette();
    syncs.push(syncPalette);

    const presetsCard = card(tr('Готовые темы'), {
      hint: tr('При выборе готовой темы логотип остаётся на прежнем месте.'),
    });
    const presetGrid = el('div', 'preset-grid');
    for (const preset of themePresetNames) {
      const item = el('button', 'preset');
      item.type = 'button';
      item.title = preset;
      const label = tr(PRESET_TITLES[preset]);
      item.append(presetSwatch(preset), el('span', 'preset-name', label));
      item.addEventListener('click', () => {
        const next = structuredClone(themePresets[preset]);
        next.logo = structuredClone(ctx.config().theme.logo);
        next.scheme = preset === 'dark' || preset === 'night' ? 'dark' : 'light';
        ctx.set('theme', next);
        ctx.toast(tr('Тема «{name}» применена', { name: label }), 'success');
      });
      presetGrid.append(item);
    }
    presetsCard.body.append(presetGrid);
    root.append(presetsCard.root);
    // Visual review COV-04/F-19: presets must be visible on the first screen.
    root.insertBefore(presetsCard.root, root.firstElementChild);

    return syncs;
  },
};
