<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./agil/websdk/demo/public/branding/agil-logo-on-dark.png">
    <img alt="AgilFrame" width="360" src="./agil/websdk/demo/public/branding/agil-logo-on-light.png">
  </picture>
</p>

# AgilFrame

**Встраиваемые видеозвонки, трансляции и голосовые комнаты на WebRTC.** Разверните Core на своей инфраструктуре и добавьте звонок в корпоративный портал, учебную платформу или клиентское приложение.

[Быстрый старт](#быстрый-старт) · [Документация](docs/README.md) · [Интеграция SDK](agil/core/docs/sdk.md) · [Архитектура](agil/core/docs/architecture.md)

## Что внутри

| Компонент | Назначение |
| --- | --- |
| Core | REST и WebSocket, организации, роли, комнаты, чат, аудит и интеграции |
| Web SDK | Готовый виджет, iframe, Web Component и API для своего интерфейса |
| Панель и редактор | Управление организациями, настройками и оформлением звонка |
| Media и Edge | LiveKit SFU, TURN, маршрутизация потоков, HLS, подключаемые запись и SIP |
| Mobile | Интеграционные модули для Android, iOS, Flutter, Capacitor и React Native |
| Ассистенты | MCP, локальные субтитры и перевод, подключение внешнего провайдера |

## Быстрый старт

Понадобятся Node.js 22+ и npm. Запустите команды из корня репозитория.

```sh
npm ci
npm run build
HOST=127.0.0.1 npm start
```

В PowerShell перед запуском выполните `$env:HOST = '127.0.0.1'` и `npm start`.

На `http://localhost:8787/` доступна стартовая страница. Руководство находится на `/wiki/`, каталог API на `/docs`, визуальный редактор на `/editor/`, панель управления на `/dashboard/`.

Для создания комнаты и токенов используйте [первые запросы к API](docs/getting-started/README.md). Встроенные значения для разработки подходят для локального запуска. Для сетевого развёртывания задайте собственные секреты, публичный origin и TLS по [инструкции по развёртыванию](agil/core/docs/deployment.md).

## Структура репозитория

```text
agil/
  core/      Сервер, панель, редактор и общие пакеты
  websdk/    Виджет, SDK и локальные примеры
  mobile/    Интеграционные модули и мобильные примеры
  edge/      Агент и управление медиапотоками
  infra/     Node Agent, Helm, Terraform и примеры развёртывания
docs/        Навигация и инструкции по сценариям
```

## Разработка

После сборки выполните `npm run typecheck`, `npm test` и `node agil/core/scripts/e2e.mjs --only=api`. Для браузерного e2e потребуется установленный Chrome или Edge. Node.js и сервисы для сборки можно запустить в Docker по [руководству](agil/core/docs/deployment-quickstart.md).

## Лицензии

Исходный код AgilFrame доступен на условиях [PolyForm Noncommercial 1.0.0](LICENSE). Для коммерческого использования за пределами этих условий доступна [отдельная лицензия](agil/core/docs/commercial-license.md). При распространении разрешённых копий сохраните [уведомления](NOTICE). У зависимостей, моделей и медиа собственные лицензии. [Подробнее](agil/core/docs/licensing.md)
