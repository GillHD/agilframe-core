# Egress S3/MinIO storage + signed HLS/MP4 playback

> **Updated:** 20.11.2026 · **Local validation:** real LiveKit Egress → SeaweedFS
> S3 → signed MP4 and HLS through Core. MinIO and the deployment storage provider
> remain pending. See §9 for the topology and evidence.
>
> Companion to [`egress-production.md`](egress-production.md) (worker host,
> Redis, firewall, rollout) and `egress-local-test.md`
> (lab that proved MP4/RTMP/HLS media output). This document covers the part
> those two leave out: **durable S3/MinIO storage** and **signed playback**.

## 0. TL;DR

| Item | Value |
|---|---|
| Worker upload env | `EGRESS_S3_ENDPOINT`, `EGRESS_S3_REGION`, `EGRESS_S3_BUCKET`, `EGRESS_S3_FORCE_PATH_STYLE`, `EGRESS_S3_ACCESS_KEY`, `EGRESS_S3_SECRET_KEY` |
| App playback env | `AGIL_EGRESS_S3_*` (read), `AGIL_EGRESS_PLAYBACK_SECRET`, `AGIL_EGRESS_PLAYBACK_TTL_SEC` |
| Upload retries | `storage.s3.max_retries: 5` in [`egress.yaml`](../deploy/egress/egress.yaml); `/out/backup` is a **non-durable** fallback |
| Playback | HMAC-SHA256 token bound to tenant + room + egressId + S3 key + expiry; same-origin proxy; segments rewritten to signed URLs |
| Link TTL | 15 min (900 s) default; dashboard presets 15 min / 1 h / 24 h; hard cap 24 h |
| Endpoints | `POST /v1/rooms/:id/egress/:egressId/playback`, `GET …/playlist`, `…/segment`, `…/file`; `HEAD` on the three GET paths is metadata-only (no body read) |
| Bucket | **private**, TLS-only, lifecycle expiry; no anonymous read; CDN must sign at origin |
| MinIO lab | [`docker-compose.lab.yml`](../deploy/egress/docker-compose.lab.yml) (LiveKit + shared Redis + MinIO + egress + app) |
| Health | `GET /v1/admin/egress/workers` (controller + optional worker health); `node agil/core/scripts/egress-health.mjs` |
| Stuck cleanup | `POST /v1/admin/egress/cleanup` — dry-run by default, tenant-scoped by `demo__` room prefix |
| Tests | `npm run test:egress` (server), `npm run test:egress-deploy` (compose/YAML), `npm run test:egress-health` |

**Hard rule:** the bucket is never public. The app does not hand out bucket
URLs. A copied playback URL stops working when its HMAC token expires, even if
the S3 object still exists.

## 1. Topology

```
Browser / HLS player
   │  HTTPS, same origin (no S3 credentials)
   ▼
App API (this repo)
   │  GET signed playlist/segment/file  ──► SigV4 GET ──► S3/MinIO (private)
   │  POST .../playback (host/moderator)                    ▲
   │                                                       │ multipart upload
   ▼                                                       │
LiveKit SFU ── Redis/psrpc ──► Egress worker ──────────────┘
   ▲                               │
   └──── WebRTC media ─────────────┘  MP4 / HLS / RTMP
```

1. The app starts egress with a relative output path
   (`<tenant>/<roomId>/<timestamp>-<id>.mp4` or a HLS prefix).
2. Egress writes directly to S3; if upload fails it falls back to
   `/out/backup` (local, **not durable** — monitor it).
3. `GET /v1/rooms/:id/egress` exposes LiveKit's `file_results[].location` /
   `segment_results[].playlist_location`. The app derives the bucket key from
   those (`s3://bucket/key`, path-style/virtual-host URL, or a raw key).
4. A host/moderator calls `POST …/playback`. The app verifies the job exists,
   checks the object exists (S3 HEAD / local stat), and mints an HMAC token.
5. The recipient opens the signed URL. The app fetches the object with
   **app-side** SigV4 credentials, rewrites HLS segment URIs to signed URLs and
   streams bytes. The bucket stays private and no credential is ever in a URL.

## 2. Configuration

### 2.1 Worker upload (`agil/core/deploy/egress/.env`)

```dotenv
EGRESS_S3_ENDPOINT=https://s3.example.com
EGRESS_S3_REGION=ru-msk
EGRESS_S3_BUCKET=agil-recordings
EGRESS_S3_FORCE_PATH_STYLE=true
EGRESS_S3_ACCESS_KEY=...   # writer identity
EGRESS_S3_SECRET_KEY=...
```

`render-config.sh` writes these (minus the keys) into the 0640 config; keys go
to the container through `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, so they
never appear in `egress.yaml`. `force_path_style=true` for MinIO/Ceph and most
RU S3 clones; `false` for virtual-hosted AWS.

The rendered config keeps:

```yaml
storage:
  s3:
    region: '<region>'
    endpoint: '<endpoint>'
    bucket: '<bucket>'
    force_path_style: true
    max_retries: 5
    min_retry_delay: 100ms
    max_retry_delay: 5s
backup:
  prefix: /out/backup
```

`max_retries` is the upload retry path for transient S3 5xx/timeouts; there is
no app-side re-upload. Remove `backup` to fail closed instead of filling
`/out`.

### 2.2 App playback (app VPS `.env`)

```dotenv
# Read-only credentials for the same bucket.
AGIL_EGRESS_S3_ENDPOINT=https://s3.example.com
AGIL_EGRESS_S3_REGION=ru-msk
AGIL_EGRESS_S3_BUCKET=agil-recordings
AGIL_EGRESS_S3_ACCESS_KEY=...   # reader identity
AGIL_EGRESS_S3_SECRET_KEY=...
AGIL_EGRESS_S3_FORCE_PATH_STYLE=true

# HMAC secret for capability URLs. If unset, AGIL_TOKEN_SECRET is used; set a
# dedicated 32+ byte secret so rotating token secrets does not invalidate links
# mid-flight (and vice versa).
AGIL_EGRESS_PLAYBACK_SECRET=...
AGIL_EGRESS_PLAYBACK_TTL_SEC=900
AGIL_EGRESS_PLAYBACK_ENABLED=1

# Optional worker health probe for /v1/admin/egress/workers.
AGIL_EGRESS_HEALTH_URL=http://egress.internal:8080
# Optional: jobs older than this are reported/stopped by /v1/admin/egress/cleanup.
AGIL_EGRESS_STUCK_AFTER_SEC=14400
```

Offline/lab alternative (no S3 read credentials): point
`AGIL_EGRESS_PLAYBACK_DIR` at the worker's `/out` volume mounted on the app
host. The proxy then reads files from disk with the same signed-token checks.
Never use this as production storage.

`AGIL_EGRESS_PLAYBACK_ENABLED=0` disables link minting and playback with
`501 egress_playback_disabled`; existing links stop working immediately.

## 3. Signed playback contract

### 3.1 Mint a link

```http
POST /v1/rooms/{roomId}/egress/{egressId}/playback
Authorization: Bearer <host/moderator join token>   (or x-api-key)
Content-Type: application/json

{"ttlSec": 900}
```

`200`:

```json
{
  "egressId": "EG_…",
  "kind": "hls",
  "url": "https://calls.example/v1/rooms/<room>/egress/<id>/playlist?token=…",
  "expiresAt": 1763380800000,
  "ttlSec": 900
}
```

Errors:

| Status | Code | Meaning |
|---|---|---|
| 400 | `validation_failed` | RTMP session (no stored artifact) or bad `ttlSec` |
| 403 | `forbidden` | caller is not host/moderator and has no admin key |
| 404 | `not_found` | unknown room or egress id |
| 409 | `egress_not_ready` | playlist/MP4 not uploaded yet (active HLS can be published before the final VOD playlist) |
| 501 | `egress_playback_disabled` | `AGIL_EGRESS_PLAYBACK_ENABLED=0` |
| 501 | `egress_playback_not_configured` | no `AGIL_EGRESS_S3_*` read creds and no `AGIL_EGRESS_PLAYBACK_DIR` |
| 502 | `egress_storage_failed` | S3/MinIO GET/HEAD failed |

`kind` is `hls` (playlist) or `recording` (MP4 file). The token is
`base64url(JSON payload) + "." + base64url(HMAC-SHA256)`, payload:

```json
{"v":1,"t":"tenant","r":"room","e":"egressId","k":"tenant/room/…/index.m3u8","s":"playlist","x":1763380800000}
```

The payload is signed as-is (no query parameter can be edited). `verify`
compares signatures in constant time, rejects tokens >4 KiB, checks expiry and
binds tenant/room/egress/scope. A token from another tenant returns **404**
(does not confirm the room exists); a tampered/expired token returns **403**.

### 3.2 Fetch the playlist / segments / file

```http
GET  /v1/rooms/{roomId}/egress/{egressId}/playlist?token=…
GET  /v1/rooms/{roomId}/egress/{egressId}/segment?token=…
GET  /v1/rooms/{roomId}/egress/{egressId}/file?token=…
HEAD …the same three paths (identical status/headers, no body)…
```

- Playlist: `Content-Type: application/vnd.apple.mpegurl; charset=utf-8`,
  `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`. Every
  relative URI is rewritten to a signed same-origin URL with the **same expiry**:
  segment lines, `#EXT-X-MAP:URI="…"` (fMP4 init segment),
  `#EXT-X-KEY`/`#EXT-X-SESSION-KEY` (AES key), `#EXT-X-MEDIA`,
  `#EXT-X-I-FRAME-STREAM-INF`, `#EXT-X-RENDITION-REPORT` and
  `#EXT-X-PRELOAD-HINT`. A URI that points at another `.m3u8` (master/variant
  playlist) is signed with `scope: playlist`, so it is served by the playlist
  route and rewritten recursively; every other URI is a `segment` object.
  Absolute external URLs are left untouched (they belong to a CDN, not this
  bucket). A `Range` header on the playlist route is ignored.
- Segment: `video/mp2t` (or `video/iso.segment` for fMP4), `Cache-Control:
  private, max-age=3600`. `Range` handling is identical on the local-dir and
  S3/MinIO backends (§3.3).
- File: `video/mp4`, `Content-Disposition: attachment`, same `Range` contract.
  The dashboard labels it “Скачать”.
- `HEAD` mirrors `GET`: same status (`200`/`206`/`416`), `Content-Type`,
  `Content-Length`/`Content-Range`, `Cache-Control` and `Content-Disposition`,
  but it is **header-only** — the app issues an S3 `HEAD` (or a local `stat`),
  never an object `GET`, and a playlist `HEAD` does not fetch or rewrite the
  playlist body. For a playlist, `Content-Length` is the **stored object size**,
  which can be smaller than the rewritten body a `GET` would send; a segment/file
  `HEAD` computes `206`/`416` from the HEAD-reported size. HLS.js/Safari/
  ExoPlayer use `GET`, but download managers, monitoring and some CDNs probe
  `HEAD` first and pay only a metadata request.
- The token rules are the same for every method: a missing/expired/tampered
  token is `403`, a foreign tenant/room `404`.

#### Range contract (both backends)

| Request | Response |
|---|---|
| no `Range` | `200`, full object, `Accept-Ranges: bytes` |
| one satisfiable `Range` (`bytes=0-9`, `bytes=5-`, `bytes=-5`) | `206` + `Content-Range: bytes <start>-<end>/<size>` |
| one unsatisfiable/invalid `Range` (`bytes=99-120` past EOF, `bytes=abc`, `bytes=5-3`) | `416` + `Content-Range: bytes */<size>` |
| multi-range (`bytes=0-1,3-4`) | header **ignored**: `200`, full object (RFC 9110 allows this; the app does not emit multipart `206`) |

The range is classified **before** the S3 GET: an invalid value never reaches
the bucket for a body read, and a multi-range value is not forwarded. An
upstream S3/MinIO `416` is propagated as `416` with the upstream `Content-Range`
(or a `HEAD`-derived `bytes */<size>` when the provider omits it); the upstream
XML error body is discarded, so it never becomes a `502` and no bucket detail
leaks. A **missing object is `404` even when the `Range` is invalid** (the app
checks existence with one metadata `HEAD` first), matching the local-dir backend;
a missing object without a `Range` is also `404`.

### 3.3 Upstream errors, `lastError` and audit (redaction + tenant scope)

Upstream text (a Twirp `msg`, an S3/network error) is untrusted and may echo the
request — for RTMP that includes the publish URL **and its stream key**; for S3
it may include a signed URL; a worker failure may echo the Redis/RTSP/SRT URL.
Every upstream string passes `sanitizeEgressErrorText()`
(`apps/server/src/error-text.ts`) before it is stored, audited, returned or
logged:

- text is percent-decoded first (up to three passes), so
  `rtmp%3A%2F%2Fhost%2Fkey` and double-encoded forms cannot bypass the scrubber;
  encoded whitespace is held out of URL matching and restored afterwards, so
  `redis://:PA%20SS@host` cannot be split by its decoded space;
- **any** `scheme://…` URL — `http(s)`, `ws(s)`, `rtmp(s)`, `redis(s)`, `rtsp`,
  `srt`, `amqp`, `postgres`, `mongodb`, … — becomes `scheme://host[:port]/…`
  (userinfo/username/password, path, query and fragment dropped). The URL body
  runs to the next whitespace and the authority is parsed whole, so a password
  containing `,`, `;`, `)`, `]`, `}` or a percent-encoded comma (`%2C`) is
  redacted with the rest of the authority instead of being split and leaked;
  sentence punctuation after the URL is preserved (`…/0).` stays `…).`);
- `Authorization:` / `Bearer` / `Basic` values, `name=value` pairs whose name
  looks like a credential (`secret`, `token`, `password`/`pass`, `pwd`, `key`,
  `sig`/`signature`, `stream_key`, `streamid`, `api_key`, `access_key`, `auth`,
  `session`, `credential`), JWTs and long opaque blobs → `…`. Short values are
  redacted too: the rule is the credential-like **name**, not a 40+ character
  length or entropy heuristic;
- the result is collapsed to one line and capped at 300 characters.

`lastError` is **tenant-scoped**. `EgressClient` is a singleton shared by every
tenant, so `/v1/admin/egress/status` and `/v1/admin/egress/workers` (both now
require a tenant admin credential) return only the caller tenant's last failure
and active-job count (`<tenant>__` room prefix). A successful `start` clears
only that tenant's error. The audit `details.error` of `egress.failed` (start,
stop and cleanup `errors[]`) holds the sanitized message only; the raw upstream
text is never persisted or logged. Regression canaries cover the start
response/audit/log/`lastError` for `redis://`, `rtsp://`, `srt://`,
`key=`/`pass=`/`sig=` and percent-encoded RTMP text.

The same-origin proxy is deliberate: it keeps the private bucket private, makes
CORS trivial, and means an expired link cannot be refreshed by a player without
a new moderator action. It is not a CDN; see §7 for the production CDN gate.

A minted link is a capability with its own TTL: the GET routes verify the token
even when the room is no longer in memory (Core restart, deploy, or an admin
close), so a viewer that is already playing keeps working until the token
expires. Minting a **new** link still requires the live room and a
host/moderator (or admin key), because that is where authorization and the
egress job lookup happen.

## 4. Bucket policy and credentials

Two identities, never one:

| Identity | Used by | Minimal permissions |
|---|---|---|
| `agil-egress-writer` | worker | `s3:PutObject`, `s3:AbortMultipartUpload`, `s3:ListBucket` (prefix-scoped) on `arn:aws:s3:::agil-recordings/*` |
| `agil-egress-reader` | app playback proxy | `s3:GetObject`, `s3:ListBucket` (prefix-scoped) on the same bucket |

Example writer policy (scope the prefix if your provider needs `ListBucket`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EgressUploadOnly",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::agil-recordings/*"
    },
    {
      "Sid": "EgressListPrefix",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::agil-recordings",
      "Condition": { "StringLike": { "s3:prefix": ["*"] } }
    }
  ]
}
```

Reader policy: replace the actions with `["s3:GetObject"]` and keep the
prefix-scoped `ListBucket` only if your provider's SDK needs it. Do **not**
grant `s3:*`, `s3:DeleteObject`, or public-read ACLs.

Bucket settings:

- **Block Public Access / no anonymous policy.** `mc anonymous set none`.
- TLS-only: deny `aws:SecureTransport=false`.
- Default encryption (SSE-S3/SSE-KMS) and versioning if the legal policy needs
  recoverability; Object Lock only if recordings are evidence.
- Lifecycle: expire objects after the retention period; abort incomplete
  multipart uploads after 1–3 days.
- CORS only if the CDN/browser fetches S3 directly; with the app proxy, CORS is
  same-origin and the bucket needs no CORS.

### 4.1 MinIO init

The optional worker profile in
[`docker-compose.yml`](../deploy/egress/docker-compose.yml) and the lab compose
run a one-shot `minio-init` that:

1. waits for MinIO (`mc alias set` loop, bounded to 30 attempts so a wrong
   password exits non-zero instead of hanging the one-shot container);
2. creates the bucket if missing;
3. sets it private (`mc anonymous set none`);
4. applies an expiry rule when `MINIO_RETENTION_DAYS` is non-zero
   (`mc ilm rule add --expire-days …`).

Manual equivalent:

```bash
mc alias set prod https://minio.example.com "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing prod/agil-recordings
mc anonymous set none prod/agil-recordings
mc ilm rule add --expire-days 30 prod/agil-recordings
mc ilm rule ls prod/agil-recordings
mc anonymous get prod/agil-recordings      # expect: no anonymous policy
```

Production should not use the MinIO root account for either identity. Create
two users/service accounts with the policies above, and store their keys in the
worker `.env` (0600) and the app `.env` (0600) respectively.

## 5. Retention

| Layer | Default | Where |
|---|---|---|
| S3 lifecycle expiry | 30 days (lab; set per contract) | `MINIO_RETENTION_DAYS` / bucket lifecycle |
| HLS segment cleanup | S3 lifecycle (objects expire together) | bucket rule |
| Local `/out/backup` | prune manually (7 days example) | worker host cron |
| Playback links | 15 min / 1 h / 24 h | `AGIL_EGRESS_PLAYBACK_TTL_SEC` + dashboard presets |
| Stuck jobs | 4 h threshold, dry-run default | `AGIL_EGRESS_STUCK_AFTER_SEC`, `POST /v1/admin/egress/cleanup` |

`/out` is not durable. If `backup` is enabled, monitor disk and copy/retry
files to S3; otherwise remove `backup` to fail closed.

## 6. Worker health, registration and stuck cleanup

### 6.1 Registration

Egress registers by subscribing to the **LiveKit Redis/psrpc bus**. There is no
egress Twirp API on the worker and port 8080 is health only. The authoritative
check remains:

```bash
node agil/core/scripts/egress-health.mjs --env-file agil/core/deploy/egress/.env
```

It performs `PING`, `PUBSUB CHANNELS`/`NUMSUB` for `EgressInternal`/
`StartEgress`, `lk egress list` and the app status check; secrets are scrubbed.

### 6.2 App health endpoint

```http
GET /v1/admin/egress/workers        (x-api-key / admin session)
```

Returns the same fields as `/v1/admin/egress/status` plus:

```json
{
  "worker": {
    "urlConfigured": true,
    "reachable": true,
    "status": "ok",
    "cpuLoad": 1.25
  },
  "checkedAt": 1763380800000
}
```

Both admin endpoints require a tenant admin credential (`x-api-key` or an admin
session) and return **that tenant's** `lastError`/`activeCount`; another tenant's
failure text is never visible (§3.3).

`AGIL_EGRESS_HEALTH_URL` is the worker's `http://host:8080` (not the Twirp base).
The URL and any secret are never returned. A `404`/network failure is reported
as `reachable:false`, never as a 5xx for the whole app.

### 6.3 Stuck / retry cleanup

```http
POST /v1/admin/egress/cleanup
{"thresholdSec": 14400, "apply": false}
```

- Default `apply:false` is a **dry run**: lists active jobs older than the
  threshold.
- Scoped to the caller's tenant by SFU room-name prefix (`<tenant>__`), so a
  tenant key cannot stop another tenant's jobs.
- With `apply:true` it calls `StopEgress` for each stuck job, returns
  `stopped[]` / `errors[]` and writes an `egress.cleanup` audit entry.
- Jobs without a `started_at` timestamp are skipped: their age cannot be
  proven, so the endpoint never guesses and never stops a possibly fresh job.
- S3 upload retries are handled inside egress (`max_retries`); this endpoint is
  for jobs that never reach a terminal state.

Run it from cron/systemd only after checking the dry run. There is no automatic
destructive cleanup by design.

## 7. Local lab (Docker + WSL)

The lab compose brings up **LiveKit + shared Redis + MinIO + egress + app** on
one Linux host:

```bash
cd agil/core/deploy/egress
cp .env.lab.example .env.lab
chmod 600 .env.lab
# set LIVEKIT_API_SECRET, MINIO_ROOT_PASSWORD, AGIL_TOKEN_SECRET
sudo install -d -o 1001 -g 1001 -m 750 /srv/agil-egress/out
docker compose -f docker-compose.lab.yml --env-file .env.lab up -d --build
docker compose -f docker-compose.lab.yml --env-file .env.lab ps
```

Services and health:

| Service | Check |
|---|---|
| `redis` | `redis-cli ping` |
| `minio` | `curl -f http://127.0.0.1:9000/minio/health/live` |
| `minio-init` | exits 0 after bucket + private policy + lifecycle |
| `livekit` | `docker compose logs livekit` / `ws://127.0.0.1:7880` |
| `egress` | `curl -f http://127.0.0.1:8080/` |
| `app` | `curl -f http://127.0.0.1:8787/v1/health` |

Smoke path (manual, one shell so the publisher survives):

```bash
# 1) create a room + host token via the app API (dev-key is the lab key)
curl -sS -X POST http://127.0.0.1:8787/v1/admin/rooms \
  -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"name":"egress-s3-lab"}'

# 2) publish a synthetic participant (livekit-cli)
lk load-test --url ws://127.0.0.1:7880 --api-key "$LIVEKIT_API_KEY" \
  --api-secret "$LIVEKIT_API_SECRET" --room <room-name> --duration 120s &

# 3) start HLS/MP4 through the app, wait for EGRESS_ACTIVE, stop, then:
curl -sS -X POST http://127.0.0.1:8787/v1/rooms/<roomId>/egress/<egressId>/playback \
  -H "authorization: Bearer <host-token>" -H 'content-type: application/json' \
  -d '{"ttlSec":900}'
```

Then open the returned `/playlist?token=…` in `live.html` (or `ffprobe` the
`/file?token=…` MP4) and confirm:

- object exists at `s3://agil-recordings/<tenant>/<room>/…` (private);
- `mc anonymous get` shows no public policy;
- the playlist contains `#EXT-X-ENDLIST` after stop;
- segment URLs are `/v1/.../segment?token=…`, not bucket URLs;
- the same URL with a 1 s later clock / edited token returns 403.

The lab is not a production topology: `use_external_ip:false`, host
networking, MinIO root credentials reused for read/write, and no TLS. Do not
expose it to the internet.

## 8. Tests and evidence

| Test | Covers |
|---|---|
| [`egress.test.ts`](../apps/server/test/egress.test.ts) | Twirp bodies/JWT/redaction, **P1-1 canary (an upstream `msg` that echoes the RTMP URL: start response, audit, log, `/status`, `/workers`; acme cannot see the demo failure)**, **P2-2 canaries (`redis://`/`rtsp://`/`srt://`, short `key=`/`pass=`/`sig=`, percent-encoded RTMP, and comma/semicolon/paren/`%2C` inside a credential; start response/audit/log/`lastError`/`/workers`)**, tenant-scoped `lastError` + clear-on-success, admin auth on `/v1/admin/egress/status`, admin cleanup dry-run/apply + tenant scope + unknown-age safety, worker health probe |
| [`egress-playback.test.ts`](../apps/server/test/egress-playback.test.ts) | token round-trip/tamper/expiry/TTL clamp, OpenAPI paths/schemas/refs, key traversal, playlist rewrite (segments, fMP4 `EXT-X-MAP`, `EXT-X-KEY`, master/variant + `EXT-X-MEDIA`/`I-FRAME`/`RENDITION-REPORT`), local proxy + containment (traversal on both separators), **S3 mock `416`/HEAD/multi-range**, **P3-13 missing+invalid-Range `404` on both backends**, **P3-14 header-only HEAD (service + real API: only S3 HEADs, no object GET/playlist rewrite)**, local `416`/multi-range, `HEAD` on all three playback routes, playback after the room is closed, 403/404/409/501, SigV4 URL/headers |
| [`egress-api.test.ts`](../apps/dashboard/test/egress-api.test.ts) | dashboard playback-link + worker-health client contract (encoded route, TTL body, no request for a blank id) |
| [`egress-health.test.mjs`](../scripts/test/egress-health.test.mjs) | secret scrubbing, dry-run, CA handling, lk fixture |
| `test:egress-deploy` | compose/YAML static contract: services, image pins, healthchecks, S3 keys, retention, no secrets |

Run (all three are root `package.json` scripts; no Docker required):

```bash
npm run test:egress          # 32/32 (egress 14 + playback 18)
npm run test:egress-deploy   # 8/8
npm run test:egress-health   # 7/7
```

The static compose test is the gate in environments without Docker. It checks
that `docker-compose.lab.yml` contains LiveKit, Redis, MinIO, egress and app,
that the egress YAML template has `storage.s3` + retries + backup, that the
MinIO bootstrap is private and applies the retention lifecycle, that no secret
literal is committed, that healthchecks exist for the services that can answer
one, and that the documented test scripts actually exist.

The runtime OpenAPI (`/openapi.json`, `/openapi.admin.json`) includes the
playback and egress cleanup/worker paths and every `$ref` resolves
(`EgressPlaybackLinkRequest`, `EgressCleanupRequest`, `EgressCleanupResult`,
`EgressWorkerStatus`). The committed `docs/openapi*.json` snapshots are
generated artifacts; regenerate them at release time with
`npm run openapi -w @agil/calls-server`.

## 9. What was validated here, and what is blocked

**Validated (this environment, offline/S3 mock):**

- server egress tests 32/32: the real HTTP handlers, HMAC token verification,
  playlist/segment/file proxy (including after the room is closed and via a
  header-only `HEAD`), the P1-1 + P2-2 redaction canaries (RTMP/Redis/RTSP/SRT,
  generic short credential names, percent-encoding, punctuation inside a
  credential) and cross-tenant
  `lastError`, OpenAPI publication of the new paths/schemas and the admin
  cleanup/worker-health endpoints;
- the S3 code path end-to-end against a local mock that **recomputes the SigV4
  signature** from the received request (HEAD/GET/Range, path-style URL,
  percent-encoded key) — so the signer is checked against a second
  implementation, not just header shape — plus a second mock for the `416`
  contract, `HEAD`-derived size, missing-object `404` and the multi-range policy,
  and a HEAD probe that asserts the S3 backend receives only metadata `HEAD`
  requests (no `GET`, no playlist rewrite);
- signed HLS rewrite (segments, fMP4 `#EXT-X-MAP`, `EXT-X-KEY`, master/variant
  playlists), `Range`/`416`/multi-range streaming and MP4 download headers
  against a local artifact root, including traversal containment;
- SigV4 canonical URL and header construction (path-style and virtual-hosted);
- static compose/YAML contract 8/8 (see the `test:egress-deploy` output), plus
  PyYAML parsing of both compose files and `bash -n` on the extracted
  `minio-init` scripts and `render-config.sh` (LF copies);
- dashboard egress client contract 6/6 (`test:egress-api.test.ts`), dashboard
  typecheck and `npm run build:dashboard`;
- server typecheck (`tsc -p agil/core/apps/server/tsconfig.json --noEmit`)
  passes in this tree.

**Live S3 lab, 20.11.2026:**

- Windows Core used a WSL2 lab with LiveKit 1.13.11, Egress 1.15.0, a
  dedicated Redis and SeaweedFS 4.54. SeaweedFS ran with credentials and a
  dedicated bucket. LiveKit CLI published a test camera and audio track.
  [SeaweedFS quick start](https://github.com/seaweedfs/seaweedfs#quick-start).
- Core started and stopped MP4 and HLS jobs through LiveKit. Both reached
  `EGRESS_COMPLETE`. Core issued same-origin playback URLs. MP4 returned
  `206` for a byte-range request, HLS returned an end marker and signed
  segment URLs. FFprobe recognized H.264 at 1280×720 and AAC in both.
  FFmpeg decoded the video and audio of both recordings through the signed
  URLs without errors. The runs were `EG_NXdiNYGoPBZp` (MP4, 7.76 s) and
  `EG_RZF5YhKN7MFC` (HLS, 7.47 s).
  An unsigned request to the S3 bucket returned `403`.
- The host-networked lab binds HTTP signaling to loopback and advertises the
  WSL network interface address as `rtc.node_ip`. When it advertised only
  `127.0.0.1`, the worker browser opened signaling but failed to establish ICE.
  Use the Compose lab worker options for Chrome to start in the container.

**MinIO and deployment validation pending:** the MinIO image was unavailable
in this lab. For an environment that uses MinIO:

1. run the lab compose and execute §7;
2. capture `docker compose ps`, egress logs (no secrets), `mc ls`, `mc anonymous
   get`, `ffprobe` on the signed MP4, and a 403 after expiry;
3. repeat against the production-like S3 in the required jurisdiction with
   writer/reader identities, then run the production gates in §10.

## 10. Production gates (S3/CDN)

Do not enable egress for real tenants until all of these are true:

- [ ] **Jurisdiction / 152-ФЗ:** bucket region is in the required jurisdiction;
      no cross-border replication; legal approval for RTMP/HLS egress to a
      foreign provider/CDN.
- [ ] **Private bucket:** public access blocked, no anonymous policy, TLS-only
      policy, default encryption on; `mc anonymous get` / `aws s3api
      get-bucket-policy` reviewed.
- [ ] **Two least-privilege identities:** writer on the worker, reader on the
      app; no root keys; rotation runbook and expiry date.
- [ ] **Lifecycle:** object expiry matches the contract; incomplete multipart
      abort enabled; a restore/export path exists for legal holds.
- [ ] **CDN:** origin access identity / signed origin (not a public bucket);
      when the app proxy is not used, sign at the origin and never in the CDN;
      CORS + MIME (`application/vnd.apple.mpegurl`, `video/mp2t`) verified;
      cache keys include the token or the origin enforces auth.
- [ ] **Playback TTL:** `AGIL_EGRESS_PLAYBACK_SECRET` is dedicated and 32+ bytes;
      `AGIL_EGRESS_PLAYBACK_TTL_SEC` matches the product policy; expired URLs
      return 403 and foreign-tenant URLs 404 (tested).
- [ ] **Health/monitoring:** `/v1/admin/egress/workers` reachable, worker health
      probe configured, alerts on `egress_storage_failed`, S3 5xx, disk `/out`
      watermark, stuck jobs, and `EGRESS_FAILED`/`EGRESS_ABORTED`.
- [ ] **Retention:** S3 lifecycle applied and verified with a test object;
      `/out/backup` monitored/pruned or disabled (fail-closed).
- [ ] **Capacity:** one 720p multi-output composite ≤ 5.41 cores / 1.95 GB on
      the pinned image; S3 upload does not starve media; run the combined
      MP4+HLS lab again on the target host.
- [ ] **Rollback:** `AGIL_EGRESS_ENABLED=0` stops new jobs, the worker can be
      stopped without touching the app, and already-uploaded objects remain
      readable through signed links until expiry.
- [ ] **No secrets in git/logs:** `git grep` for keys, compose `ps`/logs, app
      audit and error bodies; signed URLs must not appear in access logs (log
      the path without `token=`).

## 11. Rollback / failure modes

| Failure | Effect | Action |
|---|---|---|
| S3 unreachable | egress retries, then `/out/backup`; job may fail | keep `backup`, monitor disk; restore S3; copy backups |
| Wrong reader key | link mint fails 409/502 | rotate `AGIL_EGRESS_S3_*`, restart app |
| Expired link | 403 `playback_expired` | mint a new link with a new TTL |
| Foreign token | 404 | expected |
| Playback disabled | 501 | set `AGIL_EGRESS_PLAYBACK_ENABLED=1` |
| Stuck egress | active forever, uploads stop at limit | `POST /v1/admin/egress/cleanup` dry-run → `apply:true` |
| Bucket made public | recordings world-readable | restore private policy immediately, rotate keys, review CDN |

## 12. Files

| File | Purpose |
|---|---|
| [`deploy/egress/docker-compose.yml`](../deploy/egress/docker-compose.yml) | production worker + optional MinIO + private bucket/lifecycle init |
| [`deploy/egress/docker-compose.lab.yml`](../deploy/egress/docker-compose.lab.yml) | full local lab: LiveKit, Redis, MinIO, egress, app |
| [`deploy/egress/livekit.lab.yaml`](../deploy/egress/livekit.lab.yaml) | SFU config for the lab |
| [`deploy/egress/.env.example`](../deploy/egress/.env.example) | worker env template |
| [`deploy/egress/.env.lab.example`](../deploy/egress/.env.lab.example) | lab env template |
| [`deploy/egress/egress.yaml`](../deploy/egress/egress.yaml) | worker config template (`storage.s3`, retries, backup) |
| [`deploy/egress/render-config.sh`](../deploy/egress/render-config.sh) | renders the 0640 config outside the repo |
| [`apps/server/src/egress-playback.ts`](../apps/server/src/egress-playback.ts) | token, SigV4, playlist rewrite, local/S3 proxy |
| [`apps/server/src/public-api.ts`](../apps/server/src/public-api.ts) | playback endpoints |
| [`apps/server/src/admin-api.ts`](../apps/server/src/admin-api.ts) | worker health + stuck cleanup |
| [`apps/server/src/env.ts`](../apps/server/src/env.ts) | `AGIL_EGRESS_S3_*`, playback, health, cleanup env |
| [`apps/dashboard/test/egress-api.test.ts`](../apps/dashboard/test/egress-api.test.ts) | dashboard playback-link + worker-health client contract |
| [`scripts/test/egress-deploy.test.mjs`](../scripts/test/egress-deploy.test.mjs) | static compose/YAML/retention/no-secrets gate |
| [`scripts/test/egress-health.test.mjs`](../scripts/test/egress-health.test.mjs) | health script regression tests |

## 13. Related docs

- [Egress production kit](egress-production.md) — host, Redis, firewall, capacity, rollout.
- Egress local lab — media output proof (MP4/RTMP/HLS).
- [Operations](operations.md) — alerting/runbooks.
- [HLS viewer](hls-viewer.md) — `/live.html` player.
