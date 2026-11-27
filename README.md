<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./agil/websdk/demo/public/branding/agil-logo-on-dark.png">
    <img alt="AgilFrame" width="360" src="./agil/websdk/demo/public/branding/agil-logo-on-light.png">
  </picture>
</p>

# AgilFrame Core

Русский · [English](README.en.md)

**Сервер для встраиваемых видеозвонков, трансляций и голосовых комнат.** Core управляет комнатами, доступом и настройками организаций. В репозитории также есть панель администратора, редактор звонков и общие пакеты платформы.

[Быстрый старт](#быстрый-старт) · [Руководства](docs/README.md) · [Web SDK](agil/core/docs/sdk.md) · [Доска проекта](https://github.com/users/GillHD/projects/1) · [Как внести вклад](CONTRIBUTING.md)

## Что можно сделать

- **Встроить звонки.** Добавьте готовый веб-виджет в корпоративный портал, учебную платформу или клиентский сервис. Чтобы создать свой интерфейс, используйте Web SDK и API. [Интеграция](docs/integration/README.md)
- **Управлять доступом и оформлением.** Сервер вашего приложения запрашивает у Core короткоживущие токены для участников. Core проверяет права и принадлежность к организации. Темы, доступные функции и интеграции задаются на уровне организации. [Настройка ролей](agil/core/docs/roles.md)
- **Развернуть платформу у себя.** Для локальной разработки и простых звонков можно запустить один Core. По мере необходимости подключайте TURN, LiveKit SFU, серверную запись и SIP. [Развёртывание](agil/core/docs/deployment.md)
- **Проводить эфиры.** Участники общаются через WebRTC, а зрители могут смотреть эфир через HLS при настроенной трансляции. [Медиамаршруты](agil/core/docs/routing.md) · [Плеер HLS](agil/core/docs/hls-viewer.md)

## Быстрый старт

Для полной локальной сборки понадобятся Node.js 22.12 или новее и npm. Соберите проект и запустите Core на локальном интерфейсе.

```sh
git clone https://github.com/GillHD/agilframe-core.git
cd agilframe-core
npm ci
npm run build
HOST=127.0.0.1 npm start
```

В PowerShell замените последнюю строку двумя командами.

```powershell
$env:HOST = '127.0.0.1'
npm start
```

Локальный адрес Core — `http://127.0.0.1:8787`.

| Интерфейс | Путь |
| --- | --- |
| Панель администратора | `/dashboard/` |
| Визуальный редактор звонков | `/editor/` |
| Вики и справочник API | `/wiki/` и `/docs` |
| Пример собственного интерфейса | `/custom-ui.html` |
| Проверка доступности | `/v1/health` |

Откройте панель и войдите с ключом локальной разработки `dev-key`. Создайте комнату, выпустите отдельный токен для каждого из двух участников и откройте ссылки в разных вкладках. При сетевом развёртывании задайте собственные секреты, настройте TLS и список разрешённых источников запросов. [Быстрый старт](docs/getting-started/README.md) · [Пример REST](agil/core/docs/api-guide.md) · [Установка через Docker](agil/core/docs/deployment-quickstart.md)

## Как устроен проект

Приложение создаёт комнаты и запрашивает токены через API Core. Клиенты подключаются к Core для входа, согласования соединения и обмена событиями. Аудио, видео и демонстрация экрана передаются по WebRTC напрямую или через SFU. Медианоды могут принимать внешние потоки, вести запись и обслуживать трансляции. [Архитектура](agil/core/docs/architecture.md)

### Приложения и общие пакеты

Приложения и библиотеки находятся в отдельных пакетах npm с собственными `package.json`. Сборка из корня запускает их через npm workspaces.

| Каталог | Назначение |
| --- | --- |
| [`agil/core/apps/server/`](agil/core/apps/server/) | Core, REST API и WebSocket, управление комнатами, доступом и настройками |
| [`agil/core/apps/dashboard/`](agil/core/apps/dashboard/) | Панель администратора для организаций, ролей и настроек |
| [`agil/core/apps/editor/`](agil/core/apps/editor/) | Визуальный редактор интерфейса звонка |
| [`agil/core/packages/protocol/`](agil/core/packages/protocol/) | Общие типы и контракты платформы |
| [`agil/core/packages/security/`](agil/core/packages/security/) | Общие функции для авторизации и защиты данных |
| [`agil/core/packages/ai/`](agil/core/packages/ai/) | Общие компоненты для функций ИИ |
| [`agil/core/packages/mcp/`](agil/core/packages/mcp/) | MCP-сервер с собственными командами запуска |

### Интеграция и инфраструктура

| Каталог | Назначение |
| --- | --- |
| [`agil/websdk/`](agil/websdk/) | Веб-виджет, iframe, веб-компонент, SDK и локальные примеры |
| [`agil/mobile/`](agil/mobile/) | SDK и модули для Android, iOS, Flutter, Capacitor и React Native |
| [`agil/core/nodes/`](agil/core/nodes/) | Образ медианоды и сервис распознавания речи |
| [`agil/infra/`](agil/infra/) | Node Agent, Helm, Terraform и примеры конфигураций |
| [`agil/edge/`](agil/edge/) | Сквозная проверка публикации Edge через LiveKit |
| [`docs/`](docs/) | Руководства по запуску, интеграции, эксплуатации и выпуску |

### Медианоды

Core назначает медианоды. Node Agent регистрирует узел, передаёт его состояние и выполняет команды Core.

| Модуль ноды | Где находится |
| --- | --- |
| Образ медианоды и Compose | [`agil/core/nodes/all-in-one/`](agil/core/nodes/all-in-one/) |
| Сервис распознавания речи | [`agil/core/nodes/stt/`](agil/core/nodes/stt/) |
| Node Agent и метрики | [`agil/infra/node-agent/`](agil/infra/node-agent/) |
| Helm для Core и нод | [`agil/infra/helm/`](agil/infra/helm/) |

[Установка ноды](agil/core/docs/node-image.md) · [Несколько SFU-нод](agil/core/docs/sfu-multinode.md)

### Репозитории

| Репозиторий | Назначение |
| --- | --- |
| [agilframe](https://github.com/GillHD/agilframe) | Общий каталог проекта и загрузка всех компонентов |
| [agilframe-core](https://github.com/GillHD/agilframe-core) | Core, администрирование, документация и сквозная сборка |
| [agilframe-websdk](https://github.com/GillHD/agilframe-websdk) | Виджет, Web SDK, Web Component, демо и совместимый протокол |
| [agilframe-mobile](https://github.com/GillHD/agilframe-mobile) | Android, iOS, Flutter, Capacitor и React Native |
| [agilframe-nodes](https://github.com/GillHD/agilframe-nodes) | Медианоды, SFU, TURN, Node Agent и образы сервисов обработки медиа |
| [agilframe-edge](https://github.com/GillHD/agilframe-edge) | Агент для передачи медиапотоков со встраиваемых устройств |
| [agilframe-deploy](https://github.com/GillHD/agilframe-deploy) | Docker Compose и инструкции по эксплуатации |
| [agilframe-examples](https://github.com/GillHD/agilframe-examples) | Самостоятельный пример встраивания звонка |

В этом репозитории хранятся интеграционные снимки Web SDK, мобильных компонентов и медианод. Сквозной тест запускает Edge из отдельного репозитория. Версии полного комплекта зафиксированы в общем репозитории. [Манифест версий](https://github.com/GillHD/agilframe/blob/main/versions.json) · [Порядок выпуска](docs/release/repositories.md)

## Куда дальше

- Перед отправкой изменений выполните проверки из руководства. [Как внести вклад](CONTRIBUTING.md)
- Для ошибок и предложений используйте формы GitHub Issues. Об уязвимостях сообщайте приватно. [Создать задачу](https://github.com/GillHD/agilframe-core/issues/new/choose) · [Сообщить об уязвимости](SECURITY.md)

## Лицензия

Собственный код AgilFrame доступен на условиях PolyForm Noncommercial 1.0.0. Коммерческое использование лицензируется отдельно. Для сторонних моделей, зависимостей и медиаматериалов действуют их собственные условия. [Лицензия](LICENSE) · [Коммерческое использование](agil/core/docs/commercial-license.md) · [Уведомления](NOTICE)
