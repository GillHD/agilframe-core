# Realtime chat/events at scale: WebSocket, SSE and the viewer plane

> **Decision document — docs only.** No product code and no deployment are part of
> this change. The SSE endpoint and the Redis event log described here are a
> **target design**, not current behavior. Current behavior: one Core node, rooms
> in memory, WebSocket signaling (`api.md` §10), SFU/broadcast media
> (`large-rooms.md`), and a video-only HLS page (`hls-viewer.md`).

## 0. TL;DR

**No — AGIL does not need WebSocket for millions of passive viewers.** It needs
WebSocket for the small, interactive control plane, and HTTP/SSE (+ CDN) for
one-way viewer fan-out. These are two different planes with different economics:

| Plane | Who | Transport | Target |
|---|---|---|---|
| Interactive | participants, hosts, moderators, panelists | **WS** (one socket per participant), Redis pub/sub + ownership + sticky routing | **200 WS per room** (the product cap); size nodes in validated 200-session units |
| Viewer | webinar/stream audience, receive-only | **SSE** (`text/event-stream`) + HTTP POST ingress + CDN | **1,000+ SSE per process** (measured), 10,000+ per node as the next target, 100,000+ with an SSE fleet, millions via CDN |
| Media | everybody | WebRTC mesh/SFU for interactive; HLS/LL-HLS via CDN for passive | never on WS or SSE |

The measured 1,000-connection loopback run in this repository (details in §6):

| Mode | Opened | Connect p95 | Fan-out p95 | Loss | Server RSS/conn | CPU per 1k deliveries |
|---|---|---|---|---|---|---|
| WS | 1,000 / 1,000 | 110 ms | 69 ms | 0% | 10.26 KiB | 75.2 ms |
| SSE | 1,000 / 1,000 | 102 ms | 75 ms | 0% | 12.61 KiB | 81.7 ms |

Both transports are cheap per connection; **the difference is not the frame
format, it is state, fan-out topology and who pays for egress**. WebSocket can be
made to scale to millions of sockets with a distributed gateway, but for one-way
viewer traffic it defeats CDN offload, requires sticky state and turns every
viewer into an origin connection. SSE does not.

**Media never belongs on either transport.** A 200-person SFU room is
audio-egress-bound (roughly 1.6 Gbps of forwarded audio at the `high` profile),
while 200 WebSocket sockets are a few megabytes and ~1,000 deliveries/s. The
hard part of 200 is the SFU/TURN, not WS. At 100k viewers the hard part is video
CDN egress, not chat.

---

## 1. The question, made precise

"Millions of users" mixes three unrelated numbers:

1. **Concurrent interactive participants.** The product caps a room at 200
   (`high` profile; 50 on `standard`, 25 on `low`). Each participant needs a
   bidirectional socket for SDP/ICE, chat, reactions, captions, whiteboard,
   moderation and presence.
2. **Concurrent passive viewers.** A webinar or stream can have 10k–1M+ viewers
   who receive video and events but never publish media. Their traffic is
   one-way; their feedback is occasional and moderated.
3. **Registered/monthly users.** Not a transport dimension at all. A million
   registered users may mean a few thousand concurrent sockets.

Only (1) needs WebSocket. (2) needs a one-way fan-out transport with replay,
backpressure and CDN economics. (3) is a database/billing concern.

The rest of this document answers:

- what the interactive WS plane looks like at 200/room with Redis, room
  ownership and sticky routing;
- what the viewer plane looks like for webinars/streams, including
  `Last-Event-ID`, replay cursors, backpressure, rate limits and moderation;
- how WS, SSE, MQTT and WebTransport compare per connection, per proxy and per
  browser;
- measured 1k numbers and clearly marked 10k/100k/1M estimates;
- a migration plan, cost model and risk register.

---

## 2. Current state and constraints

| Concern | Today | Implication |
|---|---|---|
| Interactive signaling | `GET /ws` (HTTP upgrade), JWT in `Sec-WebSocket-Protocol`; `welcome`, `chat`, `sdp`/`ice`, presence, whiteboard, captions (`api.md` §10) | Keep WS; add `seq` to the event envelope |
| Rooms | in memory on one Core process; single replica by design (`agil/infra/helm/agil-core/README.md`) | Multi-node WS needs Redis bus + room ownership + sticky routing (`scaling.md` §4, design only) |
| Room cap | 200 on the `high` profile; `min(room, scale, profile, sfu.maxParticipants)` (`large-rooms.md`) | 200 WS/room is the planning unit; the SFU is the binding capacity |
| Broadcast/webinar | `mediaMode: broadcast`, host-only publish, moderated chat, raise-hand queue (`scaling.md` §2, §6) | Viewers are already receive-only; this is the natural SSE audience |
| HLS viewer | `/live.html?hls=…`, video only, no chat (`hls-viewer.md`) | Add an SSE overlay + moderated POST ingress |
| External chat | `POST /v1/rooms/:id/chat` broadcasts over WS (`api.md` §6) | Reuse it as the viewer ingress; append to the event log too |
| Viewer limit config | `scale.webinar.viewerLimit` (config example: 10,000); `maxParticipants` config ceiling 50,000 (effective cap is the profile) | The event plane must support more viewers than the WS plane |
| Multi-node | Redis leader lease exists (`ha-leader.md`); room replication/placement is not implemented (`scaling.md` §9) | Do not claim multi-node WS until the bus/ownership work lands |

The current WS plane is a **control plane**. Media is mesh P2P or SFU WebRTC;
WS carries only signaling and room events. That separation is the main reason
the viewer plane can be changed without touching media.

---

## 3. Architecture: two event planes, one media plane

```text
                         ┌─────────────────────────────────────────────────────┐
                         │              Edge: TLS, WAF, rate limits            │
                         │   LB by room (WS) / room hash + viewer shard (SSE)  │
                         └───────────────┬──────────────────────┬──────────────┘
                                         │                      │
                     WS (bidirectional)  │                      │  HTTP/2–3, SSE (one-way)
                                         │                      │
        ┌────────────────────────────────▼──────────┐  ┌────────▼─────────────────────────┐
        │ Interactive plane (stateful)              │  │ Viewer plane (stateless)        │
        │ Core signalling nodes                     │  │ SSE fan-out workers             │
        │ rooms, presence, chat, moderation,        │  │ 1 stream per viewer             │
        │ SDP/ICE relay, join/resume tokens         │  │ cursor + replay + heartbeat     │
        └──────┬──────────────────────────┬─────────┘  └────────┬────────────────────────┘
               │                          │                     │
               │ Redis: room lease,       │ SFU token           │ Redis Streams:
               │ pub/sub, Streams         ▼                     │ room event log
               │                 ┌────────────────────┐         │
               └────────────────►│ SFU media plane    │         │
                                 │ LiveKit/mediasoup  │         │
                                 └─────────┬──────────┘         │
                                           │ HLS/LL-HLS         │
                                           ▼                    │
                                    ┌─────────────┐             │
                                    │ CDN (video) │             │
                                    └──────┬──────┘             │
                                           │                    │
        participants (≤200/room) ◄─────────┴──────────► viewers (10k–1M+)
        WS, WebRTC media                                SSE, HLS video
```

Event flow, both directions:

```text
host / moderator ──WS──► Core ──append(seq)──► room stream ──read(from seq)──► SSE workers ──► viewers
viewer POST /chat ──► Core (permission + rate limit + moderation) ──append(seq)──► same stream
```

The rule is simple:

- **If the peer must talk back on the same connection, use WS.**
- **If the peer only listens (and occasionally POSTs), use SSE.**
- **If it is audio/video, use WebRTC or HLS — never WS/SSE.**
- **If it is a device fleet or constrained edge agent, evaluate MQTT; browsers
  are not the MQTT use case** (§7.2).

---

## 4. Interactive rooms (≤200): WS + Redis + ownership + sticky

### 4.1 Why WS here

- Signaling is genuinely bidirectional and latency-sensitive: `sdp`/`ice` relay
  for mesh, chat/reactions/hand/captions/whiteboard/annotations, config updates,
  kick/close and moderation actions.
- One socket per participant carries server-initiated and client-initiated
  frames, per-message rate limits (40 msg/s, 3 violations → close 1008), JWT
  subprotocol auth, ping/pong heartbeat and explicit close codes.
- Loss is not acceptable for control or durable chat; ordering matters per
  room/peer.
- 200 sockets is tiny: at 10–13 KiB per connection it is 2–2.6 MiB of server
  state, and 200 participants × 5 events/s is only 1,000 deliveries/s.

The interesting work is not the transport. It is **ownership, ordering and
failure handling** across nodes.

### 4.2 Target topology

```text
client ──TLS──► LB ──sticky cookie agil_node / consistent hash(roomId)──► Core node A (room owner)
                                                                          │
                                          Redis: room:{id}:owner (lease, TTL, fencing token)
                                          Redis: agil:signaling (pub/sub, ephemeral)
                                          Redis: agil:room:{id}:events (Stream, replay)
                                                                          │
                     Core node B ◄── pub/sub ── Core node A ── XREAD ──► SSE workers
```

- **Sticky routing.** LB cookie `agil_node` (or consistent hash by `roomId`) so
  a participant reaches the node that owns the room. Sticky is by **room**, not
  by user: a reconnect that lands elsewhere is redirected to the owner rather
  than creating a second room state.
- **Room ownership.** A Redis lease (`room:{id}:owner`, TTL, renewal) names one
  writer per room. The owner assigns the room sequence number and serializes
  chat/state writes. A fencing token prevents an expired owner from writing
  after a new owner takes over.
- **Broadcast.** Ephemeral events go to `agil:signaling` with
  `{roomId, exceptNode}`; durable events are appended to the room stream. Nodes
  fan out to their local sockets. Media never traverses this bus.
- **Join.** REST join issues the token; WS handshake checks the room owner and
  either accepts, redirects, or proxies to the owner. The current single-node
  MVP accepts locally; multi-node is the design in `scaling.md` §4.
- **Drain/failure.** On deploy, the owner stops accepting joins, tells clients
  to reconnect (`bye` + close 1001), flushes the stream, and releases the lease.
  On crash, the lease expires; a new owner restores the room snapshot and the
  stream tail. Clients use the existing resume token (`call-continuity.md`) so
  peers see `presence: reconnecting` instead of a peer churn.

### 4.3 Delivery semantics by message class

Not all events deserve the same guarantees. Treating every event as durable is
how chat systems become expensive; treating every event as lossy breaks chat.

| Class | Examples | Ordering | Loss allowed | Plane |
|---|---|---|---|---|
| Control | `welcome`, `error`, `bye`, `close`, `config`, kick | per socket | no | WS only |
| Signaling | `sdp`, `ice` | per peer | no | WS only |
| Durable room events | `chat`, `system`, join/leave audit | per room `seq` | no | WS + SSE + stream |
| Ephemeral state | `presence`, `state`, `typing`, `reaction`, cursor | last-value/coalesced | yes | WS + SSE |
| Media-adjacent | `caption` partials, transcript segments | per speaker `seq` | partials yes; final no | WS + SSE |

- **Sequence numbers.** Every room event gets a monotonic `seq` from the owner.
  Durable chat is idempotent by message `id` (the existing API already uses `id`
  for dedupe); clients apply by `seq` and ignore duplicates.
- **Pub/sub is not a log.** Redis pub/sub is at-most-once and does not replay.
  It is fine for presence/typing/cursor wakeups; durable chat and replay need
  Redis Streams (or another append-only log) with a bounded `MAXLEN`.
- **Ordering across channels.** Do not assume global ordering between pub/sub
  channels. Order per room is defined by the owner's `seq` assignment, not by
  Redis delivery order.

### 4.4 Backpressure and abuse limits (WS)

- Per-socket bounded send queue. If a socket exceeds the watermark, shed
  ephemeral classes first; never shed control or accepted chat. A hard ceiling
  closes the socket with a reason and lets the client resume.
- Existing limits: 40 messages/s per socket, 3 violations → close 1008; join
  rate limit 300/min per IP+room; room lockout for password brute force
  (`api.md` §12). Add per-role and per-room token buckets for chat/reactions.
- Slow consumers are a normal condition, not an exception: monitor queue depth,
  drop counts by class, and reconnect rate per room.

### 4.5 Sizing the WS plane

- **200 WS per room** is the product target. A single room at 200 is trivial;
  the SFU/media capacity is the real limit (`large-rooms.md` §5).
- A Core process can hold more than 200 sockets — the single-node orientation in
  `scaling.md` §7 is ~5–10k connections on 1 vCPU / 1 GB, but that number is
  **orientation, not a validated benchmark**. The pilot validated 200 concurrent
  WS sessions with presence/chat/caption fan-out and zero errors
  (`qa-load-200-ws.md`).
- Size in **validated 200-session units** until the Redis bus and multi-room
  path are load-tested. Horizontal scaling: more Core nodes + room placement +
  Redis. The WS tier is CPU-light; Redis and the SFU/TURN pool become the
  bottlenecks first.
- Do not put one million WS sockets behind a single LB. If a future product
  requirement really needs a million *interactive* sockets, use a distributed
  gateway (many nodes, consistent-hash room placement, Redis/NATS bus) — but
  that is a different product from a 200-seat room.

---

## 5. Large streams and webinars: one-way fan-out

### 5.1 Role split

| Role | Publishes media | Sends chat/events | Receives | Transport |
|---|---|---|---|---|
| Host | yes | yes | all | WS |
| Moderator | no (or yes) | yes + moderation queue | all + queue | WS |
| Panelist | yes | yes | all | WS |
| Viewer, small webinar (≤200) | no | moderated | all | WS is acceptable; SSE is already better |
| Viewer, large webinar/stream (200–10k+) | no | moderated POST | all | **SSE + HTTP POST** |
| HLS viewer | no | optional POST | video via HLS; events via SSE overlay | **HLS + SSE** |

The threshold is a product/config decision, not a protocol one. Suggested rule:

- `mediaMode: mesh|sfu` and `viewerLimit ≤ 200` → WS for everyone (simplest).
- `mediaMode: broadcast` and `viewerLimit > 200`, or `streaming.provider` is
  HLS/RTMP → WS only for host/mod/panelist; viewers use SSE.
- Video-only landing page (`/live.html`) → HLS for video; SSE overlay for chat.

### 5.2 Viewer SSE contract (proposed)

```http
GET /v1/rooms/{roomId}/events?after=123 HTTP/1.1
Accept: text/event-stream
Last-Event-ID: 123
Authorization: Bearer <short-lived viewer ticket>
```

> The header form above is for `fetch`/`ReadableStream` clients or native SDKs.
> Browser `EventSource` cannot set `Authorization`; use a cookie or a short-lived
> ticket in the query string instead (see the auth bullet below).

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive

retry: 2000

id: 124
event: chat
data: {"v":1,"roomId":"r1","seq":124,"ts":1760000000000,"type":"chat","data":{...}}

: hb

id: 125
event: reaction-summary
data: {"v":1,"roomId":"r1","seq":125,"ts":1760000000000,"type":"reaction-summary","data":{"👍":42,"❤️":17}}
```

- **One stream per viewer.** The same event envelope as WS (`type` + `data`),
  plus `seq`, `roomId`, `ts` and a schema version. Old clients ignore unknown
  fields; new clients use `seq`.
- **`id:` = `seq`.** `Last-Event-ID` on reconnect is the last applied `seq`.
  `after=` is the explicit query equivalent for clients that cannot set headers.
- **`retry:`** is a hint (2,000 ms) but the client must add jitter (0–30%) to
  avoid a thundering herd after a deploy or network blip.
- **Event types:** `snapshot`, normal room events (`chat`, `reaction-summary`,
  `presence-summary`, `caption`, `config`, `moderation`, `promote`), plus
  `lag` (dropped/coalesced) and `close` (moderation/kick/end). `event:` may name
  the type; the payload also carries `type` for clients that only parse `data`.
- **Auth.** `EventSource` cannot set an `Authorization` header. Use a
  short-lived, single-use viewer ticket in the query string (bound to
  room/tenant/role, 30–60 s TTL), or a `Secure; HttpOnly; SameSite` cookie for
  same-origin embeds. If the SDK is cross-origin and needs headers, use
  `fetch()` + `ReadableStream` and implement reconnect in the client. Never put
  the long-lived join JWT in a URL that proxies/CDNs log.

### 5.3 Replay cursor and `Last-Event-ID`

- The room owner assigns `seq` and appends `{seq, ts, type, data}` to a bounded
  Redis Stream (`MAXLEN ~ 10k` or ~1 h, whichever is smaller), and to the chat
  history store for the last 200 messages.
- On connect:
  1. Read `Last-Event-ID` (or `after`). Clamp it to `[oldest, current]`; reject
     a cursor from another room via the ticket binding.
  2. If the cursor is within the stream, replay `seq > cursor`, then stream live.
  3. If the cursor is too old (evicted) or absent, send a `snapshot` event
     (room state + last 200 chat messages + current `seq`) and stream from
     `snapshot.seq + 1`.
- Gaps (owner crash, producer error) are detected by a missing `seq` on the
  client; the client requests a snapshot rather than silently losing chat.
- Client behavior: apply by `seq` (idempotent), persist `lastSeq` in
  `sessionStorage`/memory, reconnect with `Last-Event-ID`, and show a
  "reconnecting/restoring" state (`call-continuity.md` has the same idea for
  WS resume).
- **Replay abuse:** cap the replay window (e.g., 10k events or 5 min), rate-limit
  reconnects per ticket/IP, and never let a cursor read another room.

### 5.4 Backpressure

- Per-stream bounded queue (~256 KiB–1 MiB; the bench used 512 KiB). Track
  `writableLength` / `res.write()` false. When above the watermark:
  - drop/coalesce P2 events (`reaction`, `typing`, cursor) first;
  - coalesce P1 (`presence`, `state`, `caption` partials);
  - never drop P0 (`chat`, `system`, `moderation`, `close`, `snapshot`);
  - if the P0 queue still exceeds the hard ceiling, close the stream with
    `retry` and let the client reconnect with `Last-Event-ID` (the stream is the
    buffer, not the socket).
- Heartbeat every 15–30 s (`: hb\n\n`) to keep proxies/CDNs from idling out.
  The bench used 30 s (longer than the run) to isolate connection/fan-out cost;
  production should use 15 s.
- A slow viewer must cost bounded memory. Test it by pausing reads in a client
  and asserting RSS/queue depth; do not rely on TCP backpressure alone.

### 5.5 Rate limits and moderation

Viewer ingress is HTTP, not the SSE stream:

| Action | Endpoint | Limit (proposal) |
|---|---|---|
| Chat | `POST /v1/rooms/{id}/chat` (existing) | 1 message / 2 s per viewer, burst 3; per-IP and per-tenant buckets |
| Reaction | `POST /v1/rooms/{id}/reactions` (new) | 5 / 10 s per viewer; server aggregates |
| Raise hand | `POST /v1/rooms/{id}/raise-hand` (or existing queue) | 1 / 10 s per viewer; moderator queue |
| SSE connect | `GET /v1/rooms/{id}/events` | 1–2 streams per viewer ticket; per-IP cap for NAT; connect-rate limit |
| Reconnect | same | token bucket + jitter to prevent storms |

- **Moderation is pre-broadcast.** With `webinar.chatMode: moderated`, accepted
  messages enter the queue; only approved messages get a `seq` and are appended
  to the stream. Rejected/shadow-banned messages are dropped or shown only to
  the author; audit the decision (`chat.sent`, `admin.action`).
- **Reactions must be aggregated.** At 100k viewers, fanning out individual
  reactions is an amplification attack. Increment a per-emoji counter per
  100–250 ms and broadcast a `reaction-summary`; cap unique emoji and total
  events/s. The same applies to typing indicators (coalesce) and presence
  (summarize counts, not every join/leave).
- **Spam/abuse:** slow mode, banned words, link limits, CAPTCHA for anonymous
  viewers, per-tenant allowlists, and an emergency "viewers read-only" switch.
  The existing role/feature gates (`session.chat.allowHostInjection`,
  `allowSystemMessages`, roles) still apply to POST ingress.
- **History:** SSE carries live events only; `snapshot` carries the last 200
  messages (matching the WS `welcome.history` contract). Older history stays on
  REST.

### 5.6 Media and CDN

- **Video is not SSE.** Viewers get HLS/LL-HLS via CDN (`hls-viewer.md`);
  interactive participants get WebRTC via SFU. The SSE stream carries only
  events.
- **SSE and CDNs.** SSE is a plain HTTP response, so a CDN can terminate TLS and
  hold viewer connections; it is not cacheable. Require `Cache-Control:
  no-cache, no-transform`, `X-Accel-Buffering: no`, no gzip buffering, and a
  heartbeat shorter than the CDN/proxy idle timeout. Verify per vendor whether
  SSE is passed through, buffered, or multiplexed to origin: **origin fan-out is
  the thing to test**, not the marketing checkbox "supports SSE".
- **WebSocket and CDNs.** WS is a tunnel/upgrade; support varies, caching and
  edge fan-out do not apply, and stateful gateways usually need origin
  affinity. That is the wrong shape for a million passive viewers.
- **HLS page today has no chat** (`hls-viewer.md` "Ограничения"). Adding an SSE
  overlay + moderated POST ingress closes that product gap without putting the
  viewer on the SFU.

### 5.7 Viewer → interactive upgrade

A viewer who is promoted (raise hand accepted, panelist invite) must not keep
two connections:

1. Server sends `event: promote` with a short-lived WS ticket (and, if needed, an
   SFU token).
2. Client closes the SSE stream, opens `/ws` with the normal token subprotocol,
   and sends `after=<lastSeq>` (or a `hello` field) so the server replays missed
   events.
3. Server marks the participant as interactive, starts presence/media, and
   continues the same room `seq`. No duplicate peer, no gap.
4. If the upgrade fails, the client falls back to SSE and shows a retry
   affordance.

This is the only place where the two planes meet; keep it explicit and tested.

---

## 6. Capacity, connection cost and measurements

### 6.1 Measured: 1,000 WS and 1,000 SSE (actual, not an estimate)

Host: Intel Core i3-10100F, 4 cores / 8 threads, 31.92 GiB RAM, Windows
10.0.26200, Node v23.11.0. Loopback `127.0.0.1`, no TLS, no proxy, no CDN, no
packet loss. Plan: 1,000 connections, 1 client process, 3 s idle, 15 s publish at
5 events/s, 256 B payload, heartbeat 30 s. Server and clients share one CPU.

| Metric | WS | SSE |
|---|---|---|
| Connections opened | 1,000 / 1,000 | 1,000 / 1,000 |
| Connect p50 / p95 / p99 | 93.25 / 109.93 / 113.64 ms | 78.76 / 101.89 / 104.2 ms |
| Connect ramp | 1.07 s (933 conn/s) | 1.07 s (936 conn/s) |
| Fan-out p50 / p95 / p99 | 26 / 69 / 77 ms | 30 / 75 / 87 ms |
| Events published / delivered | 75 / 75,000 | 75 / 75,000 |
| Delivery loss / dropped | 0% / 0 | 0% / 0 |
| Server RSS per connection | **10.26 KiB** | **12.61 KiB** |
| Client RSS per connection | 4.99 KiB | 16.09 KiB |
| Server CPU during publish | 5.641 s / 75,000 | 6.125 s / 75,000 |
| Server CPU per 1k deliveries | **75.21 ms** | **81.67 ms** |
| Server event-loop p99 | 83.3 ms | 91.2 ms |

Reports:

- `realtime-summary-2026-11-17T19-56-45-841Z.md`
- `realtime-ws-1000-2026-11-17T19-56-45-841Z.md`
- `realtime-sse-1000-2026-11-17T19-56-45-841Z.md`
- Raw JSON: `realtime-1000-2026-11-17T19-56-45-841Z.json`

Reading the numbers:

- **Per-connection state is small** (10–13 KiB app RSS). Kernel socket buffers,
  TLS state and proxy state are *not* in that number; budget 50–100 KiB per
  connection all-in for planning (§6.3).
- **SSE costs slightly more on the server** (HTTP response + write path) and
  more on the Node client (SSE parser), but both are in the same order of
  magnitude. The transport is not the differentiator; topology is.
- **Fan-out p95 is tens of milliseconds on a shared 8-thread host**, with the
  publisher bursting 5,000 writes/s. A single Node process serializes those
  writes: the 91 ms event-loop p99 at 1k is the warning sign. At 10k per process
  the burst would be ~900 ms unless the work is sharded. This is why the target
  is 1k+ per **process**, not 1M per process.
- **First-event numbers are not comparable across transports.** WS receives a
  `welcome` immediately; SSE has no welcome, so its "first event" waits for the
  first published event (~3.6 s in this plan). Do not use that row to compare
  transports.

### 6.2 What this benchmark does not prove

- It is loopback on **one host and one CPU**; client and server compete for the
  same cores. It is not internet RTT, TLS, a proxy, a CDN, a browser, or packet
  loss.
- It uses **Node synthetic clients** (`ws` / `http`), not browsers. Browser
  connection limits are discussed in §7.4 from specifications, not measured
  here (this docs-only pass avoids a heavy browser run; `qa/realtime/probe.html`
  exists for a manual probe).
- The 256 B payload and 5 events/s are **not** a chat workload model. Chat is
  burstier; reactions are more frequent; video is not in this path at all.
- A 5,000-connection and a 10,000-connection SSE run were attempted on the same
  host and both **timed out waiting for the full connection count** (300 s and
  240 s) without recording a partial count. That is a limitation of this
  single-host synthetic harness (client processes, OS socket handling, shared
  CPU), **not evidence that 10k SSE is impossible**. It is exactly why the
  10k/100k numbers below are estimates and why the 10k/node target needs a
  distributed load generator (multiple hosts/processes) before it is claimed.

### 6.3 Per-connection cost model (estimates clearly marked)

Measured app RSS is the floor. Production per connection:

```text
all_in_bytes_per_conn ≈ app_rss + TLS + proxy + kernel socket buffers + app buffers
                      ≈ 10–13 KiB + 30–80 KiB
                      ≈ 50–100 KiB (planning range; assume 50 KiB for tables)
```

CPU per delivery (measured, frame serialized once and written to N sockets):

```text
cpu_per_delivery ≈ 75 µs (WS) / 82 µs (SSE)   # loopback, one process
production overhead ≈ ×2–3 for TLS, proxy, per-viewer templating, GC, metrics
```

At 2 and 5 events/s per viewer, with a 320 B SSE frame / ~300 B WS frame
(256 B payload + envelope/framing):

| Viewers | App RSS (SSE) | All-in RSS @50 KiB | CPU @2 ev/s | CPU @5 ev/s | Egress @2 ev/s | Egress/day @2 ev/s |
|---:|---:|---:|---:|---:|---:|---:|
| 1k | 12.3 MiB | 48.8 MiB | 0.16 core | 0.41 core | 5.1 Mbps | 55 GB |
| 10k | 123 MiB | 488 MiB | 1.6 cores | 4.1 cores | 51 Mbps | 553 GB |
| 100k | 1.20 GiB | 4.77 GiB | 16 cores | 41 cores | 512 Mbps | 5.5 TB |
| 1M | 12.0 GiB | 47.7 GiB | 163 cores | 408 cores | 5.1 Gbps | 55 TB |

**These are estimates**, not measured above 1k. WS app RSS is ~20% lower and CPU
~8% lower, but WS adds sticky state, per-connection auth/heartbeat, and — the
decisive difference — **no CDN offload**: the origin carries the viewer egress
and connection count itself.

WS equivalents under the same model (300 B frame, measured 75 µs/delivery):

| Viewers | WS app RSS | CPU @2 ev/s | CPU @5 ev/s | Egress @2 ev/s |
|---:|---:|---:|---:|---:|
| 1k | 10.0 MiB | 0.15 core | 0.38 core | 4.8 Mbps |
| 10k | 100 MiB | 1.5 cores | 3.8 cores | 48 Mbps |
| 100k | 0.98 GiB | 15 cores | 38 cores | 480 Mbps |
| 1M | 9.8 GiB | 150 cores | 376 cores | 4.8 Gbps |

Notes:

- CPU is per **process** in the measurement. A single Node process effectively
  uses one core for this loop; 16 cores means ~16 processes/containers sharded
  by room/viewer range. The fan-out tier is embarrassingly shardable because
  SSE viewers are stateless (the stream is the buffer).
- Egress assumes each viewer receives one copy; CDN edge termination can reduce
  origin egress to the number of edge connections/POPs, but **verify whether
  your CDN multiplexes SSE to origin** — many do not. Even without origin
  multiplexing, the CDN still absorbs viewer TLS, connection state and last-mile
  egress.
- Video is not in this table and dominates: 100k viewers at 2.5 Mbps for a 2 h
  event ≈ 225 TB, vs ~460 GB for 2 events/s of SSE over the same event. The
  event plane is ~0.2% of the CDN bytes; optimize it for reliability and CPU,
  not for byte count.

### 6.4 10k / 100k / 1M: how to read the estimates

| Scale | What is proven | What is estimated | What to do next |
|---|---|---|---|
| 1k | measured, 0% loss, one process (§6.1) | — | use as the per-process baseline |
| 10k | not in this repo | 1.6–4.1 cores at 2–5 ev/s; ~0.5 GiB all-in; 1–4 processes | run a multi-process, multi-host load test; target 10k/node |
| 100k | not in this repo | 16–41 cores; ~5 GiB all-in; 16–41 processes; 512 Mbps–1.3 Gbps | SSE fleet + CDN pass-through; 100k is an edge/fleet problem |
| 1M | not in this repo | 163–408 cores; ~50 GiB all-in; 5–13 Gbps; 163–408 processes/workers | CDN must terminate and fan out; do not build 1M SSE on one origin |

The exact node count is less important than the shape: **CPU and connections
scale linearly and shard horizontally; bytes are cheap for events but not for
video; the origin is the wrong place to terminate a million viewer sockets.**

---

## 7. WS vs SSE vs MQTT vs WebTransport

### 7.1 Capability comparison

| Property | WebSocket | SSE | MQTT | WebTransport |
|---|---|---|---|---|
| Direction | full-duplex | server → client | pub/sub (both, via broker) | streams + datagrams (both) |
| Transport | TCP after HTTP/1.1 Upgrade | HTTP/1.1 or HTTP/2/3 | TCP (or MQTT over WS in browsers) | HTTP/3 / QUIC |
| Browser API | `WebSocket` | `EventSource` (or `fetch` stream) | no native; MQTT.js over WS | `WebTransport` (recent engines) |
| Binary | yes | no (base64 only) | yes | yes |
| Auto-reconnect | no (implement) | yes (`retry:`) | client library/broker session | no (implement) |
| Replay/resume | custom (`seq`, resume token) | `Last-Event-ID` built in | QoS 1/2, retained, session | custom |
| Proxy friendliness | upgrade, timeouts, sticky | plain HTTP, but buffering/timeouts | broker port/WS | HTTP/3 infra, limited proxies |
| CDN friendliness | tunnel/pass-through; no cache/fan-out | HTTP; pass-through/edge termination; not cached | broker, not CDN | limited today |
| Server state/conn | room membership + socket | response + cursor (lighter) | broker session/subscription | stream state |
| Head-of-line blocking | TCP | TCP; HTTP/2 multiplexes streams but TCP HOL remains | TCP | none (QUIC streams) |
| Best fit | interactive/signaling | one-way large audiences, replay | device/edge fleets, QoS | future low-latency interactive |

### 7.2 Why not MQTT for browser viewers

MQTT is a good protocol with the wrong shape for this job:

- Browsers have no native MQTT; they use **MQTT over WebSocket**, so you still
  pay the WS upgrade at the edge and add a broker hop.
- You inherit a broker fleet (EMQX/HiveMQ/Mosquitto), topic/ACL design, QoS
  state, retained messages and session expiry. That is useful for an edge/device
  fleet (`agil/edge`) or server-to-server fan-out, not for a webinar viewer whose
  only job is to receive chat.
- QoS 1/2 adds acks and duplicate handling; our chat already has idempotent
  message IDs and a room `seq`.
- Retained messages can model snapshots, but a Redis Stream + `Last-Event-ID`
  is simpler and already fits the HTTP/CDN edge.

Use MQTT only if the product adds a device/agent fleet with constrained
networks and QoS requirements. Do not put it in front of browser viewers.

### 7.3 Why not WebTransport (yet)

WebTransport over HTTP/3 is the right long-term answer to TCP head-of-line
blocking and gives unreliable datagrams for cursor/reactions. But:

- It needs HTTP/3/TLS infrastructure end-to-end, and proxy/CDN support is less
  mature than HTTP/1.1–2.
- Browser support is recent/partial; a fallback to WS/SSE is mandatory.
- Text chat and viewer fan-out do not need datagrams or multiple streams; the
  complexity buys little for this workload.

Treat WebTransport as a **future enhancement for interactive control/media**,
behind a flag, with WS/SSE fallback. It is not a reason to delay SSE.

### 7.4 Per-connection, proxy and browser limits

| Limit | WS | SSE |
|---|---|---|
| Browser HTTP/1.1 per-origin connections | not the 6-connection HTTP pool in most engines, but engine/OS socket caps apply | **6 per origin** (SSE counts); one stream per tab is the rule |
| HTTP/2 concurrency | upgrade is HTTP/1.1 (extended CONNECT exists but is not the norm) | one TCP per origin, ~100 concurrent streams (server `SETTINGS_MAX_CONCURRENT_STREAMS`, commonly 100–128) |
| Browser API headers | subprotocol only; token in subprotocol/query/first frame | `EventSource` cannot set `Authorization`; use cookie/ticket or `fetch` stream |
| Proxy idle timeout | needs ping/pong and `proxy_read_timeout` > heartbeat | needs heartbeat and `proxy_buffering off`; `X-Accel-Buffering: no` |
| CDN | tunnel/pass-through; origin affinity if stateful | pass-through/edge termination; not cached; verify buffering and origin multiplexing |
| Mobile background | OS suspends sockets | OS suspends streams; push notification to wake |
| Compression | `permessage-deflate` costs CPU | gzip can buffer; prefer identity/flush for low latency |
| Server FDs | ~1 per connection; raise `nofile` | ~1 per connection; same |
| TLS | handshake CPU per connection; session resumption helps | same |

Practical rules:

- **One SSE stream per viewer tab.** Multiple tabs each need their own stream;
  HTTP/1.1's six-connection cap makes a second stream expensive. Prefer
  HTTP/2/3 to the edge.
- **Heartbeat below every proxy timeout.** 15 s is a good default; make it
  configurable per deployment and test the actual LB/CDN.
- **Do not rely on EventSource headers.** A short-lived ticket in the query
  string is acceptable only with `Referrer-Policy` and log redaction; a cookie
  is better for same-origin embeds; `fetch` streaming is best when the SDK
  controls the client.
- **WebSocket per-tab count is not a design tool.** Even if an engine allows
  many sockets, every socket is a server object and a mobile battery cost.
- **TLS and conntrack are real capacity.** A load balancer tracks every
  connection; 1M viewers means 1M conntrack entries and 1M TLS sessions at the
  edge. That is exactly what CDNs are for.

---

## 8. Recommendation and targets

> **Do not use WebSocket for millions of passive viewers.** Use WS for the
> interactive control plane; use SSE/HTTP + CDN for viewers; keep media on
> WebRTC/HLS.

### 8.1 Targets

| Target | Value | Status |
|---|---|---|
| Interactive room | **200 WS per room** (one per participant) | product cap at `high`; 200 WS validated on the pilot for signaling |
| WS node sizing | 200-session validated units; raise toward the 5–10k orientation only after multi-room/Redis load tests | design; current single node |
| Viewer per process | **1,000+ SSE** | measured here (1,000, 0% loss) |
| Viewer per node | 10,000+ SSE | engineering target; needs multi-process + multi-host test |
| Viewer fleet | 100,000+ SSE | SSE fleet + CDN pass-through/edge termination |
| Largest audience | millions | CDN termination + room/viewer sharding; never one origin |
| Media | WebRTC for interactive; HLS/LL-HLS for passive | existing SFU/HLS paths |

### 8.2 Decision rules

1. A peer that publishes media or needs bidirectional sub-second control → **WS**.
2. A peer that only receives events, and may send occasional moderated messages
   → **SSE + POST**.
3. A peer that only watches video → **HLS/LL-HLS**, with an optional SSE overlay
   for chat.
4. A device/agent fleet with QoS/constrained networks → evaluate **MQTT**; not
   browser viewers.
5. A future low-latency interactive feature that needs QUIC → **WebTransport**
   experiment with WS/SSE fallback; not a replacement for SSE today.

### 8.3 What not to do

- Do not multiplex audio/video over WS or SSE.
- Do not put a million WS sockets behind one LB or one Node process.
- Do not use Redis pub/sub as the only event log; it cannot replay.
- Do not fan out individual reactions at 100k; aggregate.
- Do not use long polling as the viewer fallback; SSE is simpler and cheaper.
- Do not rely on `EventSource` with an `Authorization` header.
- Do not claim 200-person *media* capacity from a 200-socket signaling test
  (`qa-load-200-ws.md` is explicit about this).
- Do not advertise 200 viewers on the HLS page until the SSE overlay and
  moderation path exist.

---

## 9. Migration plan

No deployment is part of this change. The plan is intentionally additive: WS
keeps working, SSE is introduced behind a flag, and media is untouched.

### 9.1 Phases

| Phase | Change | Exit gate | Rollback |
|---|---|---|---|
| **0. Contract and bus** | Add `seq`/`v` to the room event envelope; extract `RoomEventBus` (`publish`, `readFrom`, `snapshot`) with an in-process implementation; add a bounded ring buffer and metrics. No user-visible change. | Unit tests: monotonic seq, envelope round-trip, replay from cursor, snapshot fallback. The 1k WS/SSE harness still passes (it exercises the transport shape, not the product). | Remove the abstraction (no data migration) |
| **1. SSE endpoint** | Add `GET /v1/rooms/:id/events` (SSE), viewer ticket endpoint, `Last-Event-ID` replay, heartbeat, bounded queue, `lag`/`close`, per-ticket/IP rate limits. Reuse `POST /chat` as ingress; add `POST /reactions`. Behind the tenant/room flag `realtime.viewerTransport` (`ws` / `sse` / `auto`). | 1k SSE (this harness), 200 WS (`load-ws.mjs`), replay-after-disconnect, slow-consumer test, moderation/rate-limit tests, security review. | Flag off → WS |
| **2. Viewer UX** | For `broadcast` rooms above the threshold, viewers use SSE; host/mod/panelist stay on WS. Add the SSE overlay to `/live.html`; add `promote` (SSE → WS) and missed-event replay. Dashboard shows WS/SSE counts. | 10k-viewer synthetic test on multiple processes/hosts; 200-viewer webinar smoke; promote/demote; reconnect storm; no duplicate peers. | Per-tenant flag; viewers fall back to WS |
| **3. Scale-out** | Redis Streams as the event log; stateless SSE fleet; room/viewer-shard routing; CDN pass-through/edge termination; autoscaling; WS room ownership/leases/sticky per `scaling.md` §4. | 100k SSE with CDN; owner failover; Redis outage drill; deploy during a live stream; cost within budget. | Keep the single-node SSE path; CDN bypass |
| **4. Future** | WebTransport experiment for interactive control; MQTT only for an edge/device fleet; optional third-party fan-out evaluation. | Business need + measured benefit; fallback proven. | Feature flag |

### 9.2 Compatibility

| Surface | Before | After | Breaking? |
|---|---|---|---|
| `GET /ws` | all participants | host/mod/panelist/interactive; viewers may use SSE | no (old clients still work) |
| `POST /v1/rooms/:id/chat` | broadcasts over WS | also appends to the event log; SSE viewers receive it | no |
| `GET /v1/rooms/:id/events` | n/a | new SSE endpoint | additive |
| `POST /v1/rooms/:id/reactions` | n/a | new viewer ingress | additive |
| Event envelope | no `seq` | `v`, `roomId`, `seq`, `ts`, `type`, `data` | additive; old clients ignore |
| `/live.html` | HLS only | HLS + optional SSE overlay | additive |

- Keep the WS message catalogue and `welcome` shape unchanged. Add
  `welcome.events = { transport, url, seq }` only for clients that opt in.
- The REST `join`/token flow stays the source of truth. The viewer ticket is
  derived from it (room/tenant/role bound, short TTL); do not create a second
  auth system.
- `chat` idempotency (`id`) and history (last 200) stay; SSE reuses them.

### 9.3 Acceptance and observability

Contract/load gates before each phase:

- **Contract:** envelope, seq monotonicity, replay from `Last-Event-ID`,
  snapshot on evicted cursor, `lag`/`close`, ticket binding (cross-room replay
  rejected), idempotent chat.
- **Load:** 1k SSE per process (existing harness), 10k/node (multi-process),
  100k (fleet + CDN), 200 WS (`load-ws.mjs`), 200-person signaling unchanged.
- **Soak:** 1 h at target, deploy during stream, Redis failover, reconnect storm
  (all clients reconnect within a 10 s window with jitter).
- **Security:** ticket TTL/single-use, no token in logs/referrers, rate limits,
  CORS, moderation bypass attempts.
- **Product:** `/live.html` overlay, promote/demote, slow mode, shadow ban,
  reaction aggregation, chat history.

Metrics to add (before scale-out):

- active WS / SSE per room and per node; connect/disconnect rate; connect p95;
- fan-out p95/p99 per transport; event-loop lag; queue depth; drops by priority;
- replay count, snapshot fallback count, `Last-Event-ID` age, reconnects/ticket;
- rate-limit hits; moderation queue depth/age; CDN 5xx/timeout rate;
- bytes/event, CPU per 1k deliveries, RAM per connection.

Alert on: event-loop p99 > 200 ms for 5 min, SSE queue drops of P0, replay
failure rate > 1%, connect error rate > 1%, CDN 5xx > 0.5%, owner lease churn.

---

## 10. Costs

All numbers are **planning estimates**, not vendor quotes. Replace the unit
prices with your contracts; 2026 cloud/CDN prices vary by 5–10× with commitment.

### 10.1 Event plane

Assumptions: 2 events/s per viewer, 320 B/event SSE, 50 KiB all-in per
connection, 10k SSE per node (target; multi-process), 2× redundancy.

| Scale | Nodes @10k (base → 2×) | Event egress/day | Egress $/day @ $0.02/GB | Egress $/day @ $0.08/GB |
|---:|---:|---:|---:|---:|
| 1k | 0.1 → 2 (HA) | 55 GB | $1.10 | $4.40 |
| 10k | 1 → 2 | 553 GB | $11 | $44 |
| 100k | 10 → 20 | 5.5 TB | $110 | $440 |
| 1M | 100 → 200 (or CDN) | 55 TB | $1,100 | $4,400 |

Compute at 100k/2 ev/s: ~16 cores measured loopback, ~35–50 cores after TLS,
proxy, templating and headroom; at $0.04/core-hour that is roughly
$1.0k–1.5k/month before RAM/LB. At 1M, 10× — which is why CDN edge fan-out, not
a bigger origin, is the answer.

### 10.2 Video dominates

For a 2 h event at 100k viewers and 2.5 Mbps HLS:

```text
video bytes  ≈ 100,000 × 2.5 Mbps × 7,200 s / 8 ≈ 225 TB
video egress ≈ 225 TB × $0.02/GB ≈ $4,500   (≈ $1,125 at $0.005/GB committed)
SSE bytes    ≈ 100,000 × 2 ev/s × 320 B × 7,200 s ≈ 460 GB ≈ $9
```

The event plane is ~0.2% of the video egress. The economic argument for SSE is
therefore not "bytes are cheaper" (they are, but both are small next to video);
it is **connection/CPU/ops cost and CDN offload**. A WS viewer plane would put
the same viewer count and egress on origin, with sticky state and per-connection
auth, and still need the video CDN separately.

### 10.3 WS at the same scale

At 100k WS: similar CPU (~15–40 cores), ~1 GiB app RSS (plus TLS/proxy), but
~0.5–1.2 Gbps of origin egress (at 2–5 ev/s), no CDN cache/fan-out, and a
stateful LB with room affinity. At 1M WS: 10× the compute and ~5–12 Gbps origin
egress; a distributed gateway is a significant platform project. It can be done;
it is simply not the cheapest or simplest shape for one-way traffic.

### 10.4 Engineering and operations

- New backend: event log/bus, SSE endpoint, tickets, replay, backpressure,
  moderation ingress, metrics (medium-sized; not a weekend change).
- Client/SDK: SSE client with reconnect/cursor, `/live.html` overlay, promote
  path, UI states.
- Ops: new tier to monitor, CDN configuration, load tests, runbooks, on-call.
- Avoided: a WS gateway fleet for viewers, per-viewer sticky state, and
  per-viewer WS auth/heartbeat at the edge.

A rough build estimate is a few person-months across backend + client + QA; the
repo's `estimate.md` is the place for a committed schedule, not this document.

---

## 11. Risks and mitigations

| Risk | Impact | Mitigation | Detection |
|---|---|---|---|
| Redis pub/sub loses or reorders events | missing/duplicated chat | Streams + `seq` + snapshot; idempotent client apply; never use pub/sub for durable events | replay gap counter, snapshot rate |
| Room lease split-brain | duplicate owners, seq collisions | fencing token, single writer, CAS renew, TTL; drain before handover | lease churn/owner conflict alerts |
| Owner node dies mid-stream | room drops, viewers stall | resume tokens, snapshot restore, stream replay, N+1 nodes | reconnect rate, restore failures |
| SSE buffered by proxy/CDN | no events / high latency | `X-Accel-Buffering: no`, `no-transform`, no gzip buffering, heartbeat, per-proxy integration test | connect OK but zero events; p95 spike |
| Idle timeout / reconnect storm | mass disconnect, thundering herd | 15 s heartbeat, `retry:` + jitter, capacity headroom, load-shed at edge | reconnect rate, 5xx rate |
| Slow viewer grows memory | process OOM, all viewers affected | bounded per-stream queue, priority drop, close + replay, per-process cap | queue depth, RSS, drops |
| Event-loop saturation | latency for all rooms on the node | 1k+ per process, shard by room/viewer, autoscale, load test | event-loop p99, fan-out p95 |
| Per-viewer JSON/templating cost | CPU higher than measured | serialize once per event, avoid per-viewer payloads, batch/coalesce | CPU per 1k deliveries |
| Auth ticket leakage | room eavesdropping | short TTL, single-use, room-bound, cookie or `fetch` headers, redact query in logs, `Referrer-Policy` | ticket reuse, cross-room attempts |
| Replay abuse | data exposure / CPU | clamp cursor, max window, rate limit, room-bound ticket | replay volume per ticket/IP |
| Spam / moderation bypass | abuse at 100k | pre-broadcast queue, slow mode, CAPTCHA, shadow ban, audit, read-only switch | queue depth/age, report rate |
| Reaction amplification | fan-out storm | aggregate per 100–250 ms, cap emoji/events, sample | events/s per room |
| CDN does not pass SSE well | viewer outage | vendor test, origin fallback, heartbeat, `no-transform`, alternate edge | CDN 5xx/timeout, zero-event rate |
| Browser per-origin limits | second tab fails | one stream per tab, HTTP/2/3, document limits, graceful error | client telemetry |
| Dual-path drift (WS vs SSE) | inconsistent UX/bugs | shared envelope + contract tests + feature matrix; SSE mirrors WS event types | contract test failures |
| Cost overrun | CDN bill | budget/alerts, video egress is the driver, commit pricing, sampling, regional routing | daily egress vs budget |
| Privacy/compliance | IP/token in CDN logs | DPA, redaction, retention, data residency, no PII in events | audit/privacy review |
| WebTransport fragmentation | wasted effort | defer; flag + fallback; no dependency for SSE | browser matrix |

---

## 12. Open questions

1. **Does the chosen CDN multiplex SSE to origin, or does every edge connection
   open an origin stream?** This changes the 100k/1M origin math; test it before
   committing to a vendor.
2. **What is the viewer event SLO?** Sub-second chat vs 2–5 s acceptable changes
   batching, heartbeat and buffer sizes.
3. **How much moderation is staffed vs automated at 100k?** Pre-broadcast queues
   are only as good as the review capacity.
4. **Do viewers need presence/typing?** If yes, summarize/coalesce; if no, do not
   build it at scale.
5. **Build vs buy for viewer fan-out** (Ably/Pusher/Cloudflare/Redis-based). A
   managed fan-out may be cheaper than an SSE fleet for sporadic large events;
   keep the event contract portable.
6. **Billing for viewer minutes.** Current billing is room/participant-minute
   based (`billing.md`); decide whether passive viewers count and how SSE
   sessions are metered.
7. **Retention of the event log.** Streams are bounded; chat history is separate.
   Define retention/audit requirements before choosing `MAXLEN`.
8. **When does interactive WebTransport matter?** Only after a measured latency
   problem that WS cannot solve; not for chat.

---

## Appendix A — Event envelope and SSE examples

Envelope (same JSON inside WS frames and SSE `data:`):

```json
{
  "v": 1,
  "roomId": "demo-room",
  "seq": 124,
  "ts": 1760000000000,
  "type": "chat",
  "data": {
    "message": {
      "id": "c-42",
      "roomId": "demo-room",
      "from": { "id": "u-7", "name": "Анна", "role": "viewer" },
      "text": "Когда начнём?",
      "ts": 1760000000000,
      "kind": "text"
    }
  }
}
```

Snapshot (first event when there is no usable cursor):

```text
event: snapshot
id: 124
data: {"v":1,"roomId":"demo-room","seq":124,"ts":1760000000000,"type":"snapshot","data":{"room":{...},"history":[...],"participants":[...]}}
```

Lag (events were dropped/coalesced; client may resync):

```text
event: lag
id: 130
data: {"v":1,"roomId":"demo-room","seq":130,"ts":1760000000001,"type":"lag","data":{"dropped":12,"reason":"slow_consumer"}}
```

Close (moderation/kick/end; client stops reconnecting):

```text
event: close
id: 131
data: {"v":1,"roomId":"demo-room","seq":131,"ts":1760000000002,"type":"close","data":{"reason":"kicked","retry":false}}
```

Reconnect flow:

```text
client: GET /events?after=124  (or Last-Event-ID: 124)
server: replay 125..current, then live
client: applies each seq once; persists lastSeq
network drop
client: reconnect after retry + jitter with Last-Event-ID: lastSeq
server: replay from lastSeq+1, or snapshot if lastSeq < oldest
```

Headers that matter:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

## Appendix B — Benchmark reproduction

```bash
# 1k WS + SSE (the measured run in §6.1)
node agil/core/qa/realtime/bench-run.mjs --mode=both --connections=1000 \
  --seconds=15 --rate=5 --payload=256 --clients=1

# one mode only
node agil/core/qa/realtime/bench-run.mjs --mode=sse --connections=1000

# plan without opening sockets
node agil/core/qa/realtime/bench-run.mjs --mode=both --connections=1000 --dry-run

# harness unit tests (no sockets)
node --test agil/core/qa/realtime/test/realtime-bench.test.mjs
```

The runner writes a JSON report and Markdown summaries into
`agil/core/qa/realtime/reports/`. A 10k run needs multiple client processes
(`--clients=4`) and, in practice, multiple hosts; the single-host attempt in this
change did not reach the full count (see §6.2).

The browser probe `agil/core/qa/realtime/probe.html` (`?sse=N` or `?ws=N`) is
available for a manual per-origin limit check; it was **not** run in this
docs-only pass (no heavy browser).

## References

- [scaling.md](scaling.md) — multi-node signaling design, Redis pub/sub, room
  ownership, sticky routing, capacity orientation.
- [large-rooms.md](large-rooms.md) — 200-participant stage 1, capacity profiles,
  SFU media sizing, what is and is not proven.
- [hls-viewer.md](hls-viewer.md) — HLS/CDN viewer page and its current limits.
- [api.md](api.md) — REST + WS signaling (§6 external chat, §10 WS), limits.
- qa-load-200-ws.md — 200 concurrent WS signaling on the
  pilot; explicitly not a media test.
- [load-200-media.md](load-200-media.md) — 50-browser media harness and 200
  targets; not a 200-media claim.
- [call-continuity.md](call-continuity.md) — resume tokens, reconnect semantics.
- [operations.md](operations.md) — SLOs, monitoring, capacity assumptions.
- billing.md — room/participant minutes and quota behavior.
- RFC 6455 (WebSocket), WHATWG HTML (Server-Sent Events / `EventSource`),
  RFC 9113 (HTTP/2), OASIS MQTT 5.0, W3C WebTransport.
