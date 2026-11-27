# Дизайн-система панели AgilFrame

Дата: 13.11.2026. Область: `agil/core/apps/dashboard`. Основа — токены
`@agil/protocol` (`themePresets`/`toCssVars`) плюс локальные design-токены.

## 1. Типографика

| Роль | Размер | Line-height | Вес |
|---|---|---|---|
| Body / таблицы / поля | **16px** | 1.55 | 400 |
| Мелкие подписи, бейджи, хинты, meta | **14px** | 1.45 | 400–600 |
| Компактные кнопки | **14px** | 1.4 | 500–600 |
| Обычные кнопки | **15px** | 1.4 | 500–600 |
| Заголовок страницы (`.page-heading h2`) | **28px** | 1.25 | 650 |
| Заголовок topbar (`.page-title`) | **20px** | 1.3 | 600 |
| Карточка (`.card-title`) | **20px** | 1.3 | 600 |
| Markdown | **16px** | 1.6 | — |
| Код | **14px** | 1.5 | 400 mono |

Правило: **никакого текста < 12px**. Заголовки 20–28px. `body` — 16px; поля — 16px (iOS не зумит).
Длинные заголовки/названия обрезаются `ellipsis` (topbar/карточки).

## 2. Цветовые роли и контраст

Источники: `--agil-color-*` (тема тенанта) + локальные:
`--dash-color-muted`, `--dash-color-link`, `--dash-color-link-hover` — смесь
токена с `--agil-color-text` для достижения **≥ 4.5:1**.

- `text` — основной текст; `text-secondary` — вторичный;
  `dash-color-muted` — подписи/хинты; `dash-color-link` — ссылки/активные nav.
- `danger/warning/success/info` — статусы; текст на них проверяется в паре.
- Бейджи: фон 8–18% от цвета, текст — затемнённый (light) / осветлённый (dark)
  semantic color; `.btn-danger-ghost` подмешан к text для ≥4.5.
- Контраст: muted/hint/badge/links/th/nav — light/dark/auto; порог **4.5**,
  для крупного текста допустимо 3.0 (не используем как исключение).
- Проверка: `agil/core/qa/dashboard/qa-typography.json` — **0** пар <4.5 после правок.

## 3. Отступы и сетка

Шкала: **4 / 8 / 12 / 16 / 24 / 32 / 48**; форма gap 16–20, карточка padding 24, секции 32–48.
Карточки — padding 24 (mobile 16), gap 16–24; формы — gap 18; компактные chips — 6–8.
Sidebar 240px (collapsed 64), контент max 1440, gutter 16.
Dock маскота: 424px reserve справа на ≥1280, чтобы не перекрывать controls.

## 4. Иконки

- Размеры: **16 / 20 / 24**, stroke **2**, `currentColor`, `aria-hidden`.
- Nav — 20×20, bbox center 12/12, `flex: 0 0 auto`.
- Кнопки — 16; крупные действия — 20–24; favicon/logo — отдельные img.
- Удалены дубли/лишние (`shield`, `clock`, `user-check`, `terminal`,
  `arrow-up-right`); см. `agil/core/docs/qa-icons.md` §Dashboard.

## 5. Тач-таргеты и состояния

- Кнопки/инпуты/селекты — **min-height 44px** (mobile 48), поля ≥46;
  icon-only — **44×44** (mobile 48×48).
- Checkbox/radio — в `label` с min-height 44; кликабельна вся строка.
- Состояния: default / hover / active / focus-visible (2px outline
  `dash-color-link`), disabled (opacity .5), loading (spinner + disabled),
  error (alert danger + aria-live), empty (empty-state), skeleton.
- Мобильный: карточки вместо таблиц ≤900, toolbar wrap, topbar title ellipsis,
  панель маскота full-screen `100dvh`.

## 6. Компоненты и правила

- **Card**: title/subtitle/actions; radius 12, border 1px, shadow-sm.
- **Badge**: 12px, pill, dot/status; не использовать как единственный носитель
  смысла — рядом текст.
- **Alert**: title+message, семантический фон; `role="status"` для динамики.
- **Modal**: фокус-трап, Escape/backdrop, заголовок id.
- **Docs markdown**: безопасный рендер; внешние ссылки `_blank rel=noopener`;
  таблицы/код скроллятся внутри.
- **Mascot**: dock ≥1280 без scrim; <1280 overlay без затемнения; mobile
  full-screen; markdown-ответы, collapse >12 строк, fallback-banner, история
  чатов и память (см. agil/core/docs/dashboard-assistant.md).

## 7. Что исправлено в этой итерации

- Введены токены типографики/спейсинга; body 14px, line-height 1.5.
- Все подписи/бейджи/хинты/табличные meta подняты до ≥12px
  (`brand-sub`, `quick-link-sub`, `kv-label`, `code-title`, `.mono`,
  `.badge`, `.cell-sub`, `.field-hint`, `.docs-*`, `.mascot-*` и др.).
- Topbar/нав/футер: 20px/14px/12.5px, заголовки 20–26px; исправлены
  переносы/обрезка на 390.
- Кнопки/инпуты 40px (mobile), header-actions маскота 44px; добавлен
  `[hidden] { display:none !important }` (невидимые бейджи/типизация).
- Контраст muted/hint/badge/links/danger-ghost доведён до ≥4.5; фикс
  `org-logo-fallback` и `.btn-danger-ghost`.
- Иконки nav 20/2, bbox 12/12; кнопочные 16; см. agil/core/docs/qa-icons.md.
- Документация: новые `agil/core/docs/saas.md`, `agil/core/docs/dashboard-docs.md`, обновлён
  `agil/core/docs/dashboard-assistant.md`.

## 8. QA

- `agil/core/qa/dashboard/qa-typography.json`: 41 прогон (light/dark × 1440/390 × 11
  экранов), **tiny (<12px) = 0**, **contrast <4.5 = 0**, page overflow 0.
- Скриншоты: `agil/core/qa/dashboard/screens/typography/**` (16).
- SaaS/организации: `agil/core/qa/dashboard/qa-saas.json`, `screens/saas/**` (10).
- Маскот UX: `qa-mascot-ux.json`, `screens/mascot/ux-*.png` (5).

## 9. Скроллбары (единый стиль: дашборд, редактор, виджет)

Один и тот же приём на всех поверхностях — тонкий скруглённый «пилюльный»
ползунок на прозрачном треке, цвет из темы:

- **Firefox:** `scrollbar-width: thin`, `scrollbar-color: <thumb> transparent`
  на `*` (дашборд/редактор) и `.agil-root *` (виджет).
- **Chromium/WebKit:** `::-webkit-scrollbar` 10×10px,
  `::-webkit-scrollbar-thumb` — `border-radius: 999px`, 2px прозрачная рамка +
  `background-clip: padding-box` (ползунок 6px внутри 10px трека),
  `::-webkit-scrollbar-track` прозрачный, `:hover` — ползунок ярче,
  `::-webkit-scrollbar-button { display: none }` (нативные стрелки ломают
  силуэт), `::-webkit-scrollbar-corner` прозрачный.
- Цвета: дашборд — `--agil-color-border` (≈90%), `.table-wrap` сохраняет
  брендовый `--agil-color-primary` (45%); редактор — `--border-strong`/
  `--muted`; виджет — `--agil-color-text-muted` (55–78%).
- Правила, которым нужен **скрытый** скроллбар (шапка/навигация редактора,
  горизонтальные полосы), сохраняют `scrollbar-width: none` /
  `::-webkit-scrollbar { display: none }` — у них выше специфичность.
- Проверка: `agil/core/qa/background-presets/capture.mjs` —
  `jsonThumbRadius=999px`, `jsonThumbWidth=10px`, `paneReservedPx=10`,
  `wrapThumbRadius=999px` во всех трёх приложениях; скриншоты
  `01`, `04`, `05`, `10`, `12` в `agil/core/qa/background-presets/screens/`.
  Puppeteer по умолчанию запускает headless с `--hide-scrollbars`, поэтому
  QA-скрипт стартует с `ignoreDefaultArgs: ['--hide-scrollbars']`.
