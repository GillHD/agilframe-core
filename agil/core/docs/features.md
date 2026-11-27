# AgilFrame — матрица фич и паритет с конкурентами

> Сводная матрица: что есть у Jitsi Meet, Яндекс Телемоста, Zoom, Microsoft Teams,
> Google Meet и open-source стека Daily/LiveKit, и где по этому пункту находится AgilFrame.
>
> Связанные документы: `agil/core/docs/reverse-engineering.md`
> (разбор архитектуры и лицензий), `agil/core/docs/estimate.md` (сроки),
> [`agil/core/docs/contract.md`](./contract.md) (реальный API/флаги в коде).
>
> Легенда конкурентов: ✅ есть · ⚠️ частично / только в платных тарифах / с ограничениями ·
> ❌ нет · ❓ не подтверждено публичной документацией.
>
> Легенда AGIL: **✅ MVP** — реализовано или в текущем MVP-объёме ·
> **🟡 roadmap** — заложено флагом/схемой, реализация позже · **⛔** — не планируется.
>
> ⚠️ Матрица описывает **наличие механики**, а не её качество. Детали у вендоров
> меняются от тарифа к тарифу; спорные пункты помечены ❓ и требуют проверки перед
> использованием в продающих материалах.

---

## 1. Как матрица связана с кодом

| Слой конфигурации | Где в коде | Что покрывает |
|-------------------|-----------|----------------|
| `config.features.*` | `agil/core/packages/protocol/src/config.ts` → `featureFlagsSchema` | 39 булевых флагов: чат, файлы, экран, запись, AI, breakout, опросы и т.д. |
| `config.security.*` | там же, `securitySchema` | E2EE, пароль, лобби, гео, аудит, mediaIntegrity (deepfake), sessionBinding |
| `config.session.*` | там же, `sessionSchema` | Запись, транскрипция, файлы, шаринг экрана, виртуальные фоны |
| `config.aiAgent.*` | `agil/core/packages/protocol/src/compliance.ts` | Режим AI (local/external/hybrid), политики, findings, выдержки, meeting notes |

Пример включения фич на тенанта:

```json
{
  "features": { "recording": true, "captions": true, "waitingRoom": true, "aiAssistant": true },
  "security": { "passwordRequired": true, "e2ee": false, "auditLog": true,
                "geo": { "enabled": true, "allowedCountries": ["RU", "BY", "KZ"], "blockVpn": true } },
  "session": { "recording": { "enabled": true, "consentRequired": true, "notifyParticipants": true } },
  "aiAgent": { "enabled": true, "mode": "hybrid", "sendTranscripts": true, "sendChat": false }
}
```

Правило продукта: **флаг включён → фича видима в UI и доступна в API; флаг выключен →
UI не показывает фичу** (или показывает бейдж «скоро»), но API отдаёт полный контракт.

---

## 2. Звонок, медиа и качество

| # | Фича | Jitsi | Телемост | Zoom | Teams | Meet | Daily/LiveKit | AGIL | Флаг |
|---|------|-------|----------|------|-------|------|----------------|------|------|
| 1 | Звонок 1:1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | — |
| 2 | Групповой звонок (mesh 2–8) | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ (SFU по умолчанию) | ✅ MVP | `limits.maxParticipants` |
| 3 | Групповой звонок 50+ (SFU) | ✅ | ⚠️ лимит по тарифу | ✅ | ✅ | ✅ | ✅ | 🟡 roadmap | — |
| 4 | Simulcast / SVC | ✅ | ❓ | ✅ | ✅ | ✅ | ✅ | 🟡 roadmap | — |
| 5 | Кодеки VP8/VP9/H.264/AV1 | ✅ | ❓ | ✅ | ✅ | ✅ | ✅ | 🟡 (VP8/H.264 в MVP) | `audio.codecs` |
| 6 | Демонстрация экрана | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `screenShare` |
| 7 | Шаринг системного звука | ⚠️ | ❓ | ✅ | ✅ | ⚠️ | ✅ | 🟡 roadmap | `session.screenShare.shareAudio` |
| 8 | Аннотации поверх шаринга | ⚠️ | ❓ | ✅ | ✅ | ✅ | ❌ | ✅ P2 (опционально, off по умолчанию) | `annotations` |
| 9 | Whiteboard / доска | ❌ | ❓ | ✅ | ✅ | ✅ | ❌ | ✅ P2 (опционально, off по умолчанию) | `whiteboard` |
| 10 | Автокадрирование (auto framing) | ❌ | ❓ | ✅ | ✅ | ⚠️ | ❌ | 🟡 roadmap | `autoFraming` |
| 11 | Улучшение при плохом свете | ❌ | ❓ | ✅ | ✅ | ⚠️ | ❌ | 🟡 roadmap | `lowLightEnhancement` |
| 12 | Выделение активного спикера (spotlight) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `speakerSpotlight` |
| 13 | Картинка-в-картинке (PiP) | ⚠️ | ❓ | ✅ | ✅ | ✅ | ⚠️ | ✅ MVP | `pictureInPicture` |
| 14 | Полноэкранный режим | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `fullscreen` |
| 15 | Закрепление плитки (pin) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `gridPinning` |
| 16 | Блюр фона | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ (SDK) | ✅ MVP | `backgroundBlur` |
| 17 | Замена фона | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ (SDK) | ✅ MVP | `backgroundReplace` |
| 18 | Шумоподавление | ✅ (RNNoise) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `noiseSuppression` |
| 18a | Детекция шума и предупреждение «слишком шумно» | ❓ | ❓ | ⚠️ | ❓ | ❓ | ❓ | ✅ P1 (флаг off по умолчанию) | `noiseDetection` |
| 19 | Эхоподавление / AGC | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `audio.echoCancellation` |
| 20 | Режим низкой полосы (fallback) | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ MVP | `lowBandwidthFallback` |
| 21 | Статистика соединения (панель) | ⚠️ | ❓ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ MVP | `statsPanel` |
| 22 | Выбор устройств | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `deviceSettings` |

## 3. Безопасность и управление доступом

| # | Фича | Jitsi | Телемост | Zoom | Teams | Meet | Daily/LiveKit | AGIL | Флаг |
|---|------|-------|----------|------|-------|------|----------------|------|------|
| 23 | Пароль комнаты | ✅ | ✅ | ✅ (passcode) | ⚠️ | ⚠️ | ⚠️ (свой) | ✅ MVP | `security.passwordRequired` |
| 24 | Лобби / комната ожидания | ✅ | ✅ | ✅ | ✅ | ✅ (knock) | ⚠️ (свой) | ✅ MVP | `waitingRoom`, `security.waitingRoom` |
| 25 | Блокировка комнаты | ✅ | ❓ | ✅ | ✅ | ✅ | ❌ | ✅ MVP | `security.lockRoom` |
| 26 | Роли host / moderator / guest | ✅ | ✅ (соорганизаторы) | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `security.accessPolicy` |
| 27 | Mute all / управление медиа | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ (API) | ✅ MVP | — |
| 28 | JWT-авторизация | ✅ | ✅ (OAuth для API) | ⚠️ (ZAK) | ⚠️ | ⚠️ | ✅ | ✅ MVP | `security.requireToken`, `token.ts` |
| 29 | E2EE | ✅ (Insertable Streams) | ❓ | ✅ (с ограничениями) | ✅ (Premium для встреч) | ✅ (CSE, Enterprise Plus) | ✅ | 🟡 roadmap | `security.e2ee` |
| 30 | Гео-ограничения (страны/VPN) | ❌ | ❓ | ❓ | ❓ | ❓ | ⚠️ (инфра) | 🟡 roadmap | `security.geo.*` |
| 31 | Аудит-лог действий | ⚠️ (логи сервера) | ❓ | ✅ | ✅ (Purview) | ✅ | ⚠️ (логи) | ✅ MVP | `security.auditLog` |
| 32 | DLP (правила по контенту) | ❌ | ❓ | ⚠️ | ✅ (Purview) | ⚠️ | ❌ | 🟡 roadmap | `aiCompliance` |
| 33 | Водяные знаки на записи/шаринге | ❌ | ❓ | ✅ | ✅ (Premium) | ❌ | ❌ | 🟡 roadmap | — |
| 34 | Согласие на запись | ⚠️ | ❓ | ✅ | ✅ | ✅ | ⚠️ | ✅ MVP | `session.recording.consentRequired` |
| 35 | Session binding (IP/устройство) | ❌ | ❓ | ⚠️ | ⚠️ | ❌ | ❌ | 🟡 roadmap | `security.sessionBinding` |
| 36 | SSO / SCIM | ⚠️ (JWT/IdP) | ✅ (Яндекс 360) | ✅ | ✅ | ✅ | ⚠️ | 🟡 roadmap | — |
| 37 | Liveness / анти-дипфейк | ❌ | ❓ | ❓ | ❓ | ❓ | ❌ | 🟡 roadmap | `security.mediaIntegrity.*` |

## 4. Совместная работа и контент

| # | Фича | Jitsi | Телемост | Zoom | Teams | Meet | Daily/LiveKit | AGIL | Флаг |
|---|------|-------|----------|------|-------|------|----------------|------|------|
| 38 | Текстовый чат | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `chat` |
| 39 | История чата при входе | ⚠️ | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ (свой) | ✅ MVP | `chatHistoryOnJoin` |
| 40 | Чат при плохой связи (fallback) | ❌ (data channel) | ❓ | ⚠️ | ⚠️ | ⚠️ | ❌ | ✅ MVP | `lowBandwidthFallback`, `fallback.lowBandwidth.chatOverSignaling` |
| 41 | Передача файлов | ⚠️ | ⚠️ | ⚠️ (в чате) | ✅ (SharePoint) | ⚠️ | ❌ | ✅ MVP | `fileShare`, `session.fileShare` |
| 42 | Реакции | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ (свой) | ✅ MVP | `reactions` |
| 43 | Поднятая рука | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ (свой) | ✅ MVP | `handRaise` |
| 44 | Список участников | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `participantList` |
| 45 | Опросы | ✅ (в части сборок) | ❓ | ✅ | ✅ | ✅ | ❌ | 🟡 roadmap | `polls` |
| 46 | Q&A-режим | ⚠️ | ❓ | ✅ | ✅ | ✅ | ❌ | 🟡 roadmap | — |
| 47 | Breakout rooms | ✅ | ❓ | ✅ | ✅ | ✅ | ❌ | 🟡 roadmap | `breakoutRooms` |
| 48 | Заметки встречи (notes) | ⚠️ | ❓ | ✅ (AI Notes) | ✅ (Loop) | ✅ (Docs) | ❌ | 🟡 roadmap | `meetingNotes` |
| 49 | Субтитры (live captions) | ✅ | ✅ (транскрипт) | ✅ | ✅ | ✅ | ⚠️ (STT-сервис) | 🟡 roadmap | `captions`, `session.transcription` |
| 50 | Перевод субтитров/речи | ❌ | ❓ | ✅ | ✅ | ✅ | ⚠️ (свой) | 🟡 roadmap | `translation` |
| 51 | Удалённое управление | ✅ | ❓ | ✅ | ⚠️ | ❌ | ❌ | 🟡 roadmap | `remoteControl` |
| 52 | Таймер встречи | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ✅ MVP | `layout.showTimer` |

## 5. Запись, AI и комплаенс

| # | Фича | Jitsi | Телемост | Zoom | Teams | Meet | Daily/LiveKit | AGIL | Флаг |
|---|------|-------|----------|------|-------|------|----------------|------|------|
| 53 | Локальная запись (client-side) | ✅ | ✅ (на компьютер) | ✅ | ⚠️ | ⚠️ | ✅ (MediaRecorder) | ✅ MVP | `recording`, `session.recording` |
| 54 | Облачная запись / egress | ✅ (Jibri) | ✅ (облачная) | ✅ | ✅ | ✅ | ✅ (egress) | 🟡 roadmap | `session.recording.storeOnServer` |
| 55 | Live-стриминг (RTMP/HLS) | ⚠️ (Jibri) | ✅ | ✅ | ✅ | ✅ | ✅ (egress) | 🟡 roadmap | `liveStreaming` |
| 56 | Транскрипт (STT) | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ (сервис) | ✅ MVP (batch) | `session.transcription` |
| 57 | AI-ассистент (summary, Q&A по встрече) | ❌ | ⚠️ (суммаризация) | ✅ (AI Companion) | ✅ (Copilot) | ✅ (Gemini) | ⚠️ (Agents) | ✅ MVP (baseline) | `aiAssistant`, `aiAgent.enabled` |
| 58 | Action items / решения / риски | ❌ | ❓ | ✅ | ✅ | ✅ | ❌ | ✅ MVP | `meetingNotes` |
| 59 | Поиск по выдержкам | ❌ | ❓ | ✅ | ✅ | ✅ | ❌ | 🟡 roadmap | — |
| 60 | Compliance-детекторы (PII/фразы) | ❌ | ❓ | ⚠️ | ✅ (Purview) | ⚠️ | ❌ | ✅ MVP (правила) | `aiCompliance`, `aiAgent.policyRules` |
| 61 | Внешний AI-провайдер (hybrid) | ❌ | ❓ | ⚠️ | ⚠️ | ⚠️ | ✅ (Agents) | ✅ MVP | `aiAgent.mode` |
| 62 | MCP-сервер для нейросетей | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ (Agents-only) | ✅ MVP | — (`agil/core/packages/mcp`) |
| 63 | C2PA-провенанс записей | ❌ | ❓ | ❌ | ❌ | ❌ | ❌ | 🟡 roadmap (дифференциатор) | — |

## 6. Интеграции, платформы и админка

| # | Фича | Jitsi | Телемост | Zoom | Teams | Meet | Daily/LiveKit | AGIL | Флаг |
|---|------|-------|----------|------|-------|------|----------------|------|------|
| 64 | iframe/JS-встраивание | ✅ | ❌ (только ссылки) | ⚠️ (SDK/iframe) | ⚠️ | ❌ | ⚠️ (SDK) | ✅ MVP | — (`agil/websdk/widget`) |
| 65 | Публичный REST API | ⚠️ (self-host) | ✅ (Яндекс 360) | ✅ | ✅ (Graph) | ✅ | ✅ | ✅ MVP | — (`/v1/*`) |
| 66 | Webhooks | ⚠️ | ⚠️ | ✅ | ✅ (Graph) | ✅ | ✅ | ✅ MVP | — |
| 67 | SIP / телефонный дозвон | ✅ (Jigasi) | ⚠️ (телефония) | ✅ | ✅ | ⚠️ | ✅ (SIP) | 🟡 roadmap | `sipDialIn` |
| 68 | Интеграция с календарём | ❌ | ✅ (Яндекс 360) | ✅ | ✅ | ✅ | ⚠️ | 🟡 roadmap | `calendarIntegration` |
| 69 | Мобильные SDK (iOS/Android) | ✅ | ❓ (приложения, SDK нет) | ✅ | ⚠️ | ✅ | ✅ | 🟡 roadmap | — |
| 70 | Вебинарный режим | ⚠️ | ✅ (трансляции) | ✅ | ✅ | ✅ | ⚠️ | 🟡 roadmap | `webinarMode` |
| 71 | Рантайм-темы и брендинг | ⚠️ (сборка/JaaS) | ❌ | ⚠️ | ⚠️ | ⚠️ | ⚠️ (CSS-переменные) | ✅ MVP | `theme` (не флаг, секция конфига) |
| 72 | Визуальный редактор панели | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ MVP | — (`agil/core/apps/editor`) |
| 73 | Панель разработчика (dashboard) | ❌ | ⚠️ (админка 360) | ✅ | ✅ | ✅ | ✅ | ✅ MVP | — (`agil/core/apps/dashboard`) |
| 74 | Метрики QoS / usage | ⚠️ (Prometheus) | ❓ | ✅ | ✅ | ✅ | ✅ | 🟡 roadmap | — |
| 75 | Экспорт аудита в SIEM | ❌ | ❓ | ✅ | ✅ | ✅ | ⚠️ | 🟡 roadmap | `security.auditLog` |
| 76 | Мультитенантность | ⚠️ (инстанс) | ✅ (организации) | ✅ | ✅ | ✅ | ⚠️ (Cloud) | ✅ MVP | `tenantId` |
| 77 | Keyboard shortcuts | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ✅ MVP | `keyboardShortcuts` |
| 78 | Приглашения по ссылке | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | `inviteLink` |
| 79 | Общие/групповые звонки (комнаты) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP | — |
| 80 | Запись чата в экспорт | ⚠️ | ❓ | ✅ | ✅ | ✅ | ⚠️ | 🟡 roadmap | `session.recording.includeChat` |

---

## 7. Сводка по статусам

| Статус AGIL | Кол-во фич | Доля |
|-------------|-----------|------|
| ✅ MVP | 48 | 60% |
| 🟡 roadmap | 32 | 40% |
| ⛔ не планируется | 0 | 0% |
| **Всего** | **80** | 100% |

Почему ни одна фича не «не планируется»: продукт позиционируется как «паритет
с Telemost/Zoom по базе + дифференциация по API/темам/MCP». Даже дорогие пункты
(SIP, вебинары, on-prem-оператор) остаются в roadmap как опции по запросу
заказчика — их цена учтена в `agil/core/docs/estimate.md` как отдельные этапы, а не
«размазана» по MVP. Whiteboard и аннотации поверх шаринга уже реализованы как
**P2-опции** (флаги `whiteboard`/`annotations`, по умолчанию off) — см.
[agil/core/docs/whiteboard.md](whiteboard.md).

## 8. Приоритеты roadmap (по влиянию на сделку)

| Волна | Фичи | Зачем |
|-------|------|-------|
| **1. Сразу после MVP** | E2EE, облачная запись/egress, live-стриминг, метрики QoS/usage | Без этого не выиграть enterprise-тендер |
| **2. Средний срок** | Субтитры/перевод, AI-поиск по выдержкам, breakout rooms, опросы, календарь | Массовый B2B-функционал |
| **3. Долгий срок** | SIP/телефония, мобильные SDK, вебинары, C2PA, deepfake-детект | Дифференциация и крупные контракты |

## 9. Чего у конкурентов нет (наш дифференциатор)

| Возможность | Комментарий |
|-------------|-------------|
| **MCP-сервер для AI-настройки платформы** | Ни у одного из шести вендоров нет MCP для администрирования (у LiveKit Agents — только MCP внутри звонка) |
| **Рантайм-темизация под бренд клиента** | Jitsi — только сборка/JaaS, Zoom — ограниченно, Daily — темы Prebuilt |
| **Визуальный редактор панели** | Нет ни у кого из списка |
| **Чат, независимый от медиа** | У большинства чат на data channel и умирает вместе с медиа |
| **Self-hosted 152-ФЗ-контур с MCP** | Комбинация «on-prem + AI-админка + открытые API» уникальна |
| **C2PA-провенанс записей** | Пока никто публично не заявил (ниша, roadmap) |

## 10. Что проверить перед использованием в продажах

1. Точные лимиты участников у Телемоста по тарифам (меняются, **не подтверждено**).
2. Наличие/условия E2EE у Телемоста — публично не документировано (**не подтверждено**).
3. Функции Zoom AI Companion по тарифам — названия и состав менялись в 2026.
4. Требования лицензий Teams Premium / Workspace Gemini — меняются поквартально.
5. Пункты, помеченные ❓ в таблицах, — не выносить в маркетинг без ссылки на доку.
