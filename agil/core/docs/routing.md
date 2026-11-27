# Routing baseline: Edge → call, Edge → stream, room → stream

Status: **implemented in Core (API + evaluator + JSON store)**. The Edge agent and
its firmware are **not** implemented — the server-side contract is fixed here so
the device can be built against it. No deploy/release is part of this baseline.

> **Generic flows supersede this surface for new configuration.**
> [`docs/flows.md`](flows.md) adds multi-source fan-in, branching to many sinks,
> processors (layout/audio mix/optional transcode), webhook/CDN/SRT destinations,
> manual/room_start/edge_online/schedule triggers and fallback chains.
> `/v1/admin/routes` remains the **legacy alias surface** and keeps working
> unchanged: an Edge join consults routes first and falls back to a flow only
> when no route matches, and a route-joined Edge also notifies matching
> `edge_online` flows. Both stores are per-tenant JSON files and both are
> evaluated with the same egress idempotency and SSRF/secret policy.

Related: [`docs/flows.md`](flows.md),
[`docs/egress-production.md`](egress-production.md),
[`docs/media-encoding.md`](media-encoding.md),
[`agil/edge/README.md`](../../edge/README.md),
protocol source `agil/core/packages/protocol/src/routing.ts`,
server source `agil/core/apps/server/src/routing.ts`.

## 1. What it does

A **routing rule** maps one source to destinations:

```
source                          destinations
──────                          ────────────
edge  (edgeId / tag) ──┐        room  (roomId or template, role, publish[])
room  (roomId)         ├──────► stream (rtmp | hls, layout, latency, url | secretRef)
participant (tag/room) ┘        recording (optional)
```

The evaluator guarantees **one publish target**:

```
Edge device ──publish once──► LiveKit room ──egress──► RTMP destination(s) / HLS / MP4
WebRTC participant ─────────► LiveKit room ──egress──► RTMP / HLS / MP4
```

`Edge → stream` is therefore implemented as `Edge → room + room → stream`. The
Edge never encodes RTMP itself and never receives the RTMP URL/stream key. Every
RTMP destination that shares a layout is produced by **one** composite egress job
with several `stream_outputs` URLs (one encode, many targets).

## 2. Data model

```ts
interface RoutingRule {
  id: string;                 // rt_…, URL-safe
  tenantId: string;           // always the API-key tenant
  name?: string;
  description?: string;
  enabled: boolean;           // default true
  priority: number;           // 0..1000, lower wins (default 100)
  source: {
    type: 'edge' | 'room' | 'participant';
    edgeId?: string;          // edge: optional selector (wildcard when absent)
    roomId?: string;          // room: required; participant: optional
    tag?: string;             // edge/participant selector
  };
  destinations: Array<
    | { type: 'room'; roomId?: string; template?: string; role?: 'host'|'moderator'|'guest'; publish?: Array<'audio'|'video'|'screen'> }
    | { type: 'stream'; provider: 'rtmp'|'hls'; url?: string; secretRef?: string; layout?: 'grid'|'speaker'; latency?: 'standard'|'low' }
  >; // 1..8; at most one room destination
  recording?: { enabled: boolean; layout?: 'grid'|'speaker'; audioOnly?: boolean };
  createdAt: number;
  updatedAt: number;
  lastRun?: RoutingRunRecord;  // sanitized diagnostics from the last evaluation
}
```

Rules:

- **one room maximum** per rule — an Edge publishes once, egress derives from
  that room;
- an edge rule with no room destination gets an implicit room
  `edge-<edgeId>` (so `Edge → stream` works without inventing a room id);
- a room/participant rule with no room destination derives egress from the
  source room itself;
- `destinations` must contain at least one entry;
- a room destination is `roomId` XOR `template`.

### Templates

`template` supports `{tenantId}`, `{routeId}`, `{edgeId}`, `{roomId}`, `{tag}`,
`{sourceId}`, `{participantId}`, e.g. `edge-{edgeId}` or `{tenantId}-hall`.
The expanded value must be a valid room id (1..64 of `A-Za-z0-9._-`); otherwise
the evaluation fails with `400 validation_failed`.

### Priority and selection

Enabled, source-matching rules are sorted by

1. `priority` ascending (lower number = higher priority),
2. `createdAt` ascending (older wins a tie),
3. `id` ascending (deterministic last resort).

The first rule is the effective route. A disabled rule is skipped entirely; if
no enabled rule matches an Edge join, the API answers `404 no_route`. For rooms,
"no matching route" simply means no egress is started.

Example `PATCH` shadowing diagnosis: `POST /v1/admin/routes/:id/test` reports
`matched:false` plus `shadowedBy: <higher-priority route>` instead of silently
applying a lower-priority rule.

## 3. API

All admin endpoints require a tenant credential (`x-api-key` or an SSO admin
session), are tenant-scoped and are leader-only mutations in HA mode. Unknown or
foreign route ids answer `404` (never a cross-tenant leak).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/admin/routes` | list routes (`{routes: RoutingRuleView[]}`) |
| `POST` | `/v1/admin/routes` | create a route (`{route}`) |
| `GET` | `/v1/admin/routes/:id` | read one route (`{route}`) |
| `PATCH` | `/v1/admin/routes/:id` | deep-partial update (`{route}`) |
| `DELETE` | `/v1/admin/routes/:id` | delete (`{deleted:true,id}`) |
| `POST` | `/v1/admin/routes/:id/test` | evaluate (and by default apply) a route |
| `GET` | `/v1/admin/routes/edge-tokens` | list Edge enrollment tokens (no plaintext) |
| `POST` | `/v1/admin/routes/edge-tokens` | issue an Edge enrollment token (plaintext once) |
| `DELETE` | `/v1/admin/routes/edge-tokens/:tokenId` | revoke an Edge enrollment token |
| `POST` | `/v1/edge/join` | **machine surface** — redeem an enrollment token |

`GET/POST /v1/admin/routes` responses never contain a stream URL or key: a stream
destination is rendered as

```json
{ "type": "stream", "provider": "rtmp", "layout": "grid", "latency": "standard",
  "urlHost": "rtmp://live.example/…", "hasSecret": true }
```

`urlHost` is the host-only redaction; `secretRef` (if used) is the env var
**name** (`AGIL_ROUTE_SECRET_*`), which is not a secret.

### Create an Edge → call + RTMP rule

```bash
curl -sS -X POST "$CORE/v1/admin/routes" \
  -H "x-api-key: $TENANT_KEY" -H 'content-type: application/json' \
  -d '{
    "name": "Hall camera → meeting + YouTube",
    "priority": 10,
    "source": { "type": "edge", "edgeId": "cam-hall" },
    "destinations": [
      { "type": "room", "roomId": "hall-main", "role": "host", "publish": ["audio","video"] },
      { "type": "stream", "provider": "rtmp", "secretRef": "AGIL_ROUTE_SECRET_DEMO_HALL", "layout": "grid" }
    ],
    "recording": { "enabled": false }
  }'
```

The response contains the stored rule with `urlHost`/`hasSecret` instead of the
URL. The env var `AGIL_ROUTE_SECRET_DEMO_HALL` must hold the full
`rtmp://host/app/stream-key` and is read from the **startup snapshot** only.

### Room → HLS

```bash
curl -sS -X POST "$CORE/v1/admin/routes" \
  -H "x-api-key: $TENANT_KEY" -H 'content-type: application/json' \
  -d '{
    "source": { "type": "room", "roomId": "all-hands" },
    "destinations": [{ "type": "stream", "provider": "hls", "layout": "speaker" }]
  }'
```

HLS is produced by the egress worker (segments + `index.m3u8`/`live.m3u8`).
The worker storage/CDN configuration is described in
[`docs/egress-production.md`](egress-production.md).

### Deep-partial PATCH

Scalars merge, `source` merges field by field (a `type` change drops stale
selectors), `recording` merges (`null` removes it), and `destinations` replaces
the list while **each entry is merged by array position**:

```bash
# Keep the room, switch the stream layout to speaker, raise priority.
curl -sS -X PATCH "$CORE/v1/admin/routes/rt_ab12" \
  -H "x-api-key: $TENANT_KEY" -H 'content-type: application/json' \
  -d '{ "priority": 5, "destinations": [{}, { "layout": "speaker" }] }'
```

A shorter list drops trailing destinations; a longer list appends complete ones.
The merged rule is re-validated (schema + SSRF/secret policy); an empty patch is
`400 validation_failed`.

### Test an evaluation

```bash
# Dry run: resolve the room and destination plan, start nothing.
curl -sS -X POST "$CORE/v1/admin/routes/rt_ab12/test" \
  -H "x-api-key: $TENANT_KEY" -H 'content-type: application/json' \
  -d '{ "edgeId": "cam-hall", "apply": false }'
```

`apply:true` (default) starts egress exactly like a live trigger. The response is
`RoutingTestResponse`: `matched`, `disabled`, `shadowedBy?`, `roomId`,
`roomCreated`, `destinations[]`, `egress {status,jobs,destinations,errors}`,
`errors`, `limitations`. It never contains a stream URL/key.

### Edge enrollment and join

```bash
# 1) Issue a token (one-time by default). Plaintext is returned exactly once.
curl -sS -X POST "$CORE/v1/admin/routes/edge-tokens" \
  -H "x-api-key: $TENANT_KEY" -H 'content-type: application/json' \
  -d '{ "name": "Hall camera #1", "edgeId": "cam-hall", "uses": 1, "ttlSec": 3600 }'

# 2) The device redeems it (no admin key). Rate-limited per IP; optional
#    AGIL_ENROLL_ALLOW_IPS applies to /v1/edge/join.
curl -sS -X POST "$CORE/v1/edge/join" -H 'content-type: application/json' \
  -d '{ "token": "agil_edge_…", "edgeId": "cam-hall", "name": "Hall camera" }'
```

Join response (abridged):

```json
{
  "tenantId": "demo",
  "edgeId": "cam-hall",
  "routeId": "rt_ab12",
  "publishTarget": "room",
  "roomId": "hall-main",
  "room": { "id": "hall-main", "tenantId": "demo", "name": "Hall camera", "mediaMode": "sfu", "maxParticipants": 50 },
  "joinToken": "eyJ…",
  "expiresAt": 1760000000000,
  "publisher": { "role": "host", "publish": ["audio", "video"] },
  "destinations": [
    { "index": 0, "type": "room", "roomId": "hall-main", "role": "host", "publish": ["audio","video"], "status": "ready" },
    { "index": 1, "type": "stream", "provider": "rtmp", "layout": "grid", "latency": "standard",
      "urlHost": "rtmp://live.example/…", "hasSecret": true, "status": "pending", "egressId": "EG_…" }
  ],
  "egress": { "status": "pending", "jobs": 1, "destinations": 2, "errors": [] },
  "limitations": ["…"]
}
```

The device joins the SFU/WebRTC room with `joinToken` (opaque room token, role
from the rule's room destination, default `guest`) and publishes media once.
Egress is already started from that room by the server.

Enrollment tokens are stored **hashed** (`sha256` with `AGIL_IP_SALT`), have a
TTL, a use count and a revoke endpoint. A token may be bound to `edgeId` and/or
`tag`; a bound value wins over the join body. A token that fails on `no_route`
or a room conflict is **not** consumed.

## 4. Evaluator behaviour

### Edge source

1. `POST /v1/edge/join` validates the enrollment token (without consuming).
2. The highest-priority enabled rule matching `{edgeId, tag}` is selected
   (`404 no_route` when none).
3. The room destination (or implicit `edge-<edgeId>`) is resolved; the room is
   reused when it exists in the tenant, or created with the tenant's media mode
   and participant cap (`roomMediaMode` + `capRoomParticipantsForSfu`).
4. The enrollment token use is consumed, a room join token is issued.
5. Egress is started for every configured stream/recording destination from that
   room and the outcome is returned.
6. `edge.joined` is audited; the rule's `lastRun` is stored.

### Room source

When the **first** participant joins a room (room lifecycle event `joined` with
`participantCount === 1`) the evaluator picks the room's highest-priority rule
and starts egress from that room. Later joins, resumed sessions and repeats do
not start duplicate jobs. `POST /v1/admin/routes/:id/test` triggers the same path
on demand (and is the only way to trigger it before a real participant joins).

Breakout rooms are skipped. A routing failure never breaks the call; the error is
stored on the rule and audited as `route.egress.failed`.

### Idempotency

Jobs are keyed by `tenantId + roomId + kind + layout + hash(sorted URLs)`:

- a `started`/`pending` job is reused (a room join storm cannot duplicate it);
- a failed/unavailable attempt is retried after 15 s;
- concurrent evaluations share one in-flight start;
- the cache lives in the Core process. After a restart the same job may be
  started again if it is still running — use
  `POST /v1/admin/egress/cleanup` or stop the old job explicitly.

### Egress unavailable / errors

If the worker is disabled (`AGIL_EGRESS_ENABLED=0`) or unconfigured
(`AGIL_EGRESS_URL`/keys missing), the run reports `status: "unavailable"` with a
clear `egress_disabled` / `egress_not_configured` message and the stable
`egress.code: "egress_unavailable"` (`egress_failed` / `partial_failure` for the
other degraded outcomes):

- Edge join still returns `200` with the room, join token and destinations — the
  call must work without streaming;
- route test returns `200` with `egress.status: "unavailable"` and `errors[]`;
- room start stores `lastRun.status = "unavailable"` and audits a warning.

Worker rejections are `failed`; a partial result (one destination up, one down)
is `partial`. Upstream error text is sanitized (`sanitizeEgressErrorText`):
stream URLs are reduced to the host, and tokens/keys are removed before the text
reaches a response, `lastRun` or the audit trail.

## 5. Security policy

- **Tenant isolation** — routes and Edge tokens live in
  `<AGIL_DATA_DIR>/routing/<tenantId>.json`; every read/write is keyed by the
  API-key tenant, and foreign ids return `404`. Edge join derives its tenant from
  the enrollment token, never from a header.
- **No secrets in responses/audit** — the raw RTMP `url` is never returned.
  `RoutingRuleView` renders `urlHost` + `hasSecret`; audit messages use the
  host-only form and detail entries never include the URL. Enrollment-token
  plaintext/hashes are never listed or audited.
- **secretRef** — must be a server-owned `AGIL_ROUTE_SECRET_*` variable, resolved
  from the startup env snapshot, validated both on write and at use time. Any
  other namespace is rejected with `400`.
- **SSRF** — an inline RTMP URL goes through the shared network-endpoint policy:
  only `rtmp:`/`rtmps:`, no embedded credentials, no private/link-local/metadata
  hosts; in secure mode (`NODE_ENV=production` or `AGIL_TRUST_PROXY=1`) only
  `rtmps://` to a public host and loopback is refused as well (development keeps
  loopback available for a local RTMP receiver, matching the shared webhook
  policy). The policy is re-checked at every start. DNS rebinding is not
  covered — terminate egress behind an allowlisting proxy when that matters.
- **Rate limits / surface** — `/v1/edge/join` uses the enrollment limiter
  (120/min per IP by default) and the optional `AGIL_ENROLL_ALLOW_IPS` allowlist.
  Admin route endpoints require a tenant credential and honour
  `AGIL_ADMIN_ALLOW_IPS`/`AGIL_ADMIN_RATE_LIMIT_PER_MIN`.
- **HA** — admin mutations are leader-only (`409 not_leader` on a standby); the
  routing file is per-Core, like tenant config and the room registry. Edge joins
  are leader-only too (they create rooms and start egress).

## 6. Environment

| Variable | Meaning |
| --- | --- |
| `AGIL_EGRESS_ENABLED` | enables the egress controller (default on when configured) |
| `AGIL_EGRESS_URL`, `AGIL_EGRESS_API_KEY`, `AGIL_EGRESS_API_SECRET` | LiveKit egress Twirp endpoint + credentials |
| `AGIL_ROUTE_SECRET_<NAME>` | full RTMP URL/stream key referenced by `secretRef` (snapshotted at startup) |
| `AGIL_ENROLL_ALLOW_IPS` | optional IP allowlist for `/v1/edge/join` (and cluster/node enrollment) |
| `AGIL_IP_SALT` | salt for Edge enrollment-token hashes |

No new env switch enables routing: the feature is inert until a rule exists.

## 7. Limitations (baseline)

- **No Edge agent/firmware** ships here. The contract (enrollment token, join,
  room publish, destination statuses) is server-side only; `agil/edge/` remains a
  scaffold. A device must implement: redeem the enrollment token → join the room
  with `joinToken` → publish media once. Stream retries are a server concern
  (egress), not a device concern.
- **Egress worker required.** RTMP/HLS/recording are LiveKit Egress work; a
  single-node install without a worker reports `egress_unavailable` (the call
  itself keeps working). CDN/playback is outside this document.
- **SFU media mode is required for egress.** Egress runs against a LiveKit room;
  a tenant in `mesh` mode has no SFU room to record/stream, so a routed stream
  will fail at the worker. Configure `scale.mediaMode: "sfu"` (or broadcast) for
  routed halls.
- **One egress job per layout group.** All RTMP destinations with the same
  layout share one composite job/encode; a different `layout` (or HLS) is a
  separate job. `latency` is stored for the worker/firmware mapping but the
  baseline does not change Twirp encoder settings from it.
- **Process-local idempotency.** See §4; there is no distributed egress registry.
- **Participant sources are not triggered yet.** They are validated/stored and a
  route test can evaluate them, but the baseline does not emit participant tags
  at join time; use `edge` or `room` sources for live routing.
- **Routes are per-Core JSON, rooms are in-memory.** In a multi-Core HA setup a
  standby does not share the leader's routes (same as tenant config today).
- **No panel/editor UI** in this change: the API and `@agil/protocol` DTOs are the
  contract a dashboard screen can use.
- **New configuration should use flows** ([`docs/flows.md`](flows.md)); this
  surface is kept as the compatibility alias and does not gain fan-in,
  processors or fallback.
- **No automatic egress stop when a rule is deleted or a room closes.** Running
  jobs are stopped explicitly (`POST /v1/rooms/:roomId/egress/:id/stop` or
  `/v1/admin/egress/cleanup`). This avoids deleting the wrong job in a shared SFU.
- **Edge role caveat:** a room destination's `role` (default `guest`) becomes the
  room token role. In `broadcast` mode (or `webinar.hostOnlyPublish`) guests are
  receive-only, so set `role: "host"`/`"moderator"` in the rule if the Edge must
  publish there. Treat that enrollment token as a high-value credential.

## 8. Tests

```bash
# protocol contract (schemas, priority, patch merge, redaction)
npm run test -w @agil/protocol

# server routing baseline (mock egress: CRUD, isolation, Edge join, room start,
# expansion, idempotency, failures, secret policy)
npx tsx --test agil/core/apps/server/test/routing.test.ts

# generic flows (branching, fan-in, pending adapters, triggers, fallback)
npx tsx --test agil/core/apps/server/test/flows.test.ts

# typecheck
npm run typecheck -w @agil/calls-server
```

The integration tests use a local mock Twirp server (`StartRoomCompositeEgress`,
`ListEgress`, `StopEgress`) and assert, among others:

- CRUD + deep-partial PATCH + tenant isolation + `401` without a credential;
- the stream key never appears in a response or the audit trail;
- priority ordering, disabled fallback, `no_route`;
- enrollment token one-time use, revoke, hashed storage, join-token claims;
- `Edge → stream` expansion into room + grouped RTMP + HLS;
- room → stream on first participant join and idempotent re-evaluation;
- `failed` / `unavailable` runs stored on `lastRun` and audited, with the call
  still working.
