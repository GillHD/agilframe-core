# Маскот-помощник «Agil», DeepSeek-чат и guard критических изменений

Документация панели разработчика (`agil/core/apps/dashboard`). Дата: 13.11.2026.

## 1. Что умеет

- **Плавающий маскот** снизу справа: draggable (позиция в localStorage), idle-анимация
  `wave`, на мобильном сворачивается в компактный аватар, не перекрывает topbar/sidebar,
  скрывается при открытом мобильном drawer и при `branding.mascotEnabled=false`.
- **Панель «Agil»**: чат с историей (localStorage), выбор роли ассистента, стартеры,
  suggestions-чипы, индикатор «локальный режим», секция **«Что я заметил»**, ссылки
  на `/docs/api-guide.md`, `/docs/api.md` и контракт.
- **7 ролей**: assistant, config-guardian, security-reviewer, onboarding, api-helper,
  scaling-advisor, roles-admin.
- **Состояния маскота**: `thinking` при отправке, `thumbsup`/`celebrate` при успехе,
  `alert`/`angry` при риске, `wave` в idle. Анимированные WebP; при ошибке —
  статичный PNG; при отсутствии файлов — inline-аватар (буквы имени).
- **Guard**: центральная функция `guardedSave(kind, next, intent, perform)` →
  `POST /v1/admin/guard/assess`; при `requiresConfirmation` открывается модалка с
  маскотом `alert/angry`, риском, findings (title/impact/affected),
  рекомендациями, чекбоксом **«Я понимаю последствия»** и кнопкой
  **«Всё равно сохранить»** (disabled без чекбокса). Отмена не выполняет сохранение.
- **Смена маскота**: «Настройки → Маскот-помощник и брендинг»: enabled, имя,
  встроенный вариант idle, свой URL, preview. Сохраняется через guard и
  `PATCH /v1/tenants/:id/config { branding: { mascotEnabled, mascotName,
  mascotUrl, mascotExpressions } }`. После сохранения панель обновляет маскота
  без перезагрузки.
- **Оперативные предупреждения**: 429 и 401 от admin API попадают в «Что я заметил»
  без раскрытия ключей/токенов; последние рискованные события подтягиваются из
  `GET /v1/admin/audit?limit=5&types=security,webhook,guard,room` (при отказе
  сервера секция просто пустая).

## 2. Файлы

| Файл | Назначение |
|---|---|
| `src/ui/mascot.ts` | контроллер маскота, панель, роли/стартеры, локальный fallback, история, notices, загрузка branding |
| `src/ui/guard.ts` | `guardedSave`, `assessChange`, `localAssess`, модалка confirmation |
| `src/main.ts` | `initMascot(ctx, layout.root)` после входа, destroy при teardown |
| `src/screens/settings.ts` | карточка «Маскот-помощник и брендинг» + guarded PATCH |
| `src/screens/security.ts`, `access.ts`, `integrations.ts`, `rooms.ts`, `room.ts` | guarded-сохранения/удаления/блокировки |
| `src/api.ts` | `assistant()`, `assistantPrompts()`, `guardAssess()`, событие `agil-api-warning` для 401/429 |
| `public/branding/mascot/**` | резервная копия ассетов, отдаётся как `/dashboard/branding/mascot/**` |
| `src/styles.css` | маскот/панель/guard/branding + responsive + `[hidden]` fix |

## 3. API

### Assistant

`POST /v1/admin/assistant` (`x-api-key`), тело `DashboardAssistantRequest`:

```json
{
  "messages": [{"role":"user","content":"Как выдать доступ?"}],
  "role": "assistant",
  "context": {"screen": "/access", "tenantId": "demo"}
}
```

Ответ `DashboardAssistantResponse`: `reply`, `role`, `model`, `fallback`,
`suggestions[]`, опционально `risk` (GuardAssessResponse).

Если эндпоинт недоступен (на проде `404`, пока бэкенд не задеплоен) или сеть
упала, панель **не ломается**: отвечает локальными правилами (без отправки
данных), показывает «локальный режим» и suggestions. Это же поведение при
`fallback: true` от сервера. Стриминга нет — индикатор typing.

### Guard

`POST /v1/admin/guard/assess`:

```json
{
  "kind": "config|roles|access|scale|providers|webhook|room|integrations",
  "current": {},
  "next": {},
  "intent": "выключить запись"
}
```

Ответ: `risk`, `requiresConfirmation`, `summary`, `message`, `findings[]`,
`recommendations[]`. При 404/401/403/сети используется консервативный
локальный assessment: destructive-интенты (`удал/отключ/выключ/закры/сброс`)
требуют подтверждения; безопасные сохранения проходят без лишнего диалога.
Guard вызывается перед:

- `config` — безопасность, AI-агент, встраивание (settings), брендинг маскота;
- `access` — матрица доступов и overrides;
- `roles` — создание/изменение/удаление роли;
- `scale` — mediaMode/лимиты/TURN/мульти-нода;
- `providers` — слоты провайдеров;
- `webhook` — вебхуки;
- `room` — lock/unlock/удаление комнаты (в списке и в деталях).

«Публикация agil/core/docs/MCP» отдельной кнопкой не реализована — в панели нет publish
действия; guard применён к сохраняемым конфигам. MCP-конфиг только копируется.

## 4. Брендинг

`TenantConfig.branding` (см. `@agil/protocol`):

- `mascotEnabled` — включать помощника;
- `mascotName` — имя (по умолчанию `Agil`; старое `Аги` мигрируется при чтении, пользовательские имена не перетираются);
- `mascotUrl` — свой URL (http(s) или `/...`);
- `mascotExpressions` — pack `expression → URL` (wave/celebrate/angry/
  thumbsup/thinking/alert; переопределяет отдельные состояния).

Встроенные ассеты лежат в `agil/websdk/demo/public/branding/mascot/**` и
доступны панели из общего с редактором каталога `agil/core/apps/editor/public/branding/mascot/**`. Vite публикует их по тому же URL панели. URL по умолчанию: `/dashboard/branding/mascot/animated/
mascot-wave.webp`. Если `mascotUrl` задан, он используется как fallback для
всех выражений, кроме явно переопределённых.

## 5. Проверки

Headless (puppeteer-core, прод + мок-сервер):

- маскот/ассеты: WebP 360×360 загружается, fallback не показывается;
- панель: имя, 7 ролей, стартеры, ссылки docs; локальный режим при 404;
  серверный ответ/`fallback:false` при моке DeepSeek; suggestions;
- guard: серверный risk high → модалка, cancel не делает PATCH,
  чекбокс разблокирует кнопку, confirm делает PATCH и показывает success;
- брендинг: PATCH `branding` с именем и URL через guard, маскот обновляется;
- 429 → notice «Сервер ограничил частоту запросов (429)»; 401 → notice
  «Ключ или сессия недействительны (401)», помощник не падает;
- скриншоты: `agil/core/qa/dashboard/screens/assistant/**`, `agil/core/qa/dashboard/screens/icons/**`;
  результаты — `agil/core/qa/dashboard/qa-assistant-icons.json`.

Скриншоты:

- `agil/core/qa/dashboard/screens/assistant/01-fab-overview-light.png`
- `02-panel-open.png`
- `03-local-fallback-chat.png`
- `04-guard-risk.png`
- `05-guard-confirmed.png`
- `06-server-chat.png`
- `07-brand-settings.png`
- `08-brand-saved.png`
- `09-429-fallback.png`
- `10-401-guard-fallback.png`

## 6. P2-фиксы в этой же сборке

- **F-18** room-detail polling: интервал 5 с вместо 3 с, exponential backoff до
  30 с на 429/офлайн, пауза при `document.hidden`, сравнение snapshot и
  перерисовка только при изменениях (меньше CLS и запросов).
- **AX-05** 401/просроченный токен: панель говорит «Сессия или токен
  недействительны…» вместо сырого «unauthorized».
- **AX-03** страны: `countryLabel()` показывает `Россия (RU)` / `Германия (DE)`
  без дублирования emoji-флага.
- **AX-08** строки таблицы комнат: `.rooms-table` единая высота 58px,
  однострочные ellipsis-названия/ID — нет «прыжков» строк.

Иконки навигации (IC-01/02/03/05/10/12/19) — см. `agil/core/docs/qa-icons.md`, раздел
«Dashboard: фикс 2026-11-13»: 20×20, stroke 2, bbox center 12/12, key
перецентрован, rooms заменён на дверь, settings — gear, recordings — film,
knowledge — book, дубли/неиспользуемые иконки удалены.

## 7. Ограничения

- Бэкенд `POST /v1/admin/assistant` и `/v1/admin/guard/assess` на проде пока
  отвечает `404`; панель работает в локальном fallback. После деплоя сервера
  (и `DEEPSEEK_API_KEY` на сервере) включится серверный DeepSeek/guard без
  изменений панели.
- В локальном режиме ответы детерминированные и не используют DeepSeek.
- История чата — сессии v2 в localStorage; до 200 сообщений на сессию; данные не покидают браузер.

---

## 9. Редактор (`agil/core/apps/editor`)

Редактор использует того же маскота **Agil** и тот же контракт, что и панель:
`POST /v1/admin/assistant`, `POST /v1/admin/guard/assess`, 7 ролей из
`ASSISTANT_PROMPTS` (`assistant`, `config-guardian`, `security-reviewer`,
`onboarding`, `api-helper`, `scaling-advisor`, `roles-admin`). Имя по умолчанию
`Agil`; `branding.mascotName = "Аги"` (старые конфиги) мигрируется при
загрузке/импорте.

- **Роль выбирается от текущего раздела**: при переходе по 16 разделам редактора
  панель автоматически выставляет роль (см. таблицу ниже). Пользователь может
  сменить роль селектом — до следующей смены раздела. Роль/стартеры спрятаны в
  сворачиваемом блоке «Настройки помощника и примеры», который сам сворачивается
  после первого сообщения.
- **Чат**: те же поля `messages`/`role`/`context`; в `context` передаются
  `screen`, `tenantId`, `currentConfig`, `chatId` и `memory` — релевантные
  фрагменты других чатов ≤2000 символов (лёгкий стемминг русских словоформ).
  `x-api-key` берётся из блока сохранения. При `fallback:true`/404/401/сети —
  локальный детерминированный ответ и бейдж «локальный режим».
- **История чатов**: сессии в `localStorage` (`agil.editor.mascot.chats.v2`,
  миграция из `...history.v1`), drawer с авто-заголовком, датой, поиском,
  открытием/переименованием/удалением и кнопкой «Новый чат»; активная сессия
  восстанавливается после перезагрузки.
- **FAB**: скрывается, пока панель открыта; возвращается по «×»/Escape. На
  мобильном панель full-screen, шапка компактная, FAB не перекрывает save dock и
  скрывается при фокусе в поле ввода.
- **Guard перед сохранением**: `POST /v1/admin/guard/assess` с `kind:'config'`,
  `next` = текущий `TenantConfig`, `intent` = сохранение из редактора. Если
  `requiresConfirmation` — модалка с маскотом `alert`/`angry`,
  findings/impact/recommendations и чекбоксом «Я понимаю последствия»; отмена или
  Escape не выполняют PATCH. При 404 endpoint — консервативная локальная оценка
  («проверка без сервера»).
- **Брендинг**: `branding.mascotEnabled`, `mascotName`, `mascotUrl`,
  `mascotExpressions` читаются из конфига и применяются сразу после изменения
  (в том числе после сохранения бренда); при выключении маскот скрыт, битый URL —
  inline-fallback.
- **Ассеты**: animated WebP с корня origin `/branding/mascot/animated/*.webp`,
  fallback — копии в `agil/core/apps/editor/public/branding/mascot/**`
  (`/editor/branding/...`), затем PNG и инициалы.

### Роли по разделам редактора

| Раздел | Роль |
|---|---|
| Бренд, Тема, Лейаут, Функции, Аудио/видео, Fallback | `config-guardian` |
| Доступы | `roles-admin` |
| Безопасность | `security-reviewer` |
| Интеграции, Провайдеры, вебхуки | `api-helper` |
| Масштабирование | `scaling-advisor` |
| AI-агент, Knowledge-агент, In-call ассистент | `config-guardian` |
| Комната, Сессия | `onboarding` |

### Файлы и проверка

`agil/core/apps/editor/src/mascot.ts` (FAB/панель/чат/сессии/guard), `mascot.css`,
`main.ts` (`setSection`/`sync`), `state.ts` (миграция имени), `inspector.ts`
(`beforeSave` hook). Скриншоты и метрики: `agil/core/qa/editor/screens/mascot/**`
(`v2-*.png`), `agil/core/qa/editor/artifacts/mascot-v2-verify.json`; полный QA-раздел —
`agil/core/docs/qa-editor.md` §10. Проверено: 16/16 разделов с верной ролью, Agil,
fab hidden/open, options collapsed после сообщения, suggestions только в пустом
чате, история (создание/поиск/переименование/удаление/восстановление), `chatId`
и `memory` ≤2000 в теле запроса, guard cancel/confirm, mobile full-screen, light/dark.

## 10. Дашборд v2 (13.11.2026): Agil, история чатов, память, роли по экрану

### 10.1. Fab и имя

- Fab **скрывается**, пока открыта панель (`hidden`); возвращается после
  закрытия/Escape. В закрытом состоянии 58×58 (44×44 на 390), safe-area,
  авто-скрытие при фокусе в формах/скролле.
- Имя по умолчанию — **Agil**. `branding.mascotName`, пустое или `Аги`,
  мигрируется в чтении в `Agil`; произвольное имя пользователя сохраняется.
  Заголовок панели, fab, aria-label и настройки используют одно имя.

### 10.2. Компактный чат

- Header 56px: аватар 36, имя + локальный бейдж, role-chip, кнопки «История»,
  «Новый чат», закрыть.
- Роль-селектор и стартеры — в `<details>` **«Настройки помощника»**; после
  первого сообщения сворачиваются, открываются по кнопке/role-chip.
- Suggestions-чипы: только при пустом чате или после ответа; скрыты при
  включённой истории и во время отправки.
- `.mascot-body` — flex-колонка, `.mascot-messages` — flex:1 со своим scroll,
  composer sticky снизу; на 390 панель 374×828, header `nowrap`, composer
  bottom 782 при viewport 844, fab скрыт.

### 10.3. Сессии истории v2

- Ключ `agil_dashboard_assistant_chats_v2`:
  `{version:2, currentId, sessions:[{id,title,messages,createdAt,updatedAt}]}`.
- Автозаголовок из первого сообщения (≤56 симв), список в панели: дата/время,
  поиск по title/messages, открыть, переименовать, удалить, «Новый чат».
- Текущая сессия восстанавливается после перезагрузки; старый single-history
  (`agil_dashboard_assistant_history_v1`) мигрирует в первую сессию.
- Смена роли/навигация не очищает сообщения: они остаются в сессии.

### 10.4. Память между чатами

- При отправке панель ищет совпадения ключевых слов (≥3 символов, без stop-words)
  в сообщениях **других** сессий, берёт до 3 релевантных чатов/по 3 сообщения,
  обрезает до 2000 символов.
- В `POST /v1/admin/assistant` передаётся
  `context.chatId` и `context.memory` (только если найдено); в память
  подставляется префикс «Прошлые беседы (memory, не придумывай факты...)».
  UI-подсказка в настройках прямо говорит, что memory — прошлые чаты; если
  совпадений нет, поле не отправляется и ответ не выдумывает факты.
- Headless: второй чат «Где найти запись звонка?» получил memory с фрагментом
  первого чата «Настрой запись звонка», `chatId` отличается.

### 10.5. Роли по экрану

| Экран | Роль |
|---|---|
| overview | onboarding |
| rooms | onboarding |
| room detail | assistant |
| security, audit | security-reviewer |
| access (roles) | roles-admin |
| integrations/providers/webhooks | api-helper |
| integrations?scale | scaling-advisor (по hash/контексту) |
| knowledge | config-guardian |
| recordings | assistant |
| settings/embed | config-guardian |
| docs | api-helper |

При навигации роль переключается автоматически; ручной выбор сохраняется как
override **до следующей навигации**, затем снова действует маппинг. В заголовке
панели показывается role-chip и «роль по экрану/вручную». Headless: 11/11
экранов с ожидаемой ролью; manual scaling-advisor → audit = security-reviewer.

### 10.6. Документация в панели

Ссылки docs теперь открывают **`#/docs`** (просмотр/редактирование/версии/
загрузка), raw `.md` — только через «Открыть файл»/«Скачать». Подробнее —
`agil/core/docs/dashboard-docs.md`.

### 10.7. QA

`agil/core/qa/dashboard/qa-mascot-v2.json`, `qa-docs-roles.json`, `qa-docs-mock.json`;
скриншоты `screens/mascot/v2-*.png`, `roles-*.png`, `screens/docs/**`.

---

## 11. UX-ревью 13.11.2026: dock, markdown, fallback, meta-memory, mobile

- **Desktop dock**: при ≥1280 панель не модалка — нет `mascot-backdrop`, ширина
  410, `.app.is-mascot-docked .main { margin-right: 424px }`; контент сдвинут,
  controls не перекрыты. <1280 — overlay без затемнения; на 390 — full-screen
  `100dvh`. Fab скрыт при открытой панели. Docs-ссылки `target=_blank`.
- **Markdown-ответы**: безопасный `renderMarkdown` из docs-экрана; code/lists/
  links/tables; скролл к началу нового ответа; >12 строк — «Показать полностью»;
  кнопки «К началу» / «↓ Новый ответ».
- **Fallback-banner** под ответом: «DeepSeek недоступен. Отвечаю локальными
  подсказками.», причина, «Повторить», `role=status`; локальный бейдж 12px,
  контраст ≥4.5 (см. agil/core/docs/design-system.md).
- **Meta-intent memory**: «что обсуждали / прошлые чаты / напомни темы» →
  `context.memory` = последние 3 чата (title + последнее user-сообщение 200),
  `context.chatId`; если истории нет — локальный список тем, без утверждения
  «не храню». Обычный memory по ключевым словам сохранён.
- **Mobile**: inset 0, 390×844/100dvh, без backdrop; header 61px nowrap;
  actions 44×44; composer sticky bottom; fab hidden.
- QA: `agil/core/qa/dashboard/qa-mascot-ux.json`, screenshots `screens/mascot/ux-*.png`.

---

## 12. «Настроить по скриншоту» (13.11.2026)

- В composer маскота — кнопка-скрепка **«Прикрепить скриншот»**:
  `image/png`, `image/jpeg`, `image/webp`, ≤ **5 МБ**.
- Анализ **полностью локальный** (canvas 64×64), изображение **не уходит на
  сервер**. Собираются доминирующие цвета (квантование), средняя яркость,
  тёмная/светлая сцена; из насыщенных цветов выбираются `primary`/`accent`,
  фон/поверхности/текст/бордер. Текст проходит `bestTextColor`/`contrastRatio`,
  затем `auditTheme`; проблемные пары корректируются до AA ≥ 4.5.
- Превью маскота: сцена, яркость, свотчи, `Применить тему` / `Другой вариант` /
  `Отмена`; при тёмном/светлом фоне — рекомендация `layout.header='compact'` и
  `immersiveVideo=true`, если верх кадра почти пустой. Layout применяется
  отдельной кнопкой **«Применить compact-шапку»** только по подтверждению.
- Применение темы — `guardedSave('config', {theme})` → `PATCH
  /v1/tenants/:tenantId/config`; guard показывает риск, при отказе ничего не
  сохраняется. «Другой вариант» меняет primary/accent и оттенок фона.
- В `POST /v1/admin/assistant` передаётся `context.screenshot =
  {dominantColors, brightness, scene, suggestedTheme, layoutRecommendation}` и
  сообщение пользователя; DeepSeek объясняет, что понял. При 404/500 — локальный
  текст с результатами анализа.
- Ограничение: это **подбор цвета/темы и рекомендации**, а не «полная
  перестройка интерфейса по картинке»; layout меняется только вручную.
- QA: `agil/core/qa/dashboard/qa-screenshot-theme.json`, screenshots
  `screens/mascot/screenshot-*.png`; 1440/390, тёмный/светлый кадр,
  apply/cancel/alternate, guard, 0 console errors.
