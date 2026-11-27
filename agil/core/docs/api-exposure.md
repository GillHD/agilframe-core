# API-документация и MCP: публикация, нейросети, защита доступа

Вопрос: как отдавать документацию API (Swagger/OpenAPI + explorer) и MCP
нейросетям, но при этом **не светить** поверхность наружу и уметь ограничивать
доступ по IP/порту, как в микросервисах. Ответ — всё это управляется
env-переменными, независимо для agil/core/docs/OpenAPI, admin API и HTTP-MCP.

## 1. Что публикуется

| Ресурс | Путь | Назначение | По умолчанию (dev) |
|---|---|---|---|
| API explorer (офлайн, без CDN) | `GET /docs` | интерактивная документация для людей | включён |
| Публичный OpenAPI 3.1 | `GET /openapi.json` | спецификация **только публичных** эндпоинтов | включён |
| Admin OpenAPI 3.1 | `GET /openapi.admin.json` | полная спека (admin-эндпоинты) | выключен/только внутренний доступ |
| Markdown-доки репозитория | `GET /docs/:file` | `agil/core/docs/api.md`, `agil/core/docs/security-audit.md`, `agil/core/docs/extensibility.md` и т.п. | включён |
| MCP (stdio) | `node agil/core/packages/mcp/dist/index.js` | инструменты для Claude/Cursor/агентов | локально |
| MCP (HTTP, streamable) | `POST /mcp` | MCP для внешних агентов по HTTP | выключен |

Машиночитаемый контракт = OpenAPI 3.1, поэтому его можно загрузить в Swagger UI,
Redoc, Postman, сгенерировать клиентские SDK, а также отдать нейросети как
инструмент (`agil_get_openapi`, `agil_get_api_endpoints` в MCP).

## 2. Переключатели (env)

| Переменная | Default | Смысл |
|---|---|---|
| `AGIL_DOCS_ENABLED` | `1` (dev), рекомендуется `0` в prod | `/docs`, `/docs/:file`, `/openapi.json` |
| `AGIL_DOCS_ALLOW_IPS` | пусто = все | CIDR/список IP, которым разрешены docs (например `10.0.0.0/8,192.168.0.0/16`) |
| `AGIL_DOCS_PORT` | пусто = основной порт | **отдельный порт** только для agil/core/docs/OpenAPI (как отдельный микросервис) |
| `AGIL_DOCS_HOST` | `0.0.0.0` | интерфейс для docs-порта (например `127.0.0.1`/внутренний IP) |
| `AGIL_ADMIN_API_ENABLED` | `1` | выключить весь `/v1/admin/*` (для публичного инстанса) |
| `AGIL_ADMIN_ALLOW_IPS` | пусто = все | IP-allowlist для admin API |
| `AGIL_ENROLL_ALLOW_IPS` | пусто = все | IP-allowlist **только** для enrollment (`/v1/cluster/join`, `/v1/nodes/register`, `/v1/nodes/:id/heartbeat`); не зависит от `AGIL_ADMIN_*`, вне списка → `403` |
| `AGIL_MCP_HTTP_ENABLED` | `0` | включить `POST /mcp` (streamable HTTP) |
| `AGIL_MCP_HTTP_PORT` | `8791` (`0` = эфемерный) | отдельный порт для HTTP-MCP |
| `AGIL_MCP_HTTP_HOST` | `127.0.0.1` | интерфейс HTTP-MCP (внутренний IP/VPN в проде) |
| `AGIL_MCP_HTTP_TOKEN` | — | Bearer-токен для HTTP-MCP (обязателен при включении) |
| `AGIL_MCP_HTTP_ALLOW_IPS` | пусто = все | IP-allowlist для HTTP-MCP (IP или IPv4-CIDR) |
| `AGIL_MCP_HTTP_MAX_BODY_BYTES` | `1048576` | лимит тела запроса к `/mcp` |
| `AGIL_MCP_MODE` | `full` | `read` — только read-only инструменты (агент не может менять конфиг) |
| `AGIL_TRUST_PROXY` | `0` | доверять `x-forwarded-for` (иначе allowlist обходится заголовком) |

Для **всех** `*_ALLOW_IPS`: пустое значение = «без ограничения»; непустое
значение, в котором нет ни одного валидного IP/CIDR (опечатка, hostname,
`172.17.0.1/33`), не должно открывать поверхность всем. Для
docs/admin/enroll это гарантирует `isIpAllowed` в `net-policy.ts`
(fail-closed); HTTP-MCP имеет собственную проверку и при непустом списке без
совпадений тоже возвращает `403`.

Поведение при выключении: docs и неизвестные пути возвращают **одинаковый 404**
(никакой утечки «docs есть, но запрещены»); admin API — 404 при
`AGIL_ADMIN_API_ENABLED=0`, иначе 401/403. Enrollment-поверхность
(`/v1/cluster/join`, `/v1/nodes/register`, `/v1/nodes/:id/heartbeat`) намеренно
**не** управляется `AGIL_ADMIN_*`: узлы не держат admin-ключ, и запись должна
работать при выключенном admin API. Её отдельный сетевой контур —
`AGIL_ENROLL_ALLOW_IPS` (пусто = все, вне списка → `403`). Спецификация и docs
не содержат секретов (ключи — env), но раскрывают поверхность API, поэтому в
проде по умолчанию лучше выключить и открыть только внутри периметра.

## 3. Три рекомендуемых режима

### A. Всё в одном инстансе, docs только для внутренней сети (просто)
```dotenv
AGIL_DOCS_ENABLED=1
AGIL_DOCS_ALLOW_IPS=10.0.0.0/8,192.168.0.0/16,127.0.0.1
AGIL_ADMIN_ALLOW_IPS=10.0.0.0/8
AGIL_TRUST_PROXY=1        # за Nginx/ALB, иначе allowlist смотрит на прокси
```
Nginx/ingress дополнительно режет `/docs`, `/openapi*.json`, `/v1/admin` по
сети/SSO.

### B. Микросервисный: agil/core/docs/MCP на отдельных портах
```dotenv
AGIL_DOCS_ENABLED=1
AGIL_DOCS_PORT=8790
AGIL_DOCS_HOST=127.0.0.1     # или внутренний IP, доступный только VPN
AGIL_MCP_HTTP_ENABLED=1
AGIL_MCP_HTTP_PORT=8791
AGIL_MCP_HTTP_TOKEN=<сильный токен>
AGIL_MCP_HTTP_ALLOW_IPS=10.0.0.0/8
```
Основной порт `8787` — только API/WS; docs-порт и MCP-порт не публикуются во
внешний ingress (доступны из внутренней сети/VPN). В Kubernetes — отдельные
Service/Ingress + NetworkPolicy; в docker-compose — отдельные `ports`/сеть.

### C. Публичный API без документации наружу
```dotenv
AGIL_DOCS_ENABLED=0
AGIL_ADMIN_API_ENABLED=0
```
Нейросети и инженеры работают через MCP локально/по внутреннему адресу
(stdio-транспорт не требует публичного docs). MCP при этом ходит к API по
внутреннему `AGIL_SERVER_URL` и использует `AGIL_API_KEY` — публичная
документация не нужна.

## 4. Доступ для нейросетей

1. **MCP stdio (рекомендуется).** Агент запускает сервер локально
   (`node agil/core/packages/mcp/dist/index.js`), получает 44 инструмента: чтение
   OpenAPI/каталога API (`agil_get_openapi`, `agil_get_api_endpoints`),
   генерация темы, валидация конфига, комнаты, права, провайдеры, аудит,
   транскрипт/заметки/compliance. Работает без публичного docs.
2. **MCP HTTP.** `POST /mcp` (streamable HTTP transport) с
   `Authorization: Bearer $AGIL_MCP_HTTP_TOKEN`, IP-allowlist; удобно для
   централизованных агентов/чатов компании.
3. **Read-only режим** `AGIL_MCP_MODE=read` — агенту доступны только
   read/design-инструменты (без `update_config`, `create_room`, `set_*`), чтобы
   исключить случайные изменения продакшена.
4. **OpenAPI как контекст.** Внутренняя спека (`AGIL_SERVER_URL/openapi.admin.json`
   из внутренней сети) или MCP-инструмент — нейросеть строит интеграции по
   контракту, не читая исходники.

## 5. Безопасность публикации

- Docs/OpenAPI/MCP не содержат секретов; admin-спека — раскрывает admin-API,
  поэтому только внутренний доступ.
- 404-эквивалентность при выключении; без `vary`-утечек; `cache-control: no-store`.
- Allowlist проверяется по реальному IP соединения; `x-forwarded-for` — только
  при `AGIL_TRUST_PROXY=1` и доверенном прокси (иначе подмена IP).
- Rate-limit на `/docs`, `/openapi*`, `/mcp` (общий API rate-limit).
- MCP HTTP: токен обязателен, сравнение constant-time, логи без токена; CORS не
  открывать наружу.
- Для нейросетей, работающих с реальными данными (транскрипты, аудит), выдавайте
  отдельный API-ключ тенанта с минимальными правами и read-only MCP.

## 6. Чек-лист

- [ ] В проде agil/core/docs/admin/MCP закрыты по умолчанию или спрятаны за allowlist/VPN.
- [ ] `AGIL_TRUST_PROXY` корректен для вашей топологии (allowlist не обходится).
- [ ] `/openapi.json` — только публичные эндпоинты; admin-спека не опубликована.
- [ ] HTTP-MCP включён только с токеном и allowlist; `AGIL_MCP_MODE=read`, если
      агент не должен менять конфиг.
- [ ] Docs/OpenAPI отдаются с `no-store`; в логах нет токенов/ключей.
- [ ] Отдельные порты (режим B) не опубликованы во внешнем ingress.
