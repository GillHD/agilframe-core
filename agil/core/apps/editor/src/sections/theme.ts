/**
 * Theme section: scheme, all 36 colour tokens with WCAG contrast badges, the
 * `auditTheme()` accessibility panel, typography/shape/spacing/background/
 * logo/motion groups.
 */
import {
  auditTheme,
  contrastRatio,
  themeColorKeys,
  themeContrastChecks,
  themeSchema,
  type ColorTokens,
} from '@agil/protocol';
import { createBackgroundGallery } from '../background-gallery';
import { badge, el, setBadge, type BadgeTone } from '../dom';
import { card, colorInput, renderSchema, selectField, type Sync } from '../fields';
import { localize, tr } from '../i18n';
import type { SectionDefinition } from './types';

type ZodObjectSchema = Parameters<typeof renderSchema>[0];

const COLOR_LABELS: Record<keyof ColorTokens, string> = {
  primary: 'Основной',
  primaryHover: 'Основной при наведении',
  primaryActive: 'Основной при нажатии',
  onPrimary: 'Текст на основном цвете',
  accent: 'Акцент',
  onAccent: 'Текст на акценте',
  background: 'Фон',
  backgroundAlt: 'Фон альтернативный',
  surface: 'Поверхность',
  surfaceElevated: 'Поверхность приподнятая',
  tileBg: 'Фон плитки',
  tileBorder: 'Рамка плитки',
  text: 'Текст',
  textSecondary: 'Вторичный текст',
  textMuted: 'Приглушённый текст',
  onSurface: 'Текст на поверхности',
  border: 'Границы',
  divider: 'Разделители',
  success: 'Успех',
  warning: 'Предупреждение',
  danger: 'Опасность',
  info: 'Информация',
  online: 'Онлайн',
  chatIncomingBg: 'Чат: фон входящего',
  chatOutgoingBg: 'Чат: фон исходящего',
  chatIncomingText: 'Чат: текст входящего',
  chatOutgoingText: 'Чат: текст исходящего',
  controlBg: 'Кнопки: фон',
  controlHover: 'Кнопки: при наведении',
  controlActive: 'Кнопки: при нажатии',
  controlText: 'Кнопки: иконки и текст',
  controlDangerBg: 'Кнопки: фон опасного действия',
  focusRing: 'Кольцо фокуса',
  overlay: 'Затемнение',
  speakingRing: 'Кольцо говорящего',
  shadow: 'Тень',
};

const TYPO_LABELS: Record<string, string> = {
  fontFamily: 'Шрифт',
  fontFamilyMono: 'Моноширинный шрифт',
  fontSizeBase: 'Базовый размер, px',
  weightRegular: 'Насыщенность обычная (regular)',
  weightMedium: 'Насыщенность средняя (medium)',
  weightBold: 'Насыщенность жирная (bold)',
  headingWeight: 'Насыщенность заголовков',
  lineHeight: 'Межстрочный интервал',
  letterSpacing: 'Межбуквенный интервал, em',
};

const TYPO_HINTS: Record<string, string> = {
  fontFamily: 'CSS font-family; системные шрифты работают без интернета.',
  fontFamilyMono: 'Для кода, таймкодов и JSON.',
  letterSpacing: 'От −0,05 до 0,1 em.',
};

const SHAPE_LABELS: Record<string, string> = {
  radiusSm: 'Радиус малый (sm), px',
  radiusMd: 'Радиус средний (md), px',
  radiusLg: 'Радиус большой (lg), px',
  radiusPill: 'Радиус скругления (pill), px',
  shadowSm: 'Тень малая (sm), CSS',
  shadowMd: 'Тень средняя (md), CSS',
  backdropBlurPx: 'Размытие подложки, px',
};

const SPACING_LABELS: Record<string, string> = {
  density: 'Плотность',
  gutter: 'Отступ сетки, px',
  controlSize: 'Размер кнопок, px',
  controlGap: 'Зазор между кнопками, px',
};

const BACKGROUND_LABELS: Record<string, string> = {
  type: 'Тип фона',
  color: 'Цвет фона',
  gradient: 'Градиент (CSS)',
  imageUrl: 'URL изображения',
  imagePosition: 'Позиция изображения',
  overlayOpacity: 'Затемнение, 0–1',
};

const BACKGROUND_HINTS: Record<string, string> = {
  gradient: 'Например, linear-gradient(160deg, #f3f6fb, #dde7f7).',
  overlayOpacity: 'Затемнение подложки под сеткой видео.',
};

const LOGO_LABELS: Record<string, string> = {
  url: 'URL логотипа',
  alt: 'Альтернативный текст',
  heightPx: 'Высота, px',
  position: 'Позиция',
};

const LOGO_HINTS: Record<string, string> = {
  position: 'header-left — слева в шапке; header-center — по центру; watermark — водяной знак.',
  url: 'Пусто — логотип не показывается.',
};

const MOTION_LABELS: Record<string, string> = {
  speed: 'Скорость',
  durationFastMs: 'Длительность быстрая (fast), мс',
  durationBaseMs: 'Длительность обычная (base), мс',
  easing: 'Плавность (CSS)',
};

const MOTION_HINTS: Record<string, string> = {
  speed: 'none отключает анимации (prefers-reduced-motion).',
  easing: 'Например, cubic-bezier(0.2, 0, 0, 1).',
};

type ContrastPair = (typeof themeContrastChecks)[number];

interface WorstContrast {
  ratio: number;
  pair: ContrastPair;
}

function measureContrast(colors: ColorTokens, pair: ContrastPair): number {
  try {
    return contrastRatio(colors[pair.a], colors[pair.b]);
  } catch {
    return 1;
  }
}

function worstContrast(colors: ColorTokens, token: keyof ColorTokens): WorstContrast | null {
  let worst: WorstContrast | null = null;
  for (const pair of themeContrastChecks) {
    if (pair.a !== token && pair.b !== token) continue;
    const ratio = measureContrast(colors, pair);
    if (!worst || ratio / pair.min < worst.ratio / worst.pair.min) worst = { ratio, pair };
  }
  return worst;
}

function describeContrast(pair: ContrastPair, ratio: number): string {
  return tr('{pair}: {ratio}:1 (минимум {min}:1)', {
    pair: tr(pair.label),
    ratio: ratio.toFixed(2),
    min: pair.min,
  });
}

export const themeSection: SectionDefinition = {
  id: 'theme',
  title: 'Тема',
  icon: 'sliders',
  description: 'Схема, 36 цветовых токенов с контрастом, шрифты, форма, фон, логотип, анимация.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const schemeCard = card(tr('Схема'), {
      hint: tr('Для системной темы тёмная палитра выводится из основного цвета.'),
    });
    syncs.push(selectField(ctx, schemeCard.body, 'theme.scheme', tr('Схема темы'), themeSchema.shape.scheme.removeDefault().options, {
      labels: { auto: tr('Как в системе') },
    }));
    root.append(schemeCard.root);

    const colorsCard = card(tr('Цветовые токены'), {
      hint: tr('Метка показывает контраст пары, которая ближе всего к своему порогу или сильнее всего от него отстаёт. Для цветов с прозрачностью используйте #rrggbbaa.'),
    });
    const colorList = el('div', 'color-list');
    for (const key of themeColorKeys) {
      const row = el('div', 'color-row');
      const head = el('div', 'color-row-head');
      const name = el('div', 'color-row-name');
      const label = tr(COLOR_LABELS[key]);
      name.append(el('span', 'color-label', label), el('code', 'color-key', key));
      const badgeNode = badge('—', 'muted');
      head.append(name, badgeNode);
      row.append(head);

      const control = colorInput(ctx, `theme.colors.${key}`, label);
      row.append(control.root);
      colorList.append(row);

      syncs.push(control.sync, () => {
        const colors = ctx.config().theme.colors;
        const worst = worstContrast(colors, key);
        if (!worst) {
          setBadge(badgeNode, '—', 'muted', tr('Для этого цвета нет проверки контраста'));
          return;
        }
        const tone: BadgeTone = worst.ratio >= worst.pair.min ? 'ok' : worst.pair.level === 'error' ? 'fail' : 'warn';
        setBadge(
          badgeNode,
          `${worst.ratio.toFixed(2)}:1`,
          tone,
          describeContrast(worst.pair, worst.ratio),
        );
      });
    }
    colorsCard.body.append(colorList);
    root.append(colorsCard.root);

    const a11yCard = card(tr('Доступность (контраст)'), {
      hint: tr('Проверяются пары цветов для текста, кнопок и сообщений чата.'),
    });
    const a11yHost = el('div', 'a11y');
    a11yCard.body.append(a11yHost);
    const syncA11y: Sync = () => {
      const theme = ctx.config().theme;
      const issues = auditTheme(theme);
      a11yHost.replaceChildren();
      if (issues.length === 0) {
        a11yHost.append(el('p', 'a11y-ok', tr('Все проверенные пары достигли порога контраста.')));
        return;
      }
      a11yHost.append(el('p', 'a11y-count', tr('Пар ниже порога: {count}', { count: issues.length })));
      const list = el('ul', 'a11y-list');
      for (const issue of issues) {
        const item = el('li', `a11y-issue a11y-${issue.level}`);
        const pair = themeContrastChecks.find((check) => check.code === issue.code);
        const message = pair ? describeContrast(pair, measureContrast(theme.colors, pair)) : issue.message;
        item.append(el('code', 'a11y-code', issue.code), el('span', 'a11y-message', message));
        list.append(item);
      }
      a11yHost.append(list);
    };
    syncA11y();
    syncs.push(syncA11y);
    root.append(a11yCard.root);

    const addGroup = (
      title: string,
      schema: ZodObjectSchema,
      path: string,
      labels: Record<string, string>,
      hints?: Record<string, string>,
    ): void => {
      const groupCard = card(tr(title));
      const fields = renderSchema(schema, path, ctx, { labels: localize(labels), hints: hints && localize(hints) });
      groupCard.body.append(fields.node);
      root.append(groupCard.root);
      syncs.push(...fields.syncs);
    };

    addGroup('Шрифты и текст', themeSchema.shape.typography, 'theme.typography', TYPO_LABELS, TYPO_HINTS);
    addGroup('Форма и тени', themeSchema.shape.shape, 'theme.shape', SHAPE_LABELS);
    addGroup('Отступы', themeSchema.shape.spacing, 'theme.spacing', SPACING_LABELS);

    // Visual gallery first, then the raw background fields for fine-tuning.
    const backgroundGallery = createBackgroundGallery(ctx);
    root.append(backgroundGallery.root);
    syncs.push(backgroundGallery.sync);

    addGroup(
      'Фон комнаты',
      themeSchema.shape.background,
      'theme.background',
      BACKGROUND_LABELS,
      BACKGROUND_HINTS,
    );
    addGroup('Логотип', themeSchema.shape.logo, 'theme.logo', LOGO_LABELS, LOGO_HINTS);
    addGroup('Анимация', themeSchema.shape.motion, 'theme.motion', MOTION_LABELS, MOTION_HINTS);

    return syncs;
  },
};
