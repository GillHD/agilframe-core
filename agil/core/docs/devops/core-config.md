# Конфигурация Core для Docker и Kubernetes

После ревью исправлены путь контекста сборки quickstart, привязка `AGIL_DATA_DIR` к постоянному тому и обработка `geoHeaderAllow=false` в Helm. Повторный рендер Helm подтвердил `AGIL_DATA_DIR=/srv/core-data` при нестандартном пути и `AGIL_GEO_HEADER_ALLOW=0`. Таблица ниже фиксирует состояние, которое обнаружили при проверке.

Ревью рабочей копии 27 ноября 2026. Публичная конфигурация в этом документе означает конфигурацию без секретов, доступную команде эксплуатации для ревью. Файл остаётся внутри среды развёртывания. Ниже приведён проект формата и план миграции.

## Текущее состояние

| Путь | Как Core получает настройки | Что нашли |
|---|---|---|
| Compose из корня | Образ собирается из корня. `.env` передаётся целиком через `env_file`, часть переменных дополнительно задаётся в `environment`. Core опубликован на loopback. Внутри контейнера процесс по умолчанию слушает `0.0.0.0:8787`. Данные хранятся в томе `agil-data`. | При отсутствии непустого `AGIL_ALLOW_ANONYMOUS` Compose подставляет `1`, в образце явно стоит `0`. `env_file` передаёт Core и параметры coturn, а пароль coturn попадает в аргументы контейнера. В production эти источники надо разделить. [Compose](../../../../docker-compose.yml) · [Dockerfile](../../../../Dockerfile) · [Приоритет Compose](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/) |
| Quickstart на VM | Umbrella Compose включает Core/Redis и Node/TURN. Инсталлятор создаёт `.env` с правами `0600`, валидирует Compose, по запросу запускает компоненты, ждёт health и выдаёт enrollment token. Core и coturn получают отдельные списки переменных. | **P1.** `build.context: ../..` из `agil/infra/quickstart` указывает на каталог `agil/`. В нём нет корневых Dockerfile и lockfile. `install.sh --start` явно вызывает `docker compose build core`. Нужен контекст корня либо отдельный сценарий с готовым образом, который не запускает сборку. Формат синтаксически валиден, поэтому нужна проверка путей сборки. [Core Compose](../../../infra/quickstart/docker-compose.core.yml#L28) · [Вызов сборки](../../../infra/quickstart/install.sh#L587) · [Quickstart](../../../infra/quickstart/README.md) |
| Helm Core | ConfigMap и Secret входят через `envFrom`. `extraEnvFrom` и `extraEnv` дают дополнительные источники. По умолчанию один Pod, `Recreate`, PVC и TCP Service на внутренний порт 8787. Ingress и TLS задаются отдельно. | **P1.** При пользовательском `persistence.mountPath` ConfigMap продолжает указывать `AGIL_DATA_DIR=/app/.data`, поэтому Core работает по другому пути. **P2.** Явный `geoHeaderAllow=false` превращается в `1`. Оба результата подтверждены рендером. Для GitOps использовать `secrets.existingSecret`, а обновление внешнего Secret связывать с контролируемым rollout. [ConfigMap](../../../infra/helm/agil-core/templates/configmap.yaml) · [Deployment](../../../infra/helm/agil-core/templates/deployment.yaml) · [Helm values](../../../infra/helm/agil-core/values.yaml) |
| Runtime Core | `loadEnv` читает env при старте, обрабатывает известные переменные и применяет явные программные overrides последними. Относительные пути разрешаются в коде. Ссылки на секреты tenant разрешаются из снимка env с allowlist. | Нет общего стартового файла и универсального интерфейса чтения секретов из файлов. Некоторые неверные значения уходят в defaults, а произвольная строка `AGIL_PUBLIC_ORIGIN` принимается. Критические параметры production нуждаются в строгом preflight. [Env Core](../../apps/server/src/env.ts#L614) · [Ссылки на секреты](../../apps/server/src/secret-env.ts) |

Dockerfile использует `node:23-alpine` для сборки и работы. Линия Node.js 23 уже завершила поддержку. При обновлении базового образа выбрать поддерживаемый LTS, проверить сборку workspaces и smoke Core и закрепить digest. [Dockerfile](../../../../Dockerfile) · [Статусы выпусков Node.js](https://nodejs.org/en/about/previous-releases)

Публичные join URL используют внешний `publicOrigin`. Прокси терминирует TLS и передаёт WebSocket. Для доверия к forwarded-заголовкам внешний клиент должен входить через доверенный прокси с перезаписью этих заголовков. Раздел состояния Core и набор переменных не включают настройки конкретной организации. Организационные роли, ограничения, политики хранения и интеграции изменяются через API/редактор и хранятся в TenantStore. PVC/volume содержит рабочие данные, в том числе конфиги организаций, аудит, очередь и локальные материалы. Redis может хранить lease, снимки и отдельное состояние при включённых настройках. S3 используется отдельным медиаконтуром. [Модель Core](../architecture.md) · [TenantStore](../../apps/server/src/tenants.ts#L118) · [HA](../ha-leader.md) · [Kubernetes](kubernetes.md)

## Порты и проверка готовности

| Контур | Что проверить |
|---|---|
| Прокси и Core | Публичный HTTPS 443, HTTP 80 при необходимости перенаправления или выпуска сертификата. Хостовый Compose Core по умолчанию публикует loopback. В Kubernetes Ingress идёт на ClusterIP. Прокси передаёт HTTP и WebSocket к Core на TCP 8787. Значение внешнего origin совпадает с адресом приглашений. |
| TURN | Quickstart публикует 3478 UDP/TCP и диапазон 49200–49250 UDP по умолчанию. Проверить NAT и соответствие опубликованного адреса, проброс диапазона и внешний forced-relay звонок. TURN TLS 5349 требует отдельной конфигурации. |
| Redis и медиасервисы | Redis по умолчанию доступен в сети Compose, наружу порт не публикуется. Сам факт запуска Redis не связывает его с Core. Для HA указать `AGIL_REDIS_URL` и требуемый режим снимков. SFU, SIP, Egress, STT и мониторинг включаются по профилю, их порты и health проверяются отдельно. |
| Health | `/v1/health` годится для проверки процесса. Перед приёмкой проверить роль Core, путь записи, канал WS и фактическую передачу двух медиапотоков. Для внешних воркеров проверить их готовность отдельными пробами. |

[Quickstart ports](../../../infra/quickstart/README.md#6-ports) · [Эксплуатация и сеть](../operations.md#2-health-checks) · [Проверка Core](../../apps/server/src/public-api.ts#L2097)

## Предлагаемый формат

Один версионированный `core.yaml` задаёт статическую конфигурацию среды. Структуру полезно согласовать с текущим типом `Env`, а строгую схему сделать машинно проверяемой. Образец ниже обозначает будущий контракт.

```yaml
apiVersion: agil.calls/v1
kind: CoreConfig
profile: production
server:
  bind: 0.0.0.0
  port: 8787
  publicOrigin: https://calls.example.test
  trustProxy: true
storage:
  dataDir: /app/.data
rooms:
  allowAnonymous: false
identity:
  tokenSecretRef: AGIL_TOKEN_SECRET
  apiKeysRef: AGIL_API_KEYS
  ipSaltRef: AGIL_IP_SALT
media:
  sfu:
    enabled: false
```

Значения секретов поставляются отдельными файлами по именам ссылок. Это токены, ключи API, подписи и пароли, S3 credentials, TURN shared secret, OIDC client secret и DSN с authentication. Публичный файл содержит только ссылки и безопасные адреса без credentials. Для ICE отделить публичные STUN/TURN URL от постоянного секрета. Краткоживущие TURN credentials всё равно выдаются браузеру по назначению. У Core, TURN, узлов и workers разные наборы разрешённых секретов. Снимок tenant-секретов сохраняет действующие ограничения по именам и привязкам. Дополнить их загрузкой из смонтированных файлов. [Tenant secret resolver](../../apps/server/src/secret-env.ts) · [TURN и ротация](../operations.md#25-turn)

| Среда | Публичный источник | Секреты и постоянное состояние |
|---|---|---|
| Docker Compose | Read-only файл в `/etc/agil/core.yaml`. Compose передаёт только путь `AGIL_CORE_CONFIG_FILE` и параметры контейнера. | Секреты из менеджера или файлов через Compose secrets в `/run/secrets`. Core получает только явно перечисленные ключи, запуск проверяет читаемость под uid 1000. Именованный volume подключается в `storage.dataDir`. [Compose secrets](https://docs.docker.com/reference/compose-file/secrets/) |
| Kubernetes | ConfigMap одного файла, смонтированная директорией в `/etc/agil`. Чарт строит одинаковый `dataDir` для Core и PVC mount. | Отдельный Secret или CSI volume по ссылке `existingSecret`, с минимальным доступом пода. PVC для состояния. Публичный config и секреты читаются при старте. Изменение ConfigMap или Secret инициирует проверенное пересоздание Pod. [Kubernetes ConfigMap](https://kubernetes.io/docs/concepts/configuration/configmap/) · [Kubernetes volumes](https://kubernetes.io/docs/concepts/storage/volumes/) |

Приоритет публичных полей в переходный период идёт от defaults к `core.yaml`, затем к явно заданным устаревшим env-переменным и программным overrides для тестов. Диагностика сообщает имя и источник без значений секретов. После перехода оставить env только для указания путей и заранее определённых эксплуатационных исключений. Для каждого значения секрета новое чтение выбирается явно по ссылке, старый env разрешён для установки без смонтированного секрета. Одновременная поставка того же секрета через файл и env в production выдаёт ошибку конфликта. Пустой или недоступный обязательный секрет, ошибка схемы, невалидный URL, несогласованный каталог и неполная конфигурация включённого провайдера останавливают запуск до открытия listener.

## Порядок работ и приёмка

1. Исправить и проверить build context quickstart, согласовать PVC path и `AGIL_DATA_DIR`, добавить тест рендера Helm boolean. Закрепить версии Docker/Helm и образов. Свести таблицу переменных к ключам формата и отметить компоновочные переменные Compose, которые не нужны Core.
2. Добавить ADR по шаблону ADR-lite. Зафиксировать формат и версию, владение ключами, приоритет, допустимые ссылки, миграцию env и rollback. Отдельно описать dynamic tenant policy и data volume. [Текущие ADR-lite](../architecture.md#9-принятые-решения-adr-lite)
3. Реализовать одинаковый preflight для запуска и CI. Поддержать `check-config` и вывод эффективных публичных настроек с источниками. Проверять неизвестные/дублированные ключи, обязательные зависимости, mount и конфликты источников. В CI использовать синтетические значения и quiet-валидацию Compose, исключить печать Secret и production env. [Compose config](https://docs.docker.com/reference/cli/docker/compose/config/)
4. Добавить Compose и Helm adapters с неизменным runtime-контрактом. На чистом стенде проверить одинаковые эффективные настройки обоих вариантов, права чтения, restart с тем же volume, ротацию одного секрета с проверкой зависимых клиентов, контрольный звонок и принудительный TURN. Для rollback сохранить предыдущие образ, config и ссылку на версию Secret. Перед переключением восстановить тестовую копию состояния и измерить время.
5. В профиле VM оставить один короткий путь: проверка → запуск готового закреплённого образа → health → звонок → опциональная регистрация медианоды. Проверка должна срабатывать до запуска для неверного origin, пустого секрета, занятого порта и неверного каталога сборки. В пилоте Kubernetes использовать один Core и PVC до отдельной приёмки HA.

## Локальная проверка

Helm v3.18.6 прошёл `lint` для Core c фиктивным `existingSecret`. `helm template` для нестандартного mount path и `geoHeaderAllow=false` подтвердил расхождения, описанные выше. Рендер использовал ссылки на синтетический Secret. Docker Compose v2.39.4 прошёл `config --quiet` для корневого и quickstart-проектов с фиктивными значениями. Рендер подтвердил loopback 8787, наличие TURN-переменной в окружении корневого Core и её отсутствие в quickstart Core, отсутствие `AGIL_REDIS_URL` в quickstart Core и значение анонимного доступа `1` при удалении соответствующей строки из корневого образца. Отдельно проверены разрешённый путь build context и отсутствие файлов сборки по этому пути. Структурный `python agil/infra/tools/validate.py --quiet` проверил 27 YAML и завершился без ошибок и предупреждений.

Локальная проверка `loadEnv` показала, что ошибочный номер порта возвращает стандартный порт, некорректная строка origin сохраняется, отсутствие token secret даже при `NODE_ENV=production` подставляет значение по умолчанию, программные overrides выигрывают. Сборка контейнера, применение Helm в кластере и внешний TURN в этот прогон не входили.
