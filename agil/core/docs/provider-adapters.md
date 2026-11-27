# Подключаемые провайдеры (free/local по умолчанию, платные — партнёр)

Дата: 16.11.2026. Принцип: **AGIL не продаёт и не проксирует платные сервисы**.
Мы даём стабильный интерфейс, локальные/free-реализации для тестов и
документацию, как партнёр подключает свой провайдер.

## Redis

- Redis/Valkey **разрешён** и используется для leader election, pub/sub и
  rate-limit в тестах.
- Для продакшена партнёр может взять managed Redis/Valkey (Yandex Managed
  Redis, AWS ElastiCache, Azure Cache) или свой.
- Протокол Redis; конкретный вендор не зашит. `AGIL_REDIS_URL`.
- Если Redis недоступен — standalone-режим, без HA.

## Контракт провайдера

Каждый внешний сервис — порт (interface) + адаптер. Ядро не знает бренд.

```ts
interface SttProvider {
  readonly id: string;
  transcribe(input: AudioChunk, opts: SttOptions): Promise<TranscriptSegment[]>;
  health(): Promise<ProviderHealth>;
}

interface TranslationProvider {
  readonly id: string;
  translate(text: string, from: string, to: string): Promise<string>;
}

interface LivenessProvider {
  readonly id: string;
  createChallenge(): Promise<LivenessChallenge>;
  verify(sessionId: string, frames: Frame[]): Promise<LivenessResult>;
}

interface AvScanner {
  readonly id: string;
  scan(file: FileRef): Promise<ScanResult>;
}

interface SipTrunkProvider {
  readonly id: string;
  dial(number: E164, room: RoomRef): Promise<SipCall>;
  hangup(callId: string): Promise<void>;
}

interface StorageProvider {
  readonly id: string;
  put(key: string, body: Readable): Promise<void>;
  signGet(key: string, ttlSec: number): Promise<string>;
}

interface PaymentProvider {
  readonly id: string;
  createCheckout(plan: Plan, tenant: string): Promise<Checkout>;
  handleWebhook(payload: unknown, signature: string): Promise<PaymentEvent>;
}
```

## Конфигурация

Провайдер выбирается в конфиге тенанта/окружения, секреты — только в env/secret
manager, не в tenant JSON и не в UI.

```json
{
  "integrations": {
    "stt": { "provider": "local", "fallback": "none" },
    "translation": { "provider": "local", "target": "en" },
    "liveness": { "provider": "local-opencv" },
    "av": { "provider": "clamav" },
    "sip": { "provider": "local-asterisk" },
    "storage": { "provider": "minio" },
    "payments": { "provider": "none" }
  }
}
```

Секреты:

```env
AGIL_STT_PROVIDER=local
AGIL_STT_ENDPOINT=
AGIL_STT_API_KEY=
AGIL_TRANSLATE_PROVIDER=local
AGIL_LIVENESS_PROVIDER=local-opencv
AGIL_AV_PROVIDER=clamav
AGIL_SIP_PROVIDER=local-asterisk
AGIL_S3_ENDPOINT=
AGIL_S3_ACCESS_KEY=
AGIL_S3_SECRET_KEY=
AGIL_PAYMENT_PROVIDER=none
```

Правила:

- `provider=none` — функция выключена, UI показывает «не подключено».
- Ошибка провайдера → fallback (local/none) по политике, без утечки ключей.
- Таймауты, circuit breaker, retry, метрики по каждому адаптеру.
- `GET /v1/admin/integrations/status` — `configured/healthy/provider`, без секретов.
- Аудит: `integration.changed/tested`, без ключей.

## Что даём бесплатно/локально

| Домен | Free/local | Платный адаптер (партнёр) |
|---|---|---|
| STT | whisper.cpp/faster-whisper | Deepgram, Azure Speech, Google STT |
| Перевод | OPUS-MT/Marian | DeepL, Google Translate |
| Liveness | OpenCV/MediaPipe | iProov, Onfido, Azure Face |
| AV | ClamAV | VirusTotal, Cloudmersive |
| SIP | Asterisk/FreeSWITCH + LiveKit SIP | Twilio, Telnyx, оператор |
| Storage | MinIO/SeaweedFS | AWS S3, GCS, Azure Blob |
| CDN | Varnish/ATS/nginx cache | CloudFront, Cloudflare, Bunny |
| Платежи | нет (квоты/учёт) | Stripe, ЮKassa, Paddle |
| Email | Mailpit/Postfix | SES, SendGrid, Postmark |
| IdP | Keycloak | Okta, Entra ID, Google Workspace |

## Тестирование

- CI использует **fake/local** адаптеры, никаких платных ключей.
- Contract tests: каждый провайдер проходит один набор (`health`, timeout,
  ошибка, retry, redaction).
- Партнёрские адаптеры — отдельные пакеты/плагины, не в основном образе.
- E2E с реальным провайдером — только в staging партнёра.

## Правила для платных интеграций

- Никаких ключей в git, tenant config, логах, UI.
- Никакого автоматического включения платного провайдера без явного выбора.
- Не обещать «работает с X» без contract-теста.
- Партнёр сам заключает договор с провайдером; AGIL даёт адаптер и инструкцию.
- Лицензии локальных моделей и требования к поставке описаны в [списке моделей](model-licenses.md).
