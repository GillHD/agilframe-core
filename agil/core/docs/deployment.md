# AgilFrame — запуск и эксплуатация

Схемы развёртывания, Kubernetes и эксплуатационные сценарии собраны в [разделе DevOps](devops/README.md).

Документ для DevOps: как поднять MVP, что обязательно для production и как
масштабироваться дальше. Переменные окружения — в [README](../README.md#переменные-окружения-сервера)
и `agil/core/docs/contract.md` §2/§14.

## 1. Локальный запуск

```bash
npm ci
npm run build
npm start            # http://localhost:8787 — API + WS + demo + editor + dashboard + SDK
```

Разработка: `npm run dev` (сервер 8787, demo 5173, редактор 5174, панель 5175).

Проверка: `npm test`, `npm run e2e` (headless Chrome/Edge, 2 участника, чат, тема).

## 2. Docker

```bash
cp .env.example .env      # задайте секреты
docker compose up -d --build
```

Образ — multi-stage (`Dockerfile`): сборка всех пакетов → runtime только с `dist`
и production-зависимостями, запуск от пользователя `node`, healthcheck на
`/v1/health`, данные в volume `/app/.data`.

## 3. Обязательный production-минимум

1. **TLS** на reverse proxy (Caddy/Nginx/ALB). WebSocket — с `Upgrade`/`Connection`
   и таймаутами не меньше 1 часа (иначе рвётся keepalive).
2. **TURN** (coturn) — без него звонки не пройдут через NAT/корпоративные сети.
   `AGIL_ICE_SERVERS` должен содержать `stun:` и `turn:` (better `turns:` 5349).
   Для TURN over TLS — сертификат и `--tls-listening-port`. Готовый образ ноды
   (SFU + TURN + STUN, enrollment/heartbeat/drain) — [`node-image.md`](node-image.md),
   артефакты в `agil/core/nodes/all-in-one/`.
3. **Секреты** — только из env/vault: `AGIL_TOKEN_SECRET` (≥32 байт),
   `AGIL_API_KEYS` (сильный ключ на тенант), `AGIL_IP_SALT`,
   `AGIL_AI_AGENT_KEY`/`AGIL_KNOWLEDGE_AGENT_KEY`/`AGIL_STT_KEY`,
   `AGIL_INTEGRITY_KEY`, HMAC-секреты вебхуков. В git — никогда.
4. `AGIL_ALLOW_ANONYMOUS=0` в проде; выпуск токенов — только с бэкенда компании.
5. `AGIL_TRUST_PROXY=1` только если за прокси (для IP/гео-заголовков).
6. Файловое хранилище `.data` — на持久 диск с бэкапом; лимит диска мониторить
   (записи/файлы). Для S3-совместимого хранилища — адаптер FilesStore (roadmap).
7. Гео-провайдер: `AGIL_GEO_PROVIDER=header` + заголовки от CDN/WAF
   (`x-agil-country`, `cf-ipcountry`, `x-vercel-ip-country`), либо `ipapi`
   (внешний вызов; учитывайте приватность).
8. Публикация документации/MCP — по умолчанию в проде закройте наружу:
   `AGIL_DOCS_ENABLED=0` (или allowlist/отдельный порт), `AGIL_ADMIN_API_ENABLED`
   и `AGIL_MCP_HTTP_*` — см. `agil/core/docs/api-exposure.md`. Отдельный docs-порт
   (`AGIL_DOCS_PORT`) не должен попадать во внешний ingress.

## 4. Мониторинг

- `GET /v1/health` — liveness (ok, uptime, rooms, tenants, security-флаги).
- `GET /v1/admin/overview`, `GET /v1/admin/security` — KPI и события.
- `GET /v1/admin/audit?limit=…` — аудит (JSONL в `.data/audit`).
- Логи сервера — структурированные строки старта/ошибок; для продакшена
  подключите сбор логов (stdout → Loki/ELK) и алерты на 5xx, рестарты,
  `webhook.failed`, `join.denied`, `geo.blocked`, `integrity.flagged`.
- Сетевые метрики WebRTC — из виджета (`quality-changed`) можно отправлять в
  свою аналитику через host-приложение; серверных метрик медиа в mesh-режиме нет.

Полный production-контур эксплуатации — [`agil/core/docs/operations.md`](operations.md):
health-чек-листы, SLO, Prometheus/Grafana (`agil/core/deploy/observability/`), пороги
алертов, логи, инцидент-раннбуки и HA-топология.

## 5. Масштабирование

Текущий MVP — один инстанс, состояние (комнаты/WS/чат) в памяти.

| Этап | Что делать |
|---|---|
| 1. Вертикально | больше RAM/CPU; вынести `.data` на быстрый диск; CDN для статики |
| 2. Горизонтально (signaling) | Redis pub/sub для broadcast между инстансами, sticky sessions по комнате (consistent hashing), WS-прокси (Nginx `ip_hash`) |
| 3. Медиа | перейти на SFU: LiveKit (Apache-2.0) или mediasoup; `mediaMode:'sfu'` в комнате, сервер выдаёт SFU-транспорты; TURN остаётся |
| 4. Хранилище | S3/MinIO для файлов/записей, Postgres для метаданных и аудита, объектная ротация |
| 5. Очереди | вынести AI-анализ/STT/вебхуки в воркеры (очередь + ретраи) |
| 6. Мультирегион | региональные кластеры + маршрутизация по гео; данные — по резидентности |

Оценка перехода на SFU и production-объёма — `agil/core/docs/estimate.md` (C1: LiveKit +
свой слой).

## 6. Бэкапы и retention

- `.data/tenants` — конфиги (бэкап ежедневно, маленькие).
- `.data/audit` — append-only JSONL (ротация по размеру, отправка в SIEM).
- `.data/files`, `.data/recordings` — по политике компании; TTL ссылок —
  `AGIL_FILE_TTL_SEC`, удаление через `DELETE /v1/admin/recordings/:id`.
- Расшифровки в Core хранятся по `session.transcription.retentionSec`. Ноль использует серверное значение `AGIL_TRANSCRIPT_RETENTION_SEC`.
- Отчёты, замечания и заметки ИИ-анализа в Core хранятся по `session.aiAgent.retentionMin` (минуты).
- При удалении тенанта — удалить `.data/<tenant>` целиком (процедура описана в
  `agil/core/docs/security.md`).

Бэкапы и восстановление — `agil/core/scripts/backup-data.sh` / `agil/core/scripts/restore-data.sh`
(чек-суммы, retention, S3/MinIO, dry-run); процедура и RPO/RTO — в
[`agil/core/docs/operations.md`](operations.md) §7.

## 7. Чек-лист перед продакшеном

- [ ] TLS-сертификаты, HSTS, WSS работает через прокси
- [ ] TURN/TURNS настроен и проверен на мобильной сети и корпоративном VPN
- [ ] `AGIL_ALLOW_ANONYMOUS=0`, ключи ≥32 символов, секреты в vault
- [ ] Гео-политика и пароли включены для чувствительных тенантов
- [ ] Запись/STT/AI/knowledge — включены осознанно, согласие настроено
- [ ] Вебхуки компании принимают и проверяют подпись; есть dead-letter лог
- [ ] Бэкапы `.data` и проверка восстановления
- [ ] Мониторинг `/v1/health`, алерты на 5xx/рестарты
- [ ] Аудит уходит в SIEM компании
- [ ] Проверены Safari/iOS и корпоративные браузеры (WebRTC-политики)

## 8. Sales/deployment kit (опционально)

Для демо, пилота или установки у заказчика есть отдельный набор
[`agil/infra/`](../../infra/README.md). Он не обязателен для работы AGIL и
ничего не деплоит сам по себе:

- [`agil/infra/quickstart/`](../../infra/quickstart/README.md) — Docker Compose
  `core + node + turn + redis` на одном хосте, `install.sh` (безопасно
  генерирует секреты, проверяет порты/DNS/диск, не трогает чужие
  Caddy/HAProxy/VPN), `doctor.sh`, `smoke.sh`; первый звонок за 15–30 минут;
- [`agil/infra/helm/`](../../infra/helm/README.md) — чарты `agil-core` и
  `agil-node` без обязательных зависимостей (Redis/Postgres/ingress —
  опционально);
- [`agil/infra/terraform/aws/`](../../infra/terraform/aws/README.md) — VPC,
  подсети, security groups, VM, EIP, опциональный Route53; TLS — на вашем
  прокси/ACM;
- [`agil/infra/examples/`](../../infra/examples/README.md) — примеры nginx,
  HAProxy, Caddy, Traefik (TLS/WebSocket/таймауты), без жёсткой зависимости.

Node-токены, порты, обновление/откат, security-модель и ограничения описаны в
[`agil/infra/README.md`](../../infra/README.md). Краткая шпаргалка для продаж —
[`deployment-quickstart.md`](deployment-quickstart.md).
