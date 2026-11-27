# AgilFrame — задачи на бесплатных/open-source решениях

Дата: 16.11.2026. Цель: максимум функций сделать и проверить локально без
платных API, транков, CDN и проприетарных сервисов. Для каждой задачи указано,
что остаётся внешним.

## Лицензии — важное

| Компонент | Лицензия | Комментарий |
|---|---|---|
| LiveKit server / Egress / SIP | Apache-2.0 | можно коммерчески |
| coturn | BSD-3-Clause | можно |
| Valkey (форк Redis) | BSD-3-Clause | использовать вместо Redis 7 (RSAL/SSPL) |
| PostgreSQL | PostgreSQL License | можно |
| MinIO | AGPL-3.0 | copyleft; для продажи учесть обязательства, альтернатива SeaweedFS (Apache-2.0) |
| Caddy / nginx / HAProxy / Traefik | Apache-2.0 / BSD / GPLv2 / MIT | Caddy проще для TLS |
| Keycloak | Apache-2.0 | OIDC/SAML IdP для тестов |
| Whisper / whisper.cpp / faster-whisper / CTranslate2 | MIT | локальная речь |
| OPUS-MT (Helsinki-NLP) | CC BY 4.0 для ru-en, Apache-2.0 для en-ru | коммерчески с соблюдением [условий каждой модели](model-licenses.md) |
| NLLB-200 | CC-BY-NC-4.0 | **не для коммерческого продукта** |
| Marian | MIT | можно |
| MediaPipe / OpenCV | Apache-2.0 | liveness/фон |
| ClamAV | GPLv2 | отдельный контейнер/процесс |
| YARA | BSD-3-Clause | правила |
| Asterisk / FreeSWITCH | GPLv2 / MPL-1.1 | SIP-лаб |
| Mailpit | MIT | SMTP-тест |
| Playwright / Puppeteer | Apache-2.0 | нагрузка/браузеры |
| k6 | AGPL-3.0 | нагрузка |
| Varnish / Apache Traffic Server / nginx | BSD / Apache-2.0 / BSD | локальный CDN-кэш |
| OpenTofu | MPL-2.0 | замена Terraform (BUSL) |
| Helm / Kubernetes | Apache-2.0 | можно |
| Prometheus / Grafana / Loki | Apache-2.0 / AGPL-3.0 / AGPL-3.0 | мониторинг |
| restic / rclone | BSD / MIT | бэкапы |
| RNNoise | BSD-3-Clause | шумоподавление |

---

## P1-local: можно сделать сейчас

### 1. All-in-one node image

**Стек:** LiveKit (Apache-2.0) + coturn (BSD) + Node agent + Docker.
**Сделать:** один образ/роль, `NODE_FEATURES=sfu,turn,stun`, host-network,
health, регистрация/heartbeat, drain, ротация ключей.
**Статус:** сделано в `agil/core/nodes/all-in-one/` (Dockerfile, compose,
agent, feature toggles, тесты `npm run test:node-image`); см.
`agil/core/docs/node-image.md`. Осталась живая приёмка на Linux-хосте с
публичным IPv4 (Docker build, 3 комнаты, TURN relay/TLS).
**Проверка:** Docker build, compose config, 1 нода + 3 комнаты, TURN relay.
**Оценка:** 2–3 недели.
**Внешнее:** публичные IP, DNS, боевые хосты.

### 2. Leader election / failover Core

**Стек:** Valkey (BSD) lease + PostgreSQL (опционально), Node.
**Сделать:** `SET NX PX`, renewal, leader/standby, 409 для standby, панель,
failover на двух процессах, split-brain тест.
**Проверка:** убить лидера, standby берёт lease, мутации идут.
**Оценка:** 2–4 недели.
**Внешнее:** managed Valkey/Postgres и 2+ хоста для продакшена.

### 3. Egress worker + S3 + signed HLS

**Стек:** LiveKit Egress (Apache-2.0), MinIO (AGPL) или SeaweedFS (Apache-2.0),
HLS.js (Apache-2.0).
**Сделать:** worker, S3 upload, HMAC-подпись HLS, TTL, retention, health.
**Проверка:** MP4/HLS/RTMP локально, expired URL 403, S3-объект на месте.
**Оценка:** 1–2 недели.
**Внешнее:** реальный S3/CDN и отдельный worker-хост.

### 4. STT v2 + перевод (локальные модели)

**Стек:** whisper.cpp/faster-whisper (MIT), CTranslate2 (MIT), OPUS-MT/Marian
(CC BY 4.0 / Apache-2.0), без NLLB-NC.
**Сделать:** adapter `STT_PROVIDER=local`, streaming/chunked, RU/EN, timestamps,
перевод, consent/retention, панель транскрипта.
**Проверка:** короткий RU/EN fixture, задержка, точность, отсутствие утечки.
**Оценка:** 2–4 недели.
**Внешнее:** GPU/CPU-ресурсы, качество моделей, лицензии моделей.

### 5. Liveness + AV (open-source baseline)

**Стек:** MediaPipe/OpenCV (Apache-2.0), ClamAV (GPLv2), YARA (BSD).
**Сделать:** blink/motion challenge, optional anti-spoof model, ClamAV-скан
загрузок, quarantine, audit; EICAR-тест.
**Проверка:** EICAR блокируется, ложные срабатывания, timeout/fail-open.
**Оценка:** 2–4 недели.
**Внешнее:** сертифицированный anti-deepfake, тяжёлые ML-модели.

### 6. SIP local lab

**Стек:** LiveKit SIP (Apache-2.0), Asterisk (GPLv2) или FreeSWITCH (MPL),
Linphone (GPLv3).
**Сделать:** local trunk, dial-in/out, RTP, DTMF, list/stop, trunk-down 502,
E2EE 409; docs.
**Проверка:** реальный INVITE/200/ACK и аудио между двумя softphone.
**Оценка:** 1–2 недели.
**Внешнее:** реальный транк/DID/оператор.

### 7. SAML через Keycloak

**Стек:** Keycloak (Apache-2.0), `@node-saml/node-saml` (MIT).
**Сделать:** SP metadata, ACS, подпись, маппинг ролей, tenant IdP.
**Проверка:** локальный Keycloak, login, logout, wrong audience.
**Оценка:** 1–2 недели.
**Внешнее:** IdP заказчика, сертификаты.

### 8. Уведомления (SMTP/Telegram)

**Стек:** Mailpit (MIT) для теста, Postfix (open source), Telegram Bot API
(бесплатный, но токен).
**Сделать:** email-приглашения, Telegram-уведомления, шаблоны, retry.
**Проверка:** Mailpit inbox, Telegram test chat.
**Оценка:** 3–5 дней.
**Внешнее:** SMTP-релей/домен, бот-токен.

### 9. Авто-TLS кастомных доменов

**Стек:** Caddy (Apache-2.0), Pebble (Apache-2.0) для теста ACME.
**Сделать:** on-demand TLS, DNS-01/HTTP-01, allowlist домена, статус.
**Проверка:** Pebble выдаёт сертификат, неверный домен 403.
**Оценка:** 3–5 дней.
**Внешнее:** реальный DNS/ACME и edge-сервер.

### 10. Локальный CDN-кэш для HLS

**Стек:** Varnish (BSD) или Apache Traffic Server (Apache-2.0), nginx (BSD).
**Сделать:** кэш HLS-сегментов, purge, TTL, подпись URL, health.
**Проверка:** cache HIT/MISS, 10 зрителей через кэш.
**Оценка:** 1 неделя.
**Внешнее:** глобальный CDN и edge-присутствие.

### 11. Шумоподавление + замена фона

**Стек:** RNNoise (BSD), MediaPipe Selfie Segmentation (Apache-2.0).
**Сделать:** RNNoise WASM в audio pipeline; замена фона (не только blur).
**Проверка:** запись с шумом/без, CPU, фон.
**Оценка:** 1–2 недели.
**Внешнее:** ничего, кроме моделей.

### 12. Remote control

**Стек:** браузерные события + WebSocket, без библиотек.
**Сделать:** pointer/scroll/next-slide, grant/revoke, audit, UI.
**Проверка:** два браузера, гость без прав 403.
**Оценка:** 5–10 дней.

### 13. Календарь/ICS

**Стек:** генератор ICS (свой), Google/Outlook links.
**Сделать:** `VEVENT`, TZ, ORGANIZER, URL, кнопка.
**Проверка:** импорт в Google/Outlook.
**Оценка:** 1–2 дня.

### 14. Screen share со звуком

**Стек:** `getDisplayMedia({audio:true})`, Web Audio API.
**Сделать:** микс с микрофоном, mute, индикатор, SFU publish.
**Проверка:** Chrome/Edge, видео+звук.
**Оценка:** 2–4 дня.

### 15. Simulcast/SVC

**Стек:** LiveKit simulcast (VP8/H264).
**Сделать:** слои, adaptiveStream, ручной режим экономии.
**Проверка:** 3 сетевых профиля, переключение слоёв.
**Оценка:** 3–5 дней.

### 16. EN-локализация dashboard/editor

**Стек:** собственные словари, Intl.
**Сделать:** ~2 500 строк, плюрализация, даты, `?lang=en`.
**Проверка:** 0 missing keys, 0 Cyrillic в EN.
**Оценка:** 5–10 дней.

### 17. WCAG вручную

**Стек:** NVDA/VoiceOver, axe-core, Playwright.
**Сделать:** login/room/chat/settings, 400%, High Contrast, captions.
**Проверка:** 0 critical, фокус, имена.
**Оценка:** 3–5 дней.

### 18. Водяные знаки + DLP

**Стек:** Canvas, regex/PII, ClamAV (опционально).
**Сделать:** watermark на recording/share, DLP-блок, аудит.
**Проверка:** watermark на записи, гость не отключает.
**Оценка:** 3–5 дней.

### 19. E2EE mesh

**Стек:** Insertable Streams/Encoded Transform (браузер).
**Сделать:** ключ через signaling, шифрование mesh, badge, ограничения.
**Проверка:** 2 браузера, remote video, ключ не в логах.
**Оценка:** 5–10 дней.

### 20. 50+ soak и TURN cross-network

**Стек:** Playwright/k6 (open source), Linux netns.
**Сделать:** 50 браузерных контекстов, 2 сети, метрики, TURN relay.
**Проверка:** 0 drops, CPU/RAM, отчёт.
**Оценка:** 1–2 недели.
**Внешнее:** разные физические сети/хосты.

### 21. Детекция шума в микрофоне

**Стек:** Web Audio API (`AnalyserNode`, RMS/спектральная плоскостность), без внешних зависимостей.
**Сделать:** локальный анализ микрофона, noise floor/SNR, предупреждение «слишком шумно»,
подсказка «наденьте гарнитуру / включите шумоподавление», порог и гистерезис, не чаще
раза в N секунд; отключаемо флагом `noiseDetection`; не отправлять аудио на сервер.
**Проверка:** синтетические буферы (тишина/шум/речь), нет ложных срабатываний,
работает при выключенном микрофоне, i18n RU/EN.
**Оценка:** 2–3 дня.
**Внешнее:** ничего.

### 22. Бэкапы и мониторинг

**Стек:** restic (BSD), rclone (MIT), Prometheus/Grafana/Loki.
**Сделать:** S3-бэкап, restore drill, дашборды, алерты.
**Проверка:** restore, RPO/RTO.
**Оценка:** 3–5 дней.

---

## P2: без внешнего ресурса не закрыть

| Задача | Что нужно |
|---|---|
| Native release iOS/Android/Flutter | macOS/Xcode, Android 35, устройства, подписи |
| Платежи/подписки | эквайринг, вебхуки, налоги |
| Глобальный CDN | CDN-провайдер/edge |
| Реальный SIP/PSTN | транк, DID, оператор |
| Managed HA | 2+ хоста, managed Valkey/Postgres |
| SAML с IdP заказчика | IdP, сертификаты |
| Email-доставляемость | SMTP-релей/домен |
| Сертифицированный liveness | вендор/модель, аудит |
| GPU для STT | GPU/CPU-ресурсы |
| Live AWS/K8s | аккаунт, кластер, DNS |

## Приоритет

1. P1-local 1–3: node image, HA, egress/S3 — без них нет масштаба.
2. P1-local 4–6: STT, liveness/AV, SIP-лаб — паритет.
3. P1-local 12–19: remote/ICS/screen/simulcast/i18n/WCAG/watermark/E2EE.
4. P2 — после первых продаж/пилотов.
