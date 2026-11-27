# Обработка медиа: клиент-first (опциональный сервер)

Дата: 2026-11-15 · зона: `agil/core/apps/server` · статус: реализовано (политика/флаги).

## Принцип

По умолчанию **вся обработка видео/аудио выполняется на клиентах** (браузер/SDK):
шумоподавление, blur/replace фона, кодирование, композиция сетки. Сервер:

- не транскодирует кодек/разрешение;
- не микширует и не обрабатывает аудио;
- не блюрит/не сегментирует видео;
- не запускает egress/recording-воркеры в этой сборке;
- SFU (если включён) — только пересылка медиа (forwarding-only).

Это осознанный баланс «качество/надёжность»: дешевле и проще масштабировать,
меньше точек отказа; тяжёлая обработка — по явному opt-in тенанта.

## Конфиг

`TenantConfig.mediaProcessing` (zod, дефолт в `defaultConfig`):

```json
{
  "mode": "client-only",
  "video": false,
  "audio": false,
  "egress": false,
  "transcoding": false,
  "provider": "none"
}
```

- `mode`: `client-only` | `server-assisted`;
- `provider`: `none` | `livekit-egress` | `external`;
- компоненты — декларации на будущее; текущая сборка их **не исполняет**.

`PATCH /v1/tenants/:id/config` принимает `mediaProcessing` (deep-partial).
`server-assisted` без компонентов **не блокируется**: ответ содержит
`warning`, а `GET /v1/admin/media/processing` — `misconfigured:true`.

## API статуса

`GET /v1/admin/media/processing` (tenant admin, `x-api-key`):

| Поле | Смысл |
|---|---|
| `policy` | текущая политика |
| `serverProcessingActive` | `server-assisted` + хотя бы один компонент |
| `sfuForwardingOnly` | `scale.mediaMode !== 'mesh'` (SFU/broadcast только форвардит) |
| `egressConfigured` | `egress && provider !== 'none'` (декларация; воркер не реализован) |
| `misconfigured` | `server-assisted` без компонентов (warning) |
| `note` | человеческое объяснение текущего режима |

`GET /v1/admin/scale` включает краткий `mediaProcessing` summary. Аудит:
`config.updated` с `details.kind = "media.processing.updated"` (без секретов).

## Рекомендации

1. Оставляйте `client-only` — это дефолт и рекомендуемый режим.
2. `server-assisted` включайте только при реальной необходимости (запись в облако,
   тяжёлые эффекты) и с конкретным компонентом.
3. `scale.mediaMode: sfu` не означает серверную обработку: SFU пересылает потоки.
4. Egress/recording worker — отдельная инфраструктура (roadmap); до её появления
   `egressConfigured:true` — только декларация, воркер не стартует.
