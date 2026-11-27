<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./agil/websdk/demo/public/branding/agil-logo-on-dark.png">
    <img alt="AgilFrame" width="360" src="./agil/websdk/demo/public/branding/agil-logo-on-light.png">
  </picture>
</p>

# AgilFrame

**Встраиваемые видеозвонки, трансляции и голосовые комнаты на WebRTC для своей инфраструктуры.** AgilFrame даёт разработчику сервер, API и готовый интерфейс звонка. Организация выбирает, как выглядит встреча, кто в неё входит и какие данные сохраняются.

[Быстрый старт](#быстрый-старт) · [Руководства](docs/README.md) · [Web SDK](agil/core/docs/sdk.md) · [Проект AgilFrame](https://github.com/users/GillHD/projects/1) · [Как участвовать](CONTRIBUTING.md)

## Зачем использовать AgilFrame

- **Добавить встречи в свой продукт.** Встройте готовый виджет в корпоративный портал, учебную платформу или клиентский сервис. Для полностью собственного интерфейса используйте Web SDK и API.
- **Подключить корпоративные правила.** Сервер вашего приложения выдаёт участникам короткоживущие токены. Core проверяет роль и организацию. Тема, доступные функции и интеграции настраиваются централизованно.
- **Развернуть систему у себя.** Один Core подходит для локальной разработки и простых звонков. TURN, LiveKit SFU, серверная запись, SIP и другие сервисы подключаются по условиям развёртывания.
- **Проводить эфиры.** Участники встреч общаются через WebRTC, а массовую аудиторию можно подключить через HLS. Настройка входов, выходов и медианод описана отдельно. [Маршрутизация](agil/core/docs/routing.md) · [Плеер HLS](agil/core/docs/hls-viewer.md)

## Быстрый старт

Понадобятся Node.js 22+ и npm. Соберите проект и запустите Core на локальном интерфейсе.

```sh
git clone https://github.com/GillHD/agilframe-core.git
cd agilframe
npm ci
npm run build
HOST=127.0.0.1 npm start
```

В PowerShell перед запуском выполните `$env:HOST = '127.0.0.1'` и `npm start`.

| Интерфейс | Адрес на локальном Core |
| --- | --- |
| Стартовая страница | `http://localhost:8787/` |
| Панель управления | `/dashboard/` |
| Визуальный редактор | `/editor/` |
| Wiki и справочник API | `/wiki/` и `/docs` |
| Пример собственного интерфейса | `/custom-ui.html` |
| Проверка доступности | `/v1/health` |

Откройте панель и войдите с локальным ключом `dev-key`. Создайте комнату, выпустите отдельный токен для каждого из двух участников и откройте ссылки в отдельных вкладках. Для интеграции воспользуйтесь [пошаговым примером REST](agil/core/docs/api-guide.md). Для сетевого развёртывания настройте собственные секреты, TLS и разрешённые origin. [Руководство по установке](agil/core/docs/deployment.md) · [Docker](agil/core/docs/deployment-quickstart.md)

## Как устроен проект

Приложение компании обращается к Core по API, чтобы создать комнату и выдать токены. Клиенты используют Core для входа, сигналинга и событий. Аудио, видео и демонстрация экрана идут по WebRTC напрямую или через SFU, в зависимости от конфигурации. Медианоды могут обслуживать входы, запись и трансляцию. [Архитектура](agil/core/docs/architecture.md)

| Папка | Назначение |
| --- | --- |
| [`agil/core/`](agil/core/) | Core, REST и WebSocket, панель, редактор, роли, аудит, MCP и общие пакеты |
| [`agil/websdk/`](agil/websdk/) | Виджет, iframe, Web Component, Web SDK и локальные примеры |
| [`agil/mobile/`](agil/mobile/) | Модули Android, iOS, Flutter, Capacitor и React Native |
| [`agil/edge/`](agil/edge/) | Агент медианоды и управление медиапотоками |
| [`agil/infra/`](agil/infra/) | Node Agent, Helm, Terraform и примеры инфраструктуры |
| [`docs/`](docs/) | Быстрый старт, интеграция, эксплуатация и выпуск |

### Ноды и медиаворкеры

Core назначает медианоды и ведёт их состояние. Node Agent регистрирует машину, сообщает её готовность и принимает команды. Клиенты используют назначенный медиамаршрут.

| Модуль ноды | Где находится |
| --- | --- |
| Образ медианоды и Compose | [`agil/core/nodes/all-in-one/`](agil/core/nodes/all-in-one/) |
| Воркер распознавания речи | [`agil/core/nodes/stt/`](agil/core/nodes/stt/) |
| Node Agent и метрики | [`agil/infra/node-agent/`](agil/infra/node-agent/) |
| Edge-агент для встраиваемых систем | [AgilFrame Edge](https://github.com/GillHD/agilframe-edge) |
| Helm для Core и нод | [`agil/infra/helm/`](agil/infra/helm/) |

[Установка ноды](agil/core/docs/node-image.md) · [Несколько SFU-нод](agil/core/docs/sfu-multinode.md)

### Репозитории

| Репозиторий | Назначение |
| --- | --- |
| [agilframe](https://github.com/GillHD/agilframe) | Общий каталог проекта и загрузка всех компонентов |
| [agilframe-core](https://github.com/GillHD/agilframe-core) | Core, администрирование, документация и сквозная сборка |
| [agilframe-websdk](https://github.com/GillHD/agilframe-websdk) | Виджет, Web SDK, Web Component, демо и совместимый протокол |
| [agilframe-mobile](https://github.com/GillHD/agilframe-mobile) | Android, iOS, Flutter, Capacitor и React Native |
| [agilframe-nodes](https://github.com/GillHD/agilframe-nodes) | Медианоды, Edge, TURN, SFU и воркеры |
| [agilframe-deploy](https://github.com/GillHD/agilframe-deploy) | Docker Compose и инструкции по эксплуатации |
| [agilframe-examples](https://github.com/GillHD/agilframe-examples) | Самостоятельный пример встраивания звонка |

[Проект AgilFrame](https://github.com/users/GillHD/projects/1) связывает репозитории. [План публикации и совместимость](docs/release/repositories.md)

## Куда дальше

- **Разработка и review.** Прочитайте [правила вкладов](CONTRIBUTING.md). Основные команды проверки приведены там же.
- **Ошибки и предложения.** Используйте [формы Issues](https://github.com/GillHD/agilframe-core/issues/new/choose). Для уязвимостей предусмотрен [приватный канал](SECURITY.md).
- **Лицензирование.** Собственный код AgilFrame доступен по [PolyForm Noncommercial 1.0.0](LICENSE). Коммерческие права оформляются [отдельно](agil/core/docs/commercial-license.md). У сторонних моделей, зависимостей и медиа свои условия. [Уведомления](NOTICE)
