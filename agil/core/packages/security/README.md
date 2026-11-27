# @agil/security

Node-only библиотека безопасности AgilFrame. Импортируется сервером
(`@agil/calls-server`) только как собранный `dist`. В браузер не попадает:
общие DTO берутся из `@agil/protocol` как **type-only** (`import type`), runtime-
зависимостей от протокола нет.

Собирается и проверяется:

```bash
npm run build     -w @agil/security   # tsc -> dist/*.js + *.d.ts
npm run typecheck -w @agil/security
npm test          -w @agil/security   # tsx --test "test/*.test.ts"
```

## Публичный API (сигнатуры)

Ровно как в `agil/core/docs/contract.md` §12 (плюс аддитивные helper'ы, отмеченные `+`):

```ts
// errors.ts
type SecurityErrorCode =
  | 'password_required' | 'password_invalid' | 'geo_blocked' | 'rate_limited'
  | 'room_locked' | 'file_too_large' | 'unsupported_mime' | 'not_found'
  | 'stt_not_configured' | 'integrity_failed';
class SecurityError extends Error { readonly code: SecurityErrorCode; constructor(code, message?) }
+function isSecurityError(value: unknown): value is SecurityError;

// password.ts  (scryptSync, N=16384, r=8, p=1, salt 16 B, keylen 64)
function hashPassword(plain: string): string;              // throws SecurityError('password_required')
function verifyPassword(plain: string, stored: string): boolean; // constant-time; never throws
+const SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_SALT_BYTES, SCRYPT_KEY_LEN, PASSWORD_HASH_PREFIX;
+function isPasswordHash(value: unknown): value is string;

// ip.ts
function hashIp(ip: string, salt: string): string;         // sha256 hex, 32 chars (128 bit)
function resolveClientIp(input: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  trustProxy?: boolean;                                    // x-forwarded-for only when true
}): string;
+function normalizeIp(raw: string): string;
+function headerValue(headers, name): string | undefined;
+type HeaderMap = Record<string, string | string[] | undefined>;

// geo.ts  (never throws)
function resolveGeo(ip: string, opts: {
  provider?: 'header' | 'ipapi' | 'none';                  // default 'none'
  headerCountry?: string;                                  // for provider 'header'
  timeoutMs?: number;                                      // default 1200
  cacheTtlMs?: number;                                     // default 600000 (10 min)
}): Promise<{ country?: string; city?: string; vpn: boolean; source: 'header' | 'lookup' | 'none' }>;
+function countryFromHeaders(headers: HeaderMap): string | undefined; // x-agil-country, cf-ipcountry, x-vercel-ip-country
+function normalizeCountryCode(raw: unknown): string | undefined;     // ISO alpha-2, rejects XX/ZZ
+function assertCountryAllowed(country, { allowedCountries?, blockedCountries? }): void; // SecurityError('geo_blocked')
+function clearGeoCache(): void;
+const GEO_COUNTRY_HEADERS;

// rate-limit.ts  (fixed window, LRU-bounded)
function createRateLimiter(opts: { windowMs: number; max: number; maxKeys?: number }): {
  check(key: string): { allowed: boolean; retryAfterMs: number; remaining: number };
  reset(key: string): void;
  readonly size: number;
  clear(): void;
};

// audit.ts
class AuditLog {
  constructor(opts: { dir: string; salt?: string; ringSize?: number }); // default ring 2000
  append(entry: Omit<AuditEntry, 'id' | 'ts'> & { ip?: string }): AuditEntry;
  list(opts?: { limit?: number; type?: AuditEventType; roomId?: string; since?: number }): AuditEntry[];
  countByType(since: number): Record<string, number>;
  readonly dir: string; readonly size: number;
  filePath(tenantId?: string): string;                     // +
}

// files.ts
class FileStore {
  constructor(opts: {
    dir: string; secret: string; baseUrl: string;
    ttlSec?: number;                                       // default 86400
    maxSizeMb?: number;                                    // default 25
    allowedMimeTypes?: string[];                           // default [] = allow all except active content
  });
  save(opts: {
    data: Buffer; name: string; mime: string;
    tenantId: string; roomId: string; uploadedBy: string;
    maxSizeMb?: number; allowedMimeTypes?: string[];       // per-request overrides
  }): FileRecord;                                          // throws file_too_large | unsupported_mime
  get(id: string, sig: string | undefined, exp: number | undefined): { record: FileRecord; data: Buffer } | null;
  list(opts?: { tenantId?: string; roomId?: string; limit?: number }): FileRecord[]; // default 100, cap 1000
  remove(id: string): boolean;
  sign(id: string, exp: number): string;                   // + re-sign a link
  fingerprint(id: string): string | null;                  // +
  filePath(id: string): string | null;                     // +
}

// recordings.ts
class RecordingStore {
  constructor(opts: { dir: string; secret: string; baseUrl: string; ttlSec?: number; maxSizeMb?: number });
  save(opts: {
    data: Buffer; mime: string; tenantId: string; roomId: string;
    createdBy: string; durationSec: number; transcript?: string; maxSizeMb?: number;
  }): RecordingRecord;
  get(id, sig, exp): { record: RecordingRecord; data: Buffer } | null;
  list(opts?: { tenantId?: string; roomId?: string; limit?: number }): RecordingRecord[];
  remove(id: string): boolean;
  attachTranscript(id: string, text: string): void;        // throws SecurityError('not_found')
  sign(id: string, exp: number): string;                   // +
  filePath(id: string): string | null;                     // +
}

// integrity.ts
class MediaIntegrityService {
  constructor(cfg: Partial<TenantConfig['security']['mediaIntegrity']>); // enabled default true
  evaluate(input: {
    frameTimingRegularity?: number; livenessPassed?: boolean; faceDetected?: boolean;
    externalScore?: number; externalConfigured?: boolean;
    country?: string | null; ipCountry?: string | null;
  }): { status: 'unknown' | 'verified' | 'suspicious'; score: number; flags: string[] };
}

// stt.ts
class SttService {
  constructor(opts: { url?: string; key?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch });
  isConfigured(): boolean;                                 // false when url is empty
  transcribe(audio: Buffer, opts: { mime: string; language?: string }): Promise<SttResponse>;
}

// av.ts  (без линковки GPL: только внешний clamd/CLI)
const EICAR_TEST_STRING: string;                           // собирается в runtime
type AvScanStatus = 'clean' | 'infected' | 'error' | 'skipped';
interface AvScanner { readonly name: string; isConfigured(): boolean;
  scan(input: { data: Buffer; tenantId: string; roomId?: string; fileId?: string; fileName?: string; mime?: string },
       opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<AvScanResult> }
class ClamAvScanner implements AvScanner {                 // clamd INSTREAM (TCP/unix socket)
  constructor(opts?: { host?: string; port?: number; socketPath?: string; timeoutMs?: number; maxBytes?: number; connectImpl? });
}
class YaraScanner implements AvScanner {                    // yara CLI, temp file 0600
  constructor(opts?: { rulesPath?: string; command?: string; argsPrefix?: string[]; timeoutMs?: number; maxBytes?: number; execFileImpl? });
}
class CompositeAvScanner implements AvScanner { constructor(scanners: AvScanner[]); readonly engines: readonly string[] }
+function frameClamAvInstream(data: Buffer): Buffer;
+function parseClamAvResponse(raw: string): { status: 'clean' | 'infected' | 'error'; signature?: string; detail?: string };
+function sha256Hex(data: Buffer): string;

// quarantine.ts  (payload никогда не отдаётся по HTTP)
class QuarantineStore {
  constructor(opts: { dir: string; listLimit?: number });
  put(input: { data: Buffer; tenantId: string; roomId?: string; sourceId?: string; fileName?: string;
               mime?: string; reason: 'infected' | 'scan_error' | 'manual'; engine?: string;
               signature?: string; detail?: string; uploadedBy?: string }): QuarantineRecord;
  list(opts?: { tenantId?: string; limit?: number }): QuarantineRecord[]; // newest first
  get(tenantId: string, id: string): { record: QuarantineRecord; data: Buffer } | null; // tenant-scoped
  remove(tenantId: string, id: string): boolean;
  count(tenantId?: string): number;
  // "не отдавать" маркер, если живую копию удалить не удалось (tenant-scoped,
  // переживает рестарт; download отвечает 403)
  block(input: { tenantId: string; sourceId: string; roomId?: string; fileName?: string;
                 reason?: 'infected' | 'scan_error' | 'manual'; archived?: boolean;
                 detail?: string }): QuarantineBlockRecord;
  isBlocked(tenantId: string, sourceId: string): boolean;
  listBlocked(opts?: { tenantId?: string }): QuarantineBlockRecord[];
}

// upload-scan.ts  (bounded queue + явная политика)
class UploadScanService {
  constructor(opts?: { scanner?: AvScanner; quarantine?: QuarantineStore; spoolDir?: string;
                       concurrency?: number; queueLimit?: number;
                       timeoutMs?: number; logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
                       onQuarantined?: (e: QuarantineEvent) => void;
                       onQuarantineFailed?: (e: QuarantineFailureEvent) => void;
                       onScanUnavailable?: (e: ScanUnavailableEvent) => void;
                       onScan?: (e: ScanEvent) => void });
  isEnabled(): boolean; readonly engineName: string | null;
  scan(job: { fileId: string; tenantId: string; roomId?: string; fileName: string; mime: string; data: Buffer;
              uploadedBy?: string; size?: number; remove?: () => boolean | Promise<boolean> },
       policy: { enabled: boolean; mode: 'async' | 'sync'; onScanError: 'fail-open' | 'fail-closed'; maxScanMb: number }): Promise<UploadScanOutcome>;
  recoverPending(opts?: { removeFile?: (input: { tenantId: string; fileId: string }) => boolean | Promise<boolean> }): Promise<number>;
  idle(): Promise<void>; close(timeoutMs?: number): Promise<void>;
  stats(): { queued: number; running: number; completed: number; infected: number; quarantined: number; errors: number; skipped: number };
}

// liveness.ts  (advisory, не сертификация)
const LIVENESS_TASKS: readonly ['blink', 'head-left', 'head-right'];
interface LivenessEngine { readonly name: string; isConfigured(): boolean;
  issue(input, opts: { ttlSec: number }): Promise<Omit<LivenessChallengeRecord, 'attempts' | 'maxAttempts'>>;
  verify(input: { challenge: LivenessChallengeRecord; signals: LivenessSignals }): Promise<LivenessVerdict> }
class ChallengeLivenessEngine implements LivenessEngine {}       // free baseline (no deps)
class HttpLivenessEngine implements LivenessEngine {             // self-hosted detector
  constructor(opts?: { url?: string; key?: string; timeoutMs?: number; fetchImpl?: typeof fetch });
}
class LivenessSessionStore { create/get/beginAttempt/consume/sweep; readonly size: number }
class LivenessService {
  constructor(opts?: { engine?: LivenessEngine; store?: LivenessSessionStore;
                       policy?: { ttlSec?: number; maxAttempts?: number; onEngineError?: 'fail-open' | 'fail-closed' };
                       now?: () => number });
  isEnabled(): boolean; readonly engineName: string | null;
  issue(input: { tenantId: string; roomId: string; participantId: string; task?: LivenessTask }): Promise<LivenessChallengeRecord>;
  verify(input: { tenantId: string; roomId: string; participantId: string; sessionId: string; signals: LivenessSignals },
         opts?: { onEngineError?: 'fail-open' | 'fail-closed' }): Promise<LivenessVerifyResult>;
  sweep(): number; readonly sessionCount: number;
}

// webhooks.ts  (вебхуки AgilFrame -> компания, §19 контракта)
function signWebhookPayload(rawBody: string, secret: string, timestamp?: number): string; // hex HMAC-SHA256(`${ts}.${rawBody}`)
function verifyWebhookSignature(rawBody: string, secret: string, signature: string,
  timestamp: number | string | undefined, toleranceSec?: number): boolean;                // constant-time + окно (default 300 с)
function buildWebhookHeaders(payload: WebhookPayload, secretEnvValue: string, timestamp?: number): Record<string, string>;
+function buildWebhookRequest(payload, secretEnvValue, timestamp?): { body: string; headers: Record<string, string>; timestamp: number };
+const WEBHOOK_SIGNATURE_HEADER, WEBHOOK_DELIVERY_HEADER, WEBHOOK_EVENT_HEADER, WEBHOOK_TIMESTAMP_HEADER;
+const WEBHOOK_TIMESTAMP_TOLERANCE_SEC;

// sanitize.ts
function sanitizeFilename(name: string): string;           // basename, control-chars/NUL stripped, <=180 chars, '.'/'..' -> 'file'
+const MAX_FILENAME_LENGTH;

// url-validation.ts  (SSRF-защита для настраиваемых endpoint'ов)
function validateOutboundUrl(raw: string, opts?: { allowHttp?: boolean; allowPrivate?: boolean }):
  { ok: true; url: URL } | { ok: false; error: string };
+const MAX_OUTBOUND_URL_LENGTH;

// index.ts re-exports everything above + type-only DTOs from @agil/protocol:
// AuditEntry, AuditEventType, AuditSeverity, FileRecord, RecordingRecord, SttRequest, SttResponse,
// WebhookPayload, WebhookEventType, WebhookEndpointConfig, WebhookDeliveryRecord
```

### Скачивание файлов/записей

`save()` возвращает `url` **уже целиком** — сервер ничего не дописывает:

```
${baseUrl}/v1/files/<id>?sig=<base64url>&exp=<epoch ms>
${baseUrl}/v1/recordings/<id>?sig=<base64url>&exp=<epoch ms>
```

`get(id, sig, exp)` проверяет: `id` из `[A-Za-z0-9_-]` (защита от path traversal),
подпись HMAC-SHA256 (constant-time), `Date.now() <= exp`, наличие файла и
совпадение размера. Любое нарушение → `null` (не бросает). `exp` сервер берёт из
query и передаёт числом: `Number(query.exp)`.

## Формат хэша пароля

```
scrypt$16384$8$1$<salt base64url>$<hash base64url>
```

- `N=16384` (2^14), `r=8`, `p=1`, `maxmem=64 MiB`;
- соль — 16 случайных байт (`crypto.randomBytes`), ключ — 64 байта (`scryptSync`);
- `verifyPassword` парсит параметры из строки (но с ограничениями N/r/p —
  защита от DoS на подделанном хэше), считает scrypt с длиной сохранённого ключа
  и сравнивает через `crypto.timingSafeEqual`;
- битый/чужой/пустой хэш → `false`, исключения наружу не выходят;
- пароль в открытом виде не хранится, не логируется и не попадает в ответы API —
  только `passwordProtected: boolean`.

## IP и гео

- Сырой IP в аудит не пишется: только `hashIp(ip, AGIL_IP_SALT)` — `sha256`,
  hex, первые 32 символа (128 бит). Один и тот же IP+соль → одинаковый хэш
  (нужно для корреляции), без соли восстановление нецелесообразно.
- `resolveClientIp`: `x-forwarded-for` (первый адрес) учитывается **только** при
  `trustProxy: true` (`AGIL_TRUST_PROXY=1`, только за своим reverse-proxy);
  иначе — `remoteAddress`. Нормализуется `::ffff:1.2.3.4`, `[::1]:443`,
  `1.2.3.4:8080`, zone-id.
- `resolveGeo` никогда не бросает: таймаут (AbortController), сеть, 4xx/5xx,
  битый JSON, отключённый провайдер → `{ source: 'none', vpn: false }`.
  Для `provider: 'header'` страну из заголовков передаёт сервер:
  `countryFromHeaders(req.headers)` (только при `AGIL_TRUST_PROXY=1`) →
  `resolveGeo(ip, { provider: 'header', headerCountry })`.
- `ipapi` кэширует успешные ответы 10 минут (`cacheTtlMs`, 0 = без кэша),
  кэш ограничен 5000 записями, ошибки не кэшируются. `vpn` определяется по
  полям ответа: `security.vpn`, `security.proxy`, `security.tor`, `proxy`, `vpn`.

## Аудит

- Файл: `<dir>/<tenantId>.jsonl` (tenantId санитизируется: только
  `[A-Za-z0-9._-]`, иначе `_global.jsonl`), по строке JSON на событие
  (`AuditEntry`), append-only, `mkdir -p` при старте и перед записью.
- In-memory ring (2000 записей) обслуживает `list()`/`countByType()`: быстрый
  admin API без чтения диска. Записи старше ring остаются в JSONL для
  log-shipping/ротации — `list()` их не видит.
- `append` синхронный (appendFileSync) и намеренно **не глотает** ошибки диска:
  если аудит не записался, операция не должна выглядеть успешной.
- IP передаётся как `ip?: string` и хэшируется солью лога; `ipHash` также можно
  передать готовым.

## Rate limit / lockout

`createRateLimiter` — фиксированное окно (`windowMs`) с максимумом `max` на ключ.
Память ограничена `maxKeys` (default 10 000), при переполнении вытесняется
least-recently-used ключ. Рекомендуемые конфигурации (см. §12 контракта):
join — 300/мин на `IP+room` (200 мест + запас для офисного NAT), files/STT — 30/мин на тенант, admin — 120/мин,
пароль — `config.security.maxFailedJoinAttempts` за `lockoutSec` (lockout
считать через отдельный лимитер или через `reset()` после успешного входа).

## Медиа-интеграция (anti-deepfake): честные ограничения

`MediaIntegrityService` — **эвристический риск-скор 0..1**, а не вердикт:

- веса: регулярность таймингов кадров 0.30, liveness 0.30, наличие лица 0.15,
  внешний детектор 0.35, несовпадение страны 0.05; считается среднее по
  переданным сигналам (отсутствующие сигналы не добавляют риск);
- `status: 'suspicious'` при `score >= cfg.flagThreshold` (default 0.7) или при
  жёстких флагах `liveness_failed` / `external_detector_high`;
  `'verified'` — ниже порога и есть хотя бы один положительный сигнал
  (liveness пройден, лицо найдено, низкий внешний скор); иначе `'unknown'`;
- `enabled: false` в конфиге → всегда `'unknown'`.

**Ограничения, которые нельзя замалчивать:**

- браузерные эвристики (тайминги, `getUserMedia`-метаданные, canvas-артефакты)
  вероятностные и обходятся современными дипфейками; они дают лишь «повод
  присмотреться», а не доказательство;
- сервер не анализирует медиа сам: `externalScore` приходит только от внешней
  модели (`AGIL_INTEGRITY_URL`/`AGIL_INTEGRITY_KEY`), которую вызывает сервер;
  без неё и без liveness-challenge уровень доверия низкий;
- юридически значимая детекция подделки требует внешней модели + liveness-
  challenge + провенанс-меток записи (C2PA) и процедур верификации. В MVP этого
  нет — это roadmap;
- флаг `geo_mismatch` — сигнал о несоответствии заявленной страны и IP, он не
  доказывает подмену (VPN/корпоративный прокси дают тот же эффект).

## STT

`SttService` — клиент OpenAI-совместимого `POST ${url}/audio/transcriptions`:
`multipart/form-data` (`file` + `model` + `language` + `response_format=verbose_json`),
`Authorization: Bearer <key>` только если ключ задан, timeout через
`AbortController` (default 30 s). Ответ нормализуется в `SttResponse`
(`text`, `provider: 'server'`, `language?`, `durationSec?`, `segments?`).
Не настроен (`AGIL_STT_URL` пуст) → `isConfigured() === false`,
`transcribe()` бросает `SecurityError('stt_not_configured')` → сервер отдаёт 501.
Ключ не логируется, не попадает в URL и в тексты ошибок.

## Liveness (advisory, не сертификация)

`LivenessService` выдаёт случайное задание (`blink`/`head-left`/`head-right`) с
TTL (30..600 с) и лимитом попыток (1..10) и проверяет, что присланный сигнал
соответствует заданию. Браузер выполняет MediaPipe Face Landmarker **локально** и
отправляет только булевы сигналы + confidence; видео/кадры на сервер не уходят.
Сессии in-memory, tenant-scoped, одноразовые после успеха; чужая
комната/участник → `invalid`. Ошибка/таймаут движка → `unavailable` (fail-open,
по умолчанию) или `failed` при `onEngineError:'fail-closed'`. Нет движка →
`SecurityError('liveness_not_configured')` → 501.

Честно: сигналы можно подделать, запись можно воспроизвести, пассивной
deepfake/voice-clone-детекции нет, `advisory: true` — не юридическое
доказательство. Детали и лицензии: `agil/core/docs/liveness-av.md`.

## Антивирусная проверка загрузок

Движки вызываются как **внешние процессы/сокеты** (GPL-код ClamAV не линкуется в
пакет): `ClamAvScanner` (clamd `INSTREAM`, TCP или unix socket),
`YaraScanner` (CLI) и `CompositeAvScanner`. Движок никогда не бросает на
scanner-сбое, а возвращает `status:'error'` — решение принимает
`UploadScanService`: `mode:'async'` (ответ сразу, карантин после) или
`mode:'sync'` (422 `file_infected` / 503 `scan_unavailable`), политика
`onScanError:'fail-open'|'fail-closed'`. Очередь ограничена, oversize не
буферизуется в демон (`skipped`). При заданном `spoolDir` принятая async-задача
пишется на диск до ответа и восстанавливается через `recoverPending()` после
рестарта (fail-closed не теряется); если при рестарте движок не настроен,
восстановленная задача **всё равно** fail-closed: `scan_error`, карантин,
удаление копии и колбэк `onScanUnavailable` (`recovered:true`); сервер поднимает
critical `file.scan_unavailable` (QA P2-3-R). Ошибка записи spool →
inline-скан, а не ложный `queued`. Если живую копию не удалось удалить,
`QuarantineStore.block()` запрещает её отдавать и поднимается critical
`file.quarantine_failed` (в сервере). Семантика восстановления —
at-least-once: падение между сканом и очисткой spool может повторить
скан/событие, но не теряет fail-closed.

`QuarantineStore` хранит payload + JSON-метаданные (`<dir>/<uuid>`,
`<dir>/<uuid>.json`), tenant-scoped; payload **никогда** не отдаётся по HTTP —
только `GET/DELETE /v1/admin/quarantine`. EICAR-строка собирается в runtime
(`EICAR_TEST_STRING`), поэтому исходники не выглядят как malware. Требования к
внешним бинарникам и ограничения — `agil/core/docs/liveness-av.md`.

## Вебхуки: подпись событий

Доставка вебхуков (`integrations.webhooks[]`, §19 контракта) подписывается
HMAC-SHA256:

- подпись = `hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))`, где `rawBody` —
  **точная** строка тела запроса (`JSON.stringify(payload)`), `timestamp` — epoch
  ms из `x-agil-timestamp`;
- заголовки: `x-agil-signature`, `x-agil-delivery` (= `payload.id`),
  `x-agil-event` (= `payload.type`), `x-agil-timestamp`, `content-type: application/json`;
- `buildWebhookRequest(payload, secretValue)` возвращает `{ body, headers,
  timestamp }` из одного места, чтобы тело и подпись не разошлись;
- `verifyWebhookSignature(rawBody, secret, signature, timestamp, toleranceSec)` —
  constant-time сравнение + окно ±`toleranceSec` (default 300 с) для защиты от
  replay; никогда не бросает;
- секрет берётся из env по имени `secretEnv` (в конфиге тенанта только имя);
  пустой секрет → `signWebhookPayload` бросает `Error` (нельзя отправить
  неподписанный вебхук);
- получатель должен ответить 2xx быстро, дедуплицировать по `x-agil-delivery` и
  не полагаться на порядок доставки.

## SSRF-защита сетевых вызовов

`validateOutboundUrl(raw, opts)` вызывается сервером **перед каждым** вызовом
настраиваемого endpoint'а (AI/knowledge-агент, вебхуки, STT, внешний детектор) и
на старте для `AGIL_INTEGRITY_URL`:

- только `https` (в проде); `allowHttp: true` — только локальная разработка;
- URL ≤ 500 символов, без `user:password@` (креды — только через заголовки/секреты);
- блокируются `localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `169.254.0.0/16`
  (cloud metadata), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`,
  `fc00::/7`, `fe80::/10`, IPv4-mapped (`::ffff:127.0.0.1`), числовые/hex-формы
  IPv4; `allowPrivate: true` — только dev;
- DNS-имена синхронно не резолвятся: в проде дополнительно нужен egress-firewall /
  DNS-pinning, чтобы домен не резолвился в private IP (TOCTOU).

## Переменные окружения (используются сервером)

| Переменная | Default | Назначение |
|---|---|---|
| `AGIL_DATA_DIR` | `.data` | база; `audit/`, `files/`, `recordings/` |
| `AGIL_IP_SALT` | `dev-ip-salt` | соль `hashIp` для аудита |
| `AGIL_TRUST_PROXY` | `0` | доверять `x-forwarded-for` и гео-заголовкам |
| `AGIL_GEO_PROVIDER` | `header` | `header` \| `ipapi` \| `none` |
| `AGIL_FILE_TTL_SEC` | `86400` | TTL ссылок/записей файлов |
| `AGIL_MAX_UPLOAD_MB` | `25` | лимит загрузки файла |
| `AGIL_RECORDINGS_DIR` | `<data>/recordings` | каталог записей |
| `AGIL_STT_URL` | — | OpenAI-совместимый base URL; пусто = STT выключен |
| `AGIL_STT_KEY` | — | bearer-ключ STT (не логируется) |
| `AGIL_STT_MODEL` | `whisper-1` | модель STT |
| `AGIL_INTEGRITY_URL` | — | внешний детектор deepfake (вызывает сервер); **валидируется** `validateOutboundUrl` на старте |
| `AGIL_INTEGRITY_KEY` | — | ключ внешнего детектора |
| `AGIL_CLAMAV_HOST` / `AGIL_CLAMAV_PORT` | — / `3310` | clamd по TCP; пусто = ClamAV выключен |
| `AGIL_CLAMAV_SOCKET` | — | unix socket clamd (приоритетнее host/port) |
| `AGIL_CLAMAV_TIMEOUT_MS` | `10000` | таймаут скана (500..60000) |
| `AGIL_YARA_RULES` / `AGIL_YARA_BIN` | — / `yara` | опциональный YARA CLI и правила |
| `AGIL_AV_CONCURRENCY` / `AGIL_AV_QUEUE_LIMIT` | `1` / `50` | параллелизм и размер очереди скана |
| `AGIL_AV_QUEUE_DIR` | `<data>/av-queue` | durable spool принятых async-сканов |
| `AGIL_QUARANTINE_DIR` | `<data>/quarantine` | каталог карантина + `<dir>/blocked/` |
| `AGIL_LIVENESS_ENGINE` | `challenge` | `challenge` \| `external` (self-hosted детектор) |
| `AGIL_LIVENESS_URL` / `AGIL_LIVENESS_KEY` | — | адрес/ключ self-hosted детектора; пусто = 501 |
| `AGIL_LIVENESS_TIMEOUT_MS` | `5000` | таймаут запроса к детектору |
| `AGIL_LIVENESS_TTL_SEC` / `AGIL_LIVENESS_MAX_ATTEMPTS` | `180` / `2` | TTL задания и попытки |

## Пример подключения в сервере

```ts
import {
  AuditLog, FileStore, RecordingStore, SttService, MediaIntegrityService,
  resolveClientIp, resolveGeo, countryFromHeaders, hashIp, hashPassword, verifyPassword,
  createRateLimiter, sanitizeFilename, validateOutboundUrl, buildWebhookRequest, SecurityError,
} from '@agil/security';

const audit = new AuditLog({ dir: join(dataDir, 'audit'), salt: process.env.AGIL_IP_SALT ?? 'dev-ip-salt' });
const files = new FileStore({ dir: join(dataDir, 'files'), secret: tokenSecret, baseUrl: publicOrigin });
const recordings = new RecordingStore({ dir: join(dataDir, 'recordings'), secret: tokenSecret, baseUrl: publicOrigin });
const stt = new SttService({ url: process.env.AGIL_STT_URL, key: process.env.AGIL_STT_KEY, model: process.env.AGIL_STT_MODEL });
const integrity = new MediaIntegrityService(config.security.mediaIntegrity);
const joinLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const ip = resolveClientIp({ headers: req.headers, remoteAddress: req.socket.remoteAddress, trustProxy: env.AGIL_TRUST_PROXY === '1' });
const geo = await resolveGeo(ip, {
  provider: env.AGIL_GEO_PROVIDER,
  headerCountry: env.AGIL_TRUST_PROXY === '1' ? countryFromHeaders(req.headers) : undefined,
});

// Настраиваемые endpoint'ы проверяем до вызова (и AGIL_INTEGRITY_URL — на старте).
const integrityUrl = process.env.AGIL_INTEGRITY_URL;
if (integrityUrl) {
  const check = validateOutboundUrl(integrityUrl);
  if (!check.ok) throw new Error(`AGIL_INTEGRITY_URL rejected: ${check.error}`);
}

// Вебхук: body и подпись из одного места.
const request = buildWebhookRequest(payload, process.env[endpoint.secretEnv] ?? '');
await fetch(endpoint.url, { method: 'POST', body: request.body, headers: request.headers });

if (room.passwordHash && !verifyPassword(body.password ?? '', room.passwordHash)) {
  audit.append({ type: 'password.failed', severity: 'warn', tenantId, roomId, ip, message: 'wrong room password' });
  throw new SecurityError('password_invalid');
}

const rec = files.save({ data: body, name: req.headers['x-file-name'], mime: req.headers['content-type'], tenantId, roomId, uploadedBy: participantId });
```

## Что НЕ делает этот пакет

- E2EE (шифрование медиа) — вне scope; ключи WebRTC не хранятся;
- надёжный deepfake-детект — только эвристики + liveness-challenge + внешний
  детектор (см. выше и `docs/liveness-av.md`); сертифицированного PAD нет;
- SSO/SCIM/2FA, RBAC — модель доверия задаётся сервером/тенантом;
- антивирусная проверка «из коробки»: движок (clamd/YARA) — внешняя зависимость
  деплоя, без него AV выключен; сигнатурный скан не ловит zero-day;
- многоузловой rate-limit/аудит/карантин — хранение in-memory/на локальном
  диске; горизонтальное масштабирование требует Redis/S3 (roadmap).
