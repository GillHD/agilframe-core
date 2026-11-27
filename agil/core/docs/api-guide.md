# AgilFrame API — понятное руководство (для человека и программиста)

Один документ на два типа читателей: **человеку** — чтобы понять, зачем нужен
API и как он устроен; **программисту** — чтобы сразу увидеть запросы, ответы и
подводные камни. Машиночитаемая спецификация — `/openapi.json` (Swagger UI =
`/docs`), полный технический контракт — `agil/core/docs/contract.md`, справочник —
`agil/core/docs/api.md`.

---

## 1. Что это простыми словами

AgilFrame — «движок видеозвонков», который встраивается в ваш сайт или
приложение. Ваш бэкенд говорит нашему API:

1. «создай комнату» → получает `roomId`;
2. «выдай токен сотруднику» (`permissions` — что ему можно) → получает `token`;
3. отдаёт токен браузеру; браузер открывает звонок через SDK/iframe.

Всё остальное (медиа, чат, файлы, запись, темы, безопасность, аудит, AI) — наша
часть. Ваша часть — решить, **кто** и **что** может, выпустив токен и настроив
тенант. Ключ `x-api-key` — это «админский ключ» тенанта; **никогда** не отдавайте
его в браузер.

---

## 2. Быстрый старт (5 минут)

### Шаг 1. Админский ключ
Выдаётся при создании тенанта (для demo — `dev-key` на dev-стенде).
Передаётся в заголовке `x-api-key`, только с сервера.

### Шаг 2. Создать комнату
```bash
curl -X POST https://calls.example.com/v1/rooms \
  -H 'content-type: application/json' \
  -H 'x-api-key: <ADMIN_KEY>' \
  -d '{"tenantId":"demo","name":"Планёрка","password":"secret"}'    # password — опционально
```
Ответ:
```json
{
  "room": { "id": "4bde…", "tenantId": "demo", "name": "Планёрка", "mediaMode": "mesh", "maxParticipants": 200 },
  "joinUrl": "https://calls.example.com/?room=4bde…&token=…",
  "embedUrl": "https://calls.example.com/embed.html?room=4bde…&token=…",
  "token": "eyJhbGciOiJIUzI1NiIs…"
}
```

### Шаг 3. Выдать токен сотруднику (с нужными правами)
```bash
curl -X POST https://calls.example.com/v1/tokens \
  -H 'content-type: application/json' -H 'x-api-key: <ADMIN_KEY>' \
  -d '{
    "tenantId":"demo",
    "roomId":"4bde…",
    "participant":{"name":"Анна","role":"guest"},
    "permissions":["chat","fileShare","screenShare","knowledgeAgent"]
  }'
```
Токен короткоживущий (по умолчанию 1 час). Если `permissions` не передавать —
берутся права роли из `accessPolicy`.

### Шаг 4. Встроить звонок в браузер
```html
<script src="https://calls.example.com/sdk/agilframe.js"></script>
<div id="call" style="height:640px"></div>
<script>
  const call = await AgilFrame.mount('#call', {
    serverUrl: 'https://calls.example.com',
    tenantId: 'demo',
    room: '4bde…',
    token: '<TOKEN>',
    participantName: 'Анна',
    theme: { scheme: 'auto' }
  });
  call.on('chat', (m) => console.log(m.from.name, m.text));
</script>
```
Или без своего JS: `<iframe src="https://calls.example.com/embed.html?room=…&token=…&tenant=demo">`.

---

## 3. Роли и права: «кто что может»

Есть **три встроенные роли** — `host` (организатор), `moderator`
(модератор), `guest` (гость) — и **любое число своих ролей** (например,
«оператор», «стример», «наблюдатель», «преподаватель»).

### Что настраивается
| Что | Где | Простыми словами |
|---|---|---|
| Права встроенных ролей | `PUT /v1/admin/access-policy` → `roleDefaults` | «что по умолчанию может гость/модератор/организатор» |
| Запреты для всех | `deniedFeatures` | «эту функцию не даём никому» |
| Индивидуальные права | `userOverrides[userId]` | «этому сотруднику — дополнительно» |
| Свои роли | `POST/PUT/DELETE /v1/admin/roles` | «создать роль с нужным набором функций» |
| Права в токене | `POST /v1/tokens` → `permissions` | «конкретно этому входу — только это» |
| Включение функции в тенанте | `features.*` в конфиге | «функция вообще доступна в компании» |

Правило: **итоговые права = роль → исключения → права токена → запреты →
включённые фичи**. Подробно — `agil/core/docs/contract.md` §18.

### Создать свою роль
```bash
curl -X POST https://calls.example.com/v1/admin/roles \
  -H 'content-type: application/json' -H 'x-api-key: <ADMIN_KEY>' \
  -d '{
    "id": "streamer",
    "name": "Стример",
    "description": "Ведёт трансляцию, без записи",
    "baseRole": "host",
    "features": ["chat","screenShare","fullscreen","knowledgeAgent"],
    "canModerate": false,
    "color": "#8576ff"
  }'
```
Выдать её сотруднику:
```bash
curl -X POST https://calls.example.com/v1/tokens \
  -H 'content-type: application/json' -H 'x-api-key: <ADMIN_KEY>' \
  -d '{"tenantId":"demo","roomId":"…","participant":{"name":"Игорь","role":"host","roleId":"streamer"}}'
```
- `baseRole` — «техническая» роль (влияет на модерацию и записи в аудит), а
  `features` — что реально доступно.
- Удалить свою роль: `DELETE /v1/admin/roles/streamer`. Нельзя удалить
  встроенные `host/moderator/guest` (их права меняются через access-policy).
- Если роль удалить, а токен с ней ещё жив — применяется `baseRole`.
- Список: `GET /v1/admin/roles` → встроенные + свои (`builtin:true/false`).

### Поменять права встроенной роли
```bash
curl -X PUT https://calls.example.com/v1/admin/access-policy \
  -H 'content-type: application/json' -H 'x-api-key: <ADMIN_KEY>' \
  -d '{"policy":{"mode":"role-defaults","roleDefaults":{
    "guest":["chat","fileShare","screenShare"],
    "moderator":["chat","fileShare","screenShare","recording","participantList"],
    "host":["chat","fileShare","screenShare","recording","knowledgeAgent","participantList","settings","fullscreen"]
  }}}'
```

---

## 4. Что вообще можно делать через API

### Публичные вызовы (вызывают браузер/ваш фронтенд)
| Запрос | Зачем |
|---|---|
| `GET /v1/health` | жив ли сервис |
| `GET /v1/tenants/{id}/config` | тема/фичи/лейаут для встраивания |
| `GET /v1/tenants/{id}/backgrounds` | список виртуальных фонов |
| `POST /v1/rooms` | создать комнату (на demo-стенде можно без ключа) |
| `POST /v1/rooms/{id}/join` | войти (имя/пароль) → токен |
| `POST /v1/rooms/{id}/chat` | отправить сообщение от имени бота/CRM |
| `POST /v1/files`, `GET /v1/files/{id}` | файлы (подписанные ссылки) |
| `POST /v1/recordings` | загрузить запись |
| `POST /v1/stt/transcribe` | распознать речь (если настроен STT) |
| `POST /v1/rooms/{id}/assistant` | ассистент в звонке (если включён) |

### Админские вызовы (только ваш бэкенд, `x-api-key`)
| Запрос | Зачем |
|---|---|
| `GET /v1/admin/overview` | метрики |
| `GET/POST/DELETE /v1/admin/rooms…` | комнаты, приглашения, lock/kick, чат от бота |
| `GET /v1/admin/transcript…` / `analysis` | транскрипт, заметки, compliance |
| `GET /v1/admin/audit`, `/security` | аудит/безопасность |
| `GET/PUT /v1/admin/ai-agent`, `/knowledge-agent`, `/in-call-agent` | подключить свои AI |
| `GET/PUT /v1/admin/access-policy`, `/roles` | права и свои роли |
| `GET/PUT /v1/admin/webhooks`, `/providers`, `/scale` | интеграции, провайдеры, масштаб |
| `GET/PUT /v1/admin/recordings`, `/files` | файлы/записи |

Все поля, коды ошибок и примеры — в `/openapi.json` и `agil/core/docs/api.md`.

---

## 5. Ошибки: что значит и что делать

| HTTP | code | Что случилось / что делать |
|---|---|---|
| 400 | `validation_failed` | неверные поля — смотрите `details`; исправьте тело |
| 401 | `unauthorized` / `password_invalid` | неверный ключ или пароль; проверьте `x-api-key`/пароль |
| 403 | `forbidden` / `feature_disabled` / `geo_blocked` / `room_locked` | прав нет, функция выключена флагом тенанта, страна запрещена, комната закрыта |
| 404 | `not_found` | нет комнаты/записи/роли |
| 409 | `room_full` / `conflict` | комната заполнена / дубль роли |
| 413 | `payload_too_large` | файл/JSON больше лимита (`AGIL_MAX_UPLOAD_MB`, 1 МиБ JSON) |
| 423 | `room_locked` | комната на паузе/закрыта |
| 429 | `rate_limited` | слишком часто; подождите (лимиты на join/files/admin) |
| 501 | `assistant_local_only` / `stt_not_configured` | функция не настроена/работает локально |
| 502 | `provider_failed` | внешний сервис (AI/knowledge/STT/провайдер) недоступен |

Формат ошибки: `{"error":{"code":"…","message":"…","details":…}}`.
Логи обращений ищите в `GET /v1/admin/audit`.

---

## 6. Реальный звонок: как это работает (для программиста)

```
Браузер A ──WS /ws?token=A──► сервер ──welcome(участники, config, iceServers)──► A
Браузер B ──WS /ws?token=B──► сервер ──peer-joined ──► A
A ◄──sdp/ice relay──► сервер ◄──sdp/ice relay──► B     (WebRTC P2P)
чат/присутствие/реакции/captions — по WS (работает даже при плохом канале)
```
Ключевые сообщения: `hello`, `sdp`, `ice`, `chat`, `state`, `reaction`,
`caption`, `assistant-query`, `ping`, `bye`; сервер: `welcome`, `peer-joined`,
`peer-left`, `chat`, `analysis`, `config`, `error`. Полная схема — `agil/core/docs/contract.md` §5,
пример `wscat` — `agil/core/docs/api.md`.

### Время жизни токена
Токен — это вход, а не сессия. Истёк — выпустите новый (ваш бэкенд). Утёк —
`exp` короткий, `lock`/`kick`, ротация `AGIL_TOKEN_SECRET` инвалидирует всё.

---

## 7. Подключение нейросетей (любых)

| Тип | Как |
|---|---|
| MCP (Claude/Cursor/агенты) | stdio `node agil/core/packages/mcp/dist/index.js` или HTTP `POST /mcp` (Bearer + allowlist); 53 инструмента |
| Любая LLM | ваш шлюз → `AiAgentResponse` / `KnowledgeQueryResponse` / `InCallAssistantResponse` (HMAC-подпись); готовый `UniversalLlmClient` (OpenAI/Anthropic/Ollama) |
| Вебхуки | подписка на `analysis.ready`, `transcript.ready`, `security.event` и др. |

Подробно: `agil/core/docs/llm-integrations.md`, `agil/core/docs/mcp.md`.

---

## 8. Термины

- **Тенант** — ваша компания в AgilFrame (свои настройки/ключи/роли).
- **Комната (room)** — звонок; создаётся API или из мессенджера.
- **Участник** — подключившийся человек; идентифицируется токеном.
- **Права (permissions)** — список функций, доступных участнику.
- **Провайдер** — заменяемая реализация функции (чат/файлы/STT/…): встроенная или ваша.
- **MCP** — протокол инструментов для нейросетей.
- **Вебхук** — HTTP-уведомление от нас вашему серверу (с HMAC-подписью).

---

## 9. Что проверить перед встраиванием

1. Токен выпускается только на вашем бэкенде; `x-api-key` не в браузере.
2. Права: роль → `permissions` → запреты; проверьте UI и API (403).
3. Если нужен TURN — задайте `scale.turn` и проверьте звонок из корпоративной сети.
4. Вебхуки: HMAC-подпись и идемпотентность (`requestId`), ретраи.
5. Продакшен: `AGIL_ALLOW_ANONYMOUS=0`; agil/core/docs/MCP закрыты или за allowlist;
   TLS; бэкапы `.data`.
6. Не публикуйте `openapi.admin.json` наружу (полная спека).

Чек-лист эксплуатации — `agil/core/docs/deployment.md`; безопасность —
`agil/core/docs/security-audit.md`; что осталось — `agil/core/docs/backlog.md`.
