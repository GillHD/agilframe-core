# Экран «Документация» в панели

Документация панели разработчика (`agil/core/apps/dashboard`). Дата: 13.11.2026.

## 1. Назначение

Раньше кнопки документации открывали **сырой `.md` в браузере**. Теперь в панели
есть экран **«Документация»** (`#/docs`): список документов, безопасный
markdown-просмотр, редактирование, загрузка своих `.md/.txt`, история версий,
выбор основного документа и сброс к встроенному оригиналу.

## 2. Маршруты и навигация

- `#/docs` — список + просмотр выбранного/основного документа.
- `#/docs?name=api-guide.md` — deep-link на конкретный документ.
- Пункт навигации **«Документация»** (иконка `file`) сразу после «Интеграций».
- Футер сайдбара:
  - **Документация** → `#/docs`;
  - **Руководство интегратора** → `#/docs?name=api-guide.md`;
  - **Справочник API** → `#/docs?name=api.md`;
  - **Аудит безопасности** → `#/docs?name=security-audit.md`;
  - **API Explorer** → `/docs` (внешний интерактивный explorer, не raw);
  - **OpenAPI JSON** → `/openapi.json` (для Swagger/Postman).
- В «Интеграциях» и «Настройках» у каждого документа есть кнопка **«Открыть»**
  (внутренний просмотр) и отдельная иконка **raw-файла** `↗`.
- Внутри экрана — явные кнопки **«Открыть файл»** (raw) и **«Скачать .md»**.

## 3. API (`@agil/protocol` Doc*)

| Метод | Назначение |
|---|---|
| `GET /v1/admin/docs` | `DocsListResponse`: docs[], defaultName, editable, revisionRestore, conditionalCreate |
| `GET /v1/admin/docs/:name` | `DocContentResponse` |
| `PUT /v1/admin/docs/:name` | `DocWriteRequest` — сохранить/создать custom, новая версия |
| `DELETE /v1/admin/docs/:name` | сброс к исходной версии или удаление загруженного файла с проверкой текущей ревизии |
| `GET /v1/admin/docs/:name/versions` | `DocHistoryResponse` |
| `GET /v1/admin/docs/:name/versions/:id` | содержимое версии для просмотра |
| `POST /v1/admin/docs/:name/versions/:id/restore` | восстановить архивную версию с проверкой текущей ревизии |
| `PUT /v1/admin/docs/default` | `DocDefaultRequest` — основной документ |

Клиент: `src/api.ts` (`docs`, `doc`, `saveDoc`, `deleteDoc`, `docVersions`,
`docVersion`, `restoreDoc`, `setDefaultDoc`). При восстановлении панель
отправляет ревизию, которую администратор видел перед подтверждением.
Если публикация успела измениться, Core возвращает `409 document_conflict`.
Панель сохраняет черновик и предлагает открыть актуальную версию в истории.
Та же проверка защищает сброс и удаление. Перед подтверждением панель
показывает, какие несохранённые правки будут отброшены при успешном действии.
Перед загрузкой панель проверяет имя файла на сервере. Если документ уже
существует, в подтверждении видно его актуальное название, а запрос
содержит его ревизию. Для свободного имени панель отправляет
`expectedRevision: null`. При конфликте выбранный файл остаётся в форме.

## 4. Fallback без backend

Если `/v1/admin/docs` возвращает **404**, панель переходит в режим чтения:

- показывает 8 встроенных документов из `BUNDLED_DOCS` (api-guide, api,
  security-audit, extensibility, messenger, scaling, contract, backlog);
- подгружает их содержимое с `/docs/<name>` (публичные markdown-файлы);
- рендерит markdown и позволяет скачать/открыть raw;
- вкладки «Редактировать»/«Загрузить»/«История» и «Сделать основным/сбросить»
  показывают понятное предупреждение: **«Редактирование документации появится
  после обновления сервера»**.
- После деплоя API включаются все функции без изменений UI.

Все операции записи (сохранить, загрузить, восстановить версию, сделать
основным, сбросить) проходят через `guardedSave('integrations', next, intent,
perform)`; при серверном guard с `requiresConfirmation=true` появляется
маскот-модалка с чекбоксом «Я понимаю последствия».

## 5. Безопасный markdown

`renderMarkdown()` — собственный мини-рендерер без зависимостей:

- заголовки h1–h6, параграфы, списки, blockquote, `hr`, code fences и inline
  code, таблицы, жирный/курсив/зачёркнутый, ссылки, изображения как ссылки;
- **весь текст экранируется** (`&lt;`, `&gt;`, `&amp;`, `"`); raw HTML из
  документа не исполняется (`<script>` не появляется в DOM);
- ссылки: только `http(s)`, `#`, `/`, `mailto:`, относительные `.md`
  (превращаются в `#/docs?name=...`); внешние получают
  `target="_blank" rel="noopener noreferrer"`;
- таблицы и длинные `pre` скроллятся внутри контейнера, страница не расширяется;
- `qa-docs-mock.json` подтверждает: external link target/rel корректны,
  `script=false`, raw `##` не виден в превью.

## 6. Чат/история документации (ручное тестирование)

- Поиск по title/name.
- Бейджи: `встроенный`, `изменённый`, `загруженный`, `основной`, `N версий`.
- Редактор: monospace textarea, счётчик символов, предупреждение про markdown,
  «Сохранить», «Отменить», «Скачать .md».
- Загрузка: `input[type=file]` + drag&drop, `.md/.markdown/.txt`, ≤200 КБ,
  санитайз имени, сохранение как custom; существующее имя — confirm overwrite.
- История: дата/время, размер, автор, note, «текущая», «Восстановить» с
  confirm; восстановление = сохранение содержимого версии как новой текущей.
- «Сделать основным» и «Сбросить к исходному» — confirm + guard; для загруженного документа (без bundled) действие называется «Удалить загруженный» и честно удаляет его через DELETE.
- 390px: список/карточки стопкой, редактор на всю ширину, таблицы markdown
  скроллятся внутри.

## 7. Проверки

- `npm run typecheck -w @agil/dashboard` ✓
- `npm run build -w @agil/dashboard` ✓
- Прод-fallback: 8 документов, markdown 8 headings/15 lists/3 code/2 tables,
  raw не виден, deep-link `#/docs?name=api-guide.md`, footer-ссылки внутренние.
- Mock CRUD (`agil/core/qa/dashboard/qa-docs-mock.json`): list/preview/edit/save/upload/
  history/restore/default/reset — все прошли; 5 guard-calls; 3 PUT, 1 POST
  default, 1 reset, 1 version restore.
- Скриншоты: `agil/core/qa/dashboard/screens/docs/**` (14):
  `01-list-preview`, `02-preview-markdown`, `03-fallback-upload`,
  `04-mobile-list`, `05-mobile-preview`, `10-list-preview`, `11-markdown-safe`,
  `12-editor`, `13-saved`, `14-upload`, `15-uploaded`, `16-history`,
  `17-default`, `18-reset`.
- Открыто: backend `GET/PUT/DELETE /v1/admin/docs*` ещё 404; после деплоя
  включатся edit/upload/history/default/reset.
