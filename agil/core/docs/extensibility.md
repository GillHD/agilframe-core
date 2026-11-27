# Расширяемость: встроенные инструменты и заменяемые провайдеры

Принцип продукта: **всё работает из коробки (builtin), но любую возможность можно
заменить системой компании (external), ничего не форкая.** По умолчанию —
автономный режим: звонок, чат с файлами, запись, STT, заметки, блюр, аудит
работают без единой внешней зависимости (кроме необязательных AI/knowledge/
integrity-сервисов). Компания может точечно переопределить нужное.

## 1. Возможности и их провайдеры

| Возможность | Builtin (по умолчанию) | Внешний провайдер (примеры) |
|---|---|---|
| Чат | комнатный чат по WS + история + вложения | корпоративный мессенджер (Mattermost/Teams/свой) |
| Файлы | локальное хранилище `.data/files` + подписанные ссылки | S3/MinIO, ECM/DMS, корпоративное облако |
| Speech-to-text | Web Speech (браузер) / серверный Whisper-совместимый | Deepgram, Yandex SpeechKit, локальная модель |
| Уведомления | встроенные toasts/события | email, Telegram, Teams-webhook, корпоративный бот |
| Запись | MediaRecorder в браузере и локальное хранилище Core | Серверная запись через Egress настраивается отдельно |
| Виртуальные фоны | `session.virtualBackgrounds` (градиенты/URL) | библиотека компании, CDN |
| AI-анализ диалогов | локальные правила + экстрактивные заметки | корпоративный AI-агент (см. `agil/core/docs/ai-agent.md`) |
| Knowledge/wik | — (недоступно без компании) | корпоративный RAG-агент (см. §18 контракта) |
| Идентичность | наши HS256 join-токены | IdP/SSO (OIDC — roadmap) |
| События | вебхуки (HMAC) | SIEM/DLP/BI компании |
| Медиа | mesh WebRTC (P2P) | SFU (LiveKit/mediasoup) — roadmap |

## 2. Контракт провайдера

`TenantConfig.providers` — 6 слотов, каждый:

```jsonc
{
  "mode": "builtin" | "external" | "disabled",
  "providerName": "corp-messenger",   // для UI/аудита
  "endpoint": "https://example.com/agil/chat",
  "apiKeyEnv": "AGIL_CHAT_PROVIDER_KEY", // в конфиге только имя env-переменной
  "timeoutMs": 5000,
  "fallback": "builtin" | "fail",      // что делать при ошибке внешнего
  "options": { }                       // провайдер-специфичные параметры
}
```

**Вызов внешнего провайдера** — `POST` JSON-конверт, подписанный HMAC-SHA256:

```jsonc
// запрос (headers: x-agil-signature, x-agil-capability, x-agil-request-id,
//          x-agil-tenant, content-type)
{
  "capability": "chat",           // chat | files | stt | notifications | recording | backgrounds
  "action": "post",               // post | history | put | get | transcribe | send | list
  "requestId": "uuid",
  "tenantId": "demo",
  "roomId": "room-1",
  "payload": { }                  // тело операции (например, {text, from})
}
// ответ
{ "ok": true, "data": { } }       // data валидируется адаптером; ошибки → fallback/fail
```

Безопасность: только HTTPS (в проде), таймаут, HMAC, SSRF-валидация endpoint’а
при сохранении (private/loopback запрещены), ключ только в env, ошибки
провайдера не пробрасываются пользователю (кроме `fallback:'fail'` → 502),
внешние данные не логируются с PII.

## 3. UI и маршрутизация

- `providers.chat.mode` — **маршрутизация** сообщений/хранения; `session.chat.ui`
  — **что рисует виджет** (`builtin` — наш чат, `external` — компания рисует
  свой, `hidden` — скрыт). Если `providers.chat.mode='external'` и `ui='builtin'`,
  наш чат остаётся UI, а хранение/доставка идут через компанию.
- Файлы и серверное распознавание речи используют выбранный провайдер.
- `providers.recording.mode='disabled'` блокирует запуск записи в браузере
  и загрузку новых файлов записи в Core. Настройка организации действует
  и для комнат с переопределением провайдера. Ранее сохранённые записи
  остаются в списке и скачиваются по действующим подписанным ссылкам.
- Фоны: если `providers.backgrounds.mode='external'`, виджет получает список из
  `GET /v1/tenants/:id/backgrounds` (builtin — из конфига).
- `disabled` — функция выключена для тенанта (UI скрывает).

## 4. Автономный режим (важно для «из коробки»)

Без внешних сервисов доступно: комнаты/медиа (mesh), чат + файлы (локально),
демонстрация экрана, запись (клиент + локальное хранилище), STT (браузерный),
локальные compliance-правила и экстрактивные заметки/выдержки, темы, права,
аудит, вебхуки (если получатель есть), MCP (офлайн-инструменты). Интернет нужен
только для TURN (если нет своего), CDN MediaPipe (иначе degraded-блюр),
AI/knowledge/integrity (по желанию) и CDN статики.

## 5. Как заменить (примеры)

**Чат компании.** `PUT /v1/admin/providers` `{providers:{chat:{mode:'external',
providerName:'corp-messenger',endpoint:'https://example.com/agil/chat',
apiKeyEnv:'AGIL_CHAT_PROVIDER_KEY',fallback:'builtin'}}}` +
`PATCH /v1/tenants/demo/config` `{session:{chat:{ui:'external'}}}`. Компания
рисует свой чат; виджет отдаёт/принимает сообщения через SDK/postMessage; или
компания пишет в звонок через `POST /v1/admin/rooms/:id/chat`.

**Файлы в S3.** Провайдер `files` с `mode:'external'`, endpoint компании
реализует `put/get/list` и возвращает подписанный URL; `fallback:'builtin'` —
если S3 недоступен, файл сохранится локально.

**STT у вендора.** `providers.stt.mode='external'` — серверный эндпоинт
`/v1/stt/transcribe` проксирует в вендора; при ошибке — builtin (Web Speech у
клиента / `AGIL_STT_*`).

**Уведомления.** `notifications` external — события join/leave/recording/analysis
уходят в корпоративный бот; builtin — только UI-события.

**Замена «своих» фич на сторонние** возможна и на уровне UI: чат (внешний),
фоны (внешняя библиотека), STT (вендор), AI/knowledge (корпоративные агенты),
идентичность (IdP, roadmap). Медиаплейн (SFU) — тоже сменный слой (roadmap).

## 6. API

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/v1/admin/providers` | статус слотов: mode, providerName, configured/available, fallback |
| PUT | `/v1/admin/providers` | merge `{providers: Partial<ProvidersConfig>}` в конфиг тенанта, аудит |
| POST | `/v1/admin/providers/test` | `{slot, payload?}` → тестовый вызов провайдера, `{ok, latencyMs, detail}` |
| GET | `/v1/tenants/:tenantId/backgrounds` | список фонов (builtin/external) для виджета |

MCP: `agil_get_providers`, `agil_set_providers`, `agil_test_provider`.
OpenAPI: `/openapi.json`, explorer `/docs`.

## 7. Как добавить новый провайдер (код)

1. Определи слот/интерфейс в `agil/core/packages/protocol` (если новая возможность).
2. Реализуй `BuiltinAdapter` рядом с существующим сервисом (переиспользуй
   `@agil/security`/хранилища), и `ExternalAdapter` через общий signed-HTTP
   клиент.
3. Зарегистрируй в реестре провайдеров сервера (`providers.ts`), добавь
   `providers.*` в схему и тесты fallback’ов.
4. Виджет/панель читают `providers.*` и скрывают недоступное; всё остальное
   работает без изменений.
5. Документируй конверт `payload`/`data` провайдера в `agil/core/docs/api.md`.

## 8. Ограничения MVP

- Реестр провайдеров реализован для chat/files/stt/notifications (+backgrounds
  list); recording — через files-хранилище, отдельный media-egress — roadmap.
- Внешние провайдеры вызываются синхронно в рамках запроса (таймауты), без
  очередей и circuit breaker — для продакшена добавить очередь/брейкер.
- Provider-специфичные SDK (S3, Deepgram) не подключаются как зависимости:
  интеграция — через endpoint компании/адаптер, чтобы не раздувать сервер.
- Marketplace провайдеров и per-room override — roadmap.
