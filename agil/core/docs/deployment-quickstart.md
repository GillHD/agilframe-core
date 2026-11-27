# AgilFrame — quickstart для продаж и пилота

Одна страница: как показать/установить AGIL у заказчика за 15–30 минут, не
трогая существующий production (Caddy/HAProxy/VPN/HA-стек).

> Это указатель, а не отдельная инструкция. Полные шаги, порты, node-токены,
> security-модель и ограничения — в
> [`agil/infra/README.md`](../../infra/README.md) и
> [`agil/infra/quickstart/README.md`](../../infra/quickstart/README.md).

## Что выбрать

| Сценарий | Что использовать |
|---|---|
| Демо/пилот на одной VM | [`agil/infra/quickstart/`](../../infra/quickstart/README.md) |
| У заказчика Kubernetes | [`agil/infra/helm/`](../../infra/helm/README.md) |
| Нужны VM в AWS | [`agil/infra/terraform/aws/`](../../infra/terraform/aws/README.md) |
| Нужен TLS/прокси | [`agil/infra/examples/`](../../infra/examples/README.md) |

## Минимум для первого звонка

1. Linux VM: 2 vCPU, 2 GiB RAM, 10 GiB диска, Docker 24+ с Compose v2.
2. DNS `A`-запись `calls.example.com` → публичный IPv4 хоста.
3. Открыты `80/tcp`, `443/tcp`, `3478/tcp+udp`, `49200–49250/udp`.
4. TLS-сертификат на вашем прокси (Caddy/nginx/HAProxy) — AGIL TLS не терминирует.
5. Запуск:

   ```bash
   cd agil/infra/quickstart
   ./install.sh --domain calls.example.com --start
   ./smoke.sh --keep      # напечатает join URL для первого звонка
   ./doctor.sh            # health/порты/диск/RAM/TLS
   ```

`install.sh` генерирует секреты (mode 0600), проверяет порты/DNS/ресурсы,
поднимает `core + turn + redis`, ждёт `/v1/health`, выпускает одноразовый
node-токен и запускает `node`. Он не перезаписывает `.env` без `--force`, не
редактирует чужие конфиги и не удаляет volumes.

## Что важно проговорить заказчику

- **Один core = одно состояние комнат в памяти.** Рестарт завершает активные
  звонки; горизонтального мультиузла в 0.1.0 нет.
- **TURN обязателен** для NAT/корпоративных сетей: `3478` и relay-диапазон
  должны быть открыты снаружи, `TURN_EXTERNAL_IP` — публичный.
- **Node-токен** — одноразовый; node-ключ хранится на самом узле (volume/PVC).
- **SFU/запись** — отдельный LiveKit (`agil/core/deploy/livekit/`), не входит в
  quickstart.
- **Секреты** — только `.env` 0600 / Secret / vault; в git и образы не попадают.
- **TLS** — на прокси; `/ws` требует WebSocket upgrade и таймаут ≥ 1 часа.

## Проверка перед передачей

```bash
./doctor.sh --json      # 0 = ok, 1 = warning, 2 = critical
./smoke.sh              # health + static + ICE + создание/токен/удаление комнаты
```

Ограничения, upgrade/rollback и полный чек-лист безопасности:
[`agil/infra/README.md`](../../infra/README.md) §5–§7.
