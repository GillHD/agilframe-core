# Large rooms (stage 1): 200 participants

Status: **implemented and tested at the widget/server contract level**. A room
can be configured for up to 200 participants (`scale.maxParticipants`,
`limits.maxParticipants`) **when the deployed capacity profile is `high`**; the
server clamps the stored seat count to `min(room, scale, profile participants,
sfu.maxParticipants)`, so `low` allows 25 and `standard` 50 regardless of the
requested number. The widget renders 25/36 tiles per page (24/35 remote
+ self), and the SFU client subscribes a **capacity-profile video budget**: all
visible videos up to 8 participants, then the profile budget — **low 2,
standard 6, high 12** remote videos per page. Pinned and active-speaker tiles are
always considered first; every other tile renders an avatar with a “play video”
affordance that swaps into the budget. All remote **audio** stays subscribed.

The budget is a property of the **deployed media plane**, not a product limit.
`2 videos/client` is the `low` profile sized for the current 1 vCPU / 2 GB SFU
(the 6-video default overloaded it). A properly sized SFU uses `standard` or
`high` and the same product code serves more videos per client. The table is
planning guidance, not a benchmark: every migration to a larger profile must be
validated with a real load test (§5, §7.1).

This document is deliberately explicit about what is *not* proven: a synthetic
200-participant UI harness is not a 200-way WebRTC load test. Real capacity must
be measured per deployment (see §5 and §7).

---

## 1. Architecture

```
Browser (widget)                         AGIL server (control plane)
┌────────────────────────────┐           ┌─────────────────────────────┐
│ WS signaling (presence,    │◄─────────►│ rooms, chat, roles, audit,  │
│ chat, state, captions, ...)│           │ lobby, config, join tokens  │
│                            │           └──────────────┬──────────────┘
│ LiveKit client (media)     │                          │ short-lived LiveKit JWT
│  - publish mic/cam/screen  │           ┌──────────────▼──────────────┐
│  - subscribe audio: all    │◄─────────►│ LiveKit SFU (media plane)   │
│  - subscribe video: page   │  WebRTC   │ forwarding only, no transcode│
└────────────────────────────┘           └─────────────────────────────┘
```

* **Control plane stays on the AGIL signaling server.** Presence, chat, polls,
  lobby, breakout rooms, captions, assistant and audit do not move to LiveKit.
* **Media plane is LiveKit.** The server issues a short-lived HS256 LiveKit JWT
  in `POST /v1/rooms/:id/join` and in the WS `welcome` (`media` block). The token
  is private to the SFU client: never in state, DOM or logs.
* **The server is the capacity authority.** The effective room cap is
  `min(room.maxParticipants, scale.maxParticipants, profile.participants,
  scale.sfu.maxParticipants)`; for SFU/broadcast rooms the capacity profile
  (`low` 25 / `standard` 50 / `high` 200) is usually the binding limit. Room
  creation clamps the stored seat count to that value; REST join, lobby admit
  and the WS handshake all re-check it and return `409 room_full` with the
  binding reason. See `agil/core/apps/server/src/sfu.ts`
  (`roomCapacityInfo`, `effectiveRoomCapacity`, `capRoomParticipantsForSfu`).
  A low 1 vCPU / 2 GB pilot therefore cannot create a 200-seat room: it is
  clamped to 25 and the 26th join is rejected.
* **Mesh/P2P is 1:1 only.** A room created with `mode:'direct', transport:'p2p'`
  uses the browser-to-browser plane with exactly two seats and no server media
  (`docs/p2p.md`). Grouped mesh rooms still work for small calls (`mediaMode:
  'mesh'`), but P2P is not a large-room mode and must not be described as one:
  the 200-participant story below is SFU/broadcast only.

### 1.1 Scrolling gallery (Web widget)

The Web widget uses continuous vertical scrolling once the room exceeds the
fixed grid capacity of 25 tiles on phones or 36 on wider screens. Scroll with a
mouse wheel, drag the gallery with the mouse, or swipe on a touchscreen. With
keyboard focus on the gallery, arrow keys, Page Up, Page Down, Home and End scroll
the grid. Speaker view still shows one large tile.

* The gallery mounts the visible rows plus one row of overscan on either side.
  The local tile appears once, at the beginning of the grid.
* Only visible remote tiles are eligible for video subscriptions. The same
  capacity profile applies throughout the scroll. Audio stays independent on SFU.
* When an SFU tile returns, its last decoded camera frame can appear for up to
  30 seconds while the live feed reconnects. The tile labels it “Last frame”.
  Frames are kept in the call tab's memory. Screen sharing is excluded.
* The participant list shows the full room. “Show in gallery” pins and reveals
  the exact tile. Manual scrolling pauses speaker follow until it is enabled again.
* The Web SDK's existing `setGalleryPage()` method scrolls the requested group into
  view. Legacy page state still supports integrations that render their own UI.


### 1.2 Capacity-profile video policy

The Web widget applies a bounded video budget to visible tiles. `agil/websdk/widget/src/call/large-room.ts` is the single source of truth
for both the renderer and the SFU policy; the profile table itself lives in
`agil/core/packages/protocol/src/scaling.ts` (`SFU_CAPACITY_PROFILES`).

| Profile | Planned SFU | Participants / node | Remote videos per client (9+ participants) |
|---|---|---|---|
| `low` | 1–2 vCPU / 2 GB | 25 | **2** (pinned + active speaker; current pilot) |
| `standard` | 8–16 vCPU / 16 GB | 50 | **6** (default for new deployments) |
| `high` | 16–32 vCPU / 32 GB | 100–200 | **12** |
| (not a profile) | cascading / more nodes | — | 50 would need a multi-node cascade; not supported by one SFU node |

Rooms with **2–8 participants** always subscribe every visible remote video
(n−1) regardless of profile: a mesh-sized call is cheap, and the profile budget
is a large-room lever. Above 8 participants the profile budget applies.

The budget is filled in this order:

1. **Pinned** participant (if any). The pin is user intent and is never evicted
   by the budget.
2. **Active speaker** (when follow-speaker is on). Without a pin, the speaker is
   selected first and the remaining slots are the first page tiles (or promoted
   tiles) so the page still shows more than one video.
3. **Click-to-play promotion** swaps into the budget. A promotion outranks the
   automatic speaker: when every remaining slot is held by the pin/speaker (for
   example the 2-video low budget with pinned + speaker), clicking “play video”
   on another tile evicts the speaker and keeps the pin. When an ordinary page
   tile can yield instead, the promotion evicts that tile and keeps the speaker.
   Older promotions are evicted before the speaker; the pin is never evicted.
   The promotion cannot exceed the budget.
4. **Self is free.** The local self preview is not an SFU subscription. If the
   pinned or speaking participant is the local self tile, that tile does not
   consume a remote slot, so one more remote participant keeps a video.

A tile outside the budget renders an avatar (`data-video-state="avatar"`) with a
“play video” button (`[data-agil-play-video]`); clicking it promotes the tile.
Promotions are remembered per page and are dropped when the participant leaves.
Pinning a tile has the same effect (the pin is always selected first).

`SfuEngine` connects with `autoSubscribe: false` and applies the explicit policy
(`setVideoSubscriptionPolicy`) on every page/pin/speaker/promotion/profile change:

1. **Audio**: every remote audio publication is subscribed and enabled,
   regardless of page or video budget. Hidden `<audio>` elements play all
   participants, so changing pages never mutes anyone.
2. **Video**: at most one video publication per participant (screen share wins
   over the camera). The desired set is
   `pinned → active speaker → promoted (newest first) → current page order`,
   de-duplicated and cut at the profile budget, which is itself capped by
   the lower of `limits.maxVideoSubscriptions` and `scale.maxVideoSubscriptions`
   (both default to 36). Off-page and budgeted-out video
   publications are disabled and unsubscribed. The controller only passes a
   pinned/speaker id to the engine when the plan actually kept it, so a
   promotion that evicted the speaker cannot silently re-subscribe an extra
   video.
3. **No black tiles**: a tile without a live video track — including a tile
   outside the budget — renders the avatar placeholder
   (`data-video-state="avatar"`, `data-video-suppressed="true"`), never a
   black/frozen `<video>`. The tile also exposes `data-video-budget` /
   `data-video-count` / `data-video-ids` on `.agil-grid` for tests.
4. **Adaptive stream / dynacast** remain enabled in the LiveKit `Room` options.
   The media server can drop layers for slow clients.
5. **Manual quality**: `auto | high | medium | low` in the camera chevron menu.
   * `auto` uses per-tile dimensions (480×270 grid, 1280×720 spotlight) through
     `setVideoDimensions`, leaving adaptive stream in charge;
   * `high/medium/low` pin a simulcast layer through `setVideoQuality`
     (1280×720 / 640×360 / 320×180 intent).
6. **Pinned / speaker view**: the speaker button toggles grid ↔ spotlight. In
   spotlight the pinned participant wins; otherwise the last active speaker is
   the large tile, with the first remote participant as a stable fallback.
   Speaker view renders **one** large tile and subscribes one video (audio is
   still all); paging is hidden until the user returns to the grid. The “Follow
   speaker” switch (default on) jumps the grid page to the speaker’s page and
   updates the spotlight; it can be switched off.

The server always issues `canSubscribe: true`; the *number* of video
subscriptions is a client policy (LiveKit has no per-token subscription quota).
The token therefore cannot “guarantee” 200 videos, and the widget does not try
to subscribe them. On the `low` pilot a 25-person room opens at most **2**
remote videos plus the local self preview; on `standard` it opens at most **6**.
The number comes from the profile, not from a hard-coded constant.

### 1.3 Budget math

```text
total          = remote participants + (self ? 1 : 0)
profile        = AGIL_SFU_PROFILE || scale.sfu.capacityProfile || "standard"
profileBudget  = { low: 2, standard: 6, high: 12 }[profile]

budget =
  total ≤ 8  → max(1, total)       // every visible remote video
  else       → profileBudget        // pinned/speaker first, then page order

budget = limits.galleryVideoBudget ?? scale.maxVisibleVideos ?? budget
budget = min(budget, limits.maxVideoSubscriptions, scale.maxVideoSubscriptions)
```

The override is clamped to 1…1000 and capped by both subscription limits.
The self preview is separate and never counted as
an SFU remote video: a self pin/speaker therefore leaves one more remote slot in
use. Both settings default to **36**. The profile sets the adaptive budget
within that ceiling.

On the server the effective profile is resolved once and surfaced to clients:

* `AGIL_SFU_PROFILE=low|standard|high` (deployment env) wins over tenant config;
* otherwise `scale.sfu.capacityProfile` applies;
* otherwise `standard` is the new-deployment default.

The effective value is returned in `GET /v1/tenants/:id/config`, in the WS
`welcome.config`, and in `GET /v1/admin/scale` (`sfuProfile`, `sfuCapacity`).
The tenant's stored config is not rewritten by the env override.

### 1.4 Direct 1:1 P2P is not a large-room mode

`mode:'direct'` accepts an explicit `transport:'p2p'`, which forces
`mediaMode:'mesh'` and exactly **2** seats (`docs/p2p.md`). It is intentionally
excluded from everything in this document:

* 200 participants, gallery pagination, capacity profiles and the video budget
  apply to **SFU/broadcast** rooms; a P2P room never has an SFU media block;
* P2P is only valid for direct 1:1 rooms. Group rooms reject `transport` with
  `400 validation_failed`, and P2P is rejected with `409 p2p_unsupported` when
  server egress/streaming/webinar needs an SFU;
* do not size an SFU/TURN node for P2P capacity, and do not claim 200
  participants in P2P. For 3+ participants use `transport:'sfu'` with an
  adequately sized SFU and run the load test (§5, §7.1).

---

## 2. Configuration and limits

| Setting | Default | Meaning |
|---|---|---|
| `scale.sfu.capacityProfile` | **standard** | Capacity profile (`low`/`standard`/`high`). Optional; unset = env or `standard`. Profile participants: **25 / 50 / 200**. |
| `AGIL_SFU_PROFILE` (env) | unset | Deployment override: `low`/`standard`/`high`. Wins over tenant config; the current pilot sets `low` (25 participants). |
| Effective room cap | min of four limits | `min(room.maxParticipants, scale.maxParticipants, profile participants, scale.sfu.maxParticipants)` for SFU/broadcast; `min(room, scale)` for mesh. Reported as `effectiveMaxParticipants` + `capacity` in `/v1/admin/scale` and room detail. |
| `scale.maxParticipants` | **200** | Ceiling for room seats. The SFU profile can lower it (low 25 / standard 50). |
| `limits.maxParticipants` | **200** | Default seats for new group rooms. An explicit room size takes precedence within the effective capacity. |
| `limits.maxVideoSubscriptions`, `scale.maxVideoSubscriptions` | **36** each | The lower value caps simultaneous remote video subscriptions. |
| `limits.galleryVideoBudget` | unset (adaptive) | Optional fixed remote-video budget per page (1…1000). Wins over `scale.maxVisibleVideos` and the profile. Raising it above the profile budget requires a sized SFU and a load test. |
| `scale.maxVisibleVideos` | unset (adaptive) | Alias for the gallery budget; `limits.galleryVideoBudget` takes precedence. |
| Adaptive budget | ≤8 all visible; 9+ profile `2/6/12` | Profile budget above 8 participants, pinned + active speaker first. |
| `scale.sfu.maxParticipants` | 5000 | Media-plane hard cap; the effective room cap takes the smaller value (with the profile). |
| `room.mode='direct'` | 2 | 1:1 rooms never exceed 2. |
| UI page size | 36 desktop / 25 phone | 36/25 tiles per page: 35/24 remote + self. |
| UI badge | `200+` | Shown at/above 200 participants (high profile only). |
| `billing.maxParticipants` | plan-specific | When billing is enabled, the plan cap is applied before the SFU/profile cap. |

Validation ranges are unchanged (`maxParticipants` 2…50 000 server-side). The
stage-1 **default** is 200, not a hard global maximum; the **effective** limit
still follows the capacity profile. An operator can raise the room limit only
after raising the profile and the SFU/node sizing (and re-running the media load
test). Persisted tenants that already stored `limits`/`scale` keep their own
values; new/default configs get 200/36 and the `standard` profile (50 rooms).
Do not advertise “200 HD” or “50 videos/client” from configuration alone.

Environment / operations:

* `AGIL_SFU_URL`, `AGIL_SFU_API_KEY`, `AGIL_SFU_API_SECRET` — media plane.
* `AGIL_SFU_PROFILE=low` — the current 1 vCPU / 2 GB pilot **must** set this
  explicitly (the code default is `standard`, sized for an 8–16 vCPU SFU).
  Production with a sized SFU can leave it unset (standard) or set `high`.
* `scale.mediaMode='sfu'` (tenant config / `PUT /v1/admin/scale`).
* `AGIL_JOIN_RATE_LIMIT_PER_MIN` (default **300**) — one office NAT can fill a
  200-seat room within the minute window; the limiter is keyed by IP **and**
  room, and password brute force is separately bounded by the room lockout.
  Raise it only for larger rooms (and re-run the fill test).
* `AGIL_MAX_RECORDING_MB` and egress settings are unrelated to gallery capacity;
  server-side egress adds an SFU participant and CPU cost.

---

## 3. What is supported

* Up to 200 participants in one room on the `high` profile (50 on `standard`,
  25 on `low`), configured and capacity-checked. The profile, not the room
  request, sets the effective cap.
* A single client receiving all remote **audio** (subject to browser/CPU limits,
  see §6) and at most the profile budget of remote **videos** per page (low 2,
  standard 6, high 12; 36 is the tenant hard ceiling, not a default decode
  count).
* Desktop pages of 36 tiles and phone pages of 25 tiles, page navigation,
  participant search/list, pin, spotlight/speaker view and follow-speaker.
* Avatar/“play video” placeholders for tiles outside the budget, with
  promotion/eviction that respects the profile budget and the hard cap:
  click-to-play swaps in the clicked tile (evicting the automatic speaker when
  pinned + speaker already fill the budget), and the pin is never evicted.
* Manual quality selection and adaptive stream/dynacast.
* Rooms up to 200 on SFU with mesh avoided for large calls; direct P2P stays a
  2-seat 1:1 mode (`docs/p2p.md`) and is not a large-room claim.
* Synthetic 25/200-participant UI verification and unit tests for pagination,
  profile selection/override, promotion/eviction, audio-unchanged and server
  capacity.

## 4. What is not supported / not claimed

* **200 HD videos at once, or 50 videos/client on one SFU node.** One client
  never subscribes 200 cameras. Default gallery videos are 270p-class (`auto`:
  480×270; 360p is `medium`, 640×360), HD only for a pinned/spotlight tile;
  total bandwidth is dominated by SFU egress. A 50-video client budget needs
  cascading/more nodes and is **not** a `high` profile claim.
* **A 200-way WebRTC load test in this repo.** The synthetic harness only proves
  DOM pagination and UI behaviour; `sfu-checks.mjs` proves a real two-participant
  media session and the subscription policy, not 200-way capacity. Real
  media/CPU/TURN numbers require a sized LiveKit deployment and a load generator
  (see `sfu-loadtest.md`).
* **Every camera at once.** On the low pilot a 25-person room renders 24 remote
  tiles but only 2 decode video by default; on standard it is 6. The other tiles
  are avatars with “play video” (or a pin). Raising `limits.galleryVideoBudget`
  is possible, but it must be matched by SFU/TURN capacity and measured.
* **200-participant media on the 1 vCPU / 2 GB host.** The `low` profile caps
  the room at 25 participants (server-side, not just a UI hint): the 26th join
  gets `409 room_full` with `reason: "profile"`. A 200-person room needs the
  `high` profile and a dedicated SFU because 200 clients each receive 199 audio
  tracks and the SFU forwards ~39,800 audio subscriptions regardless of the
  video budget.
* **“All 24 videos are free”.** The old 36-subscription default was a hard
  ceiling, not a healthy 1 vCPU configuration. The profile budget is the
  capacity default for rooms above 8 participants.
* **Server-side recording/transcoding of a 200 room.** Egress is a separate,
  resource-heavy feature and is not part of stage 1.
* **Multiple SFU nodes / automatic room placement.** One room must fit one SFU
  node; multi-node routing and cascading are a later stage (`sfu-multinode.md`).
* **Guaranteed audio on very weak devices.** 200 subscribed audio tracks still
  require decoders and jitter buffers; the browser may degrade. The client keeps
  audio subscriptions because muting off-page participants would break the call,
  but low-end devices need a lower room limit.
* **Old browsers / no simulcast.** Without simulcast/adaptive stream the SFU
  cannot reduce a subscribed video’s layer; capacity drops.

---

## 5. Per-node sizing (planning numbers, not a benchmark)

The dominant formulas are:

```text
video_egress ≈ N × profileBudget × gallery_bitrate
audio_egress ≈ N × (N − 1) × opus_bitrate
N = participants, profileBudget = 2/6/12 for low/standard/high
```

A client that pins an HD tile spends one of its budget slots on HD, not an extra
video: substitute the HD bitrate for that slot. SFU forwards packets; there is
no transcode. CPU is mostly packet handling, crypto and per-track bookkeeping;
RAM is mostly buffers/state.

### 5.1 `low`: 25 participants on 1–2 vCPU / 2 GB (current pilot)

Assumptions:

* 25 publishers, camera with simulcast; the SFU forwards the gallery layer
  (270p-class, ~0.2–0.35 Mbps) to subscribers.
* Each client subscribes **2** remote videos: pinned + active speaker (at most
  one of them HD, ~0.8–1.2 Mbps, only if the user pins/spotlights).
* Each client receives 24 audio tracks at 32–40 kbps Opus.

| Metric | Per 25-person room, budget 2 (rough) |
|---|---|
| Publisher ingress | 25 × 0.5–1.0 Mbps ≈ **12–25 Mbps** |
| Video egress (both slots gallery) | 25 × 2 × 0.2–0.35 Mbps ≈ **10–18 Mbps** |
| Video egress (every client pins HD) | 25 × (0.8–1.2 + 0.2–0.35) Mbps ≈ **25–39 Mbps** |
| Audio egress | 25 × 24 × 40 kbps ≈ **24 Mbps** |
| Total egress | **≈ 34–42 Mbps** gallery-only; **≈ 49–63 Mbps** if every client pins HD |
| Forwarded streams | **50 video + 600 audio** (vs 150 + 600 at a 6-video budget; not 600 video) |
| SFU CPU | **1 vCPU** is the target for one 25-person room with this budget; no recording/transcode and ≤70 % sustained utilisation. Re-run acceptance after deploy |
| SFU RAM | **1–2 GB** (2 GB is the practical floor with headroom) |
| NIC | 1 GbE is enough for one room; 2.5 GbE gives headroom |

Guidance for the low pilot node:

* **One 25-person SFU room** is the design target with the 2-video budget. Do
  not raise `limits.galleryVideoBudget` above 2 without a load test and a
  dedicated node; keep `AGIL_SFU_PROFILE=low` set explicitly.
* Keep `video.maxResolution` at 360p/540p, `maxBitrateKbps` ≤ 600, simulcast,
  adaptive stream and dynacast on. Disable server recording/egress.
* Audio is not budgeted (correctness), so 25 × 24 audio subscriptions are
  already ~24 Mbps egress and the largest per-track count. Watch audio decoder
  queues on weak clients and the node's CPU. With 600 audio subscriptions the
  node can still be CPU-bound even at 50 forwarded videos; the post-deploy
  acceptance run must confirm 25 clients, not just the synthetic harness.
* For 2+ simultaneous 25-person rooms, plan 2 vCPU / 4 GB+ and measure; 1 vCPU
  is a single-room node.
* A 50-person room uses the same low-profile 2-video budget: video egress grows
  ~2× and audio ~4× versus 25, so it needs a larger node than the reference.

### 5.2 `standard`: 50 participants on 8–16 vCPU / 16 GB (new default)

Assumptions: 50 publishers at 360p/540p simulcast; 6 remote videos per client;
each client receives 49 audio tracks. Gallery layer ~0.25–0.5 Mbps.

| Metric | Per 50-person room, budget 6 (rough) |
|---|---|
| Publisher ingress | 50 × 0.5–1.0 Mbps ≈ **25–50 Mbps** |
| Video egress (gallery) | 50 × 6 × 0.25–0.5 Mbps ≈ **75–150 Mbps** |
| Video egress (one HD slot each) | add ≈ 50 × 0.6–1.0 Mbps ≈ **+30–50 Mbps** |
| Audio egress | 50 × 49 × 40 kbps ≈ **98 Mbps** |
| Total egress | **≈ 0.17–0.25 Gbps** |
| Forwarded streams | **300 video + 2 450 audio** |
| SFU CPU | **8–16 vCPU** for one 50-person room; measure before multi-room |
| SFU RAM | **16 GB** with headroom |
| NIC | 1 Gbps, ≤60–70 % utilisation |

`standard` is the default because it is the smallest profile that supports a
normal 50-person meeting on a real SFU node without the 2-video workaround. It is
**not** validated on the 1 vCPU pilot: set `AGIL_SFU_PROFILE=low` there.

### 5.3 `high` and 200 participants

Assumptions: 100–200 publishers 720p/30 simulcast; 12 remote videos per client;
one HD pin at most; up to 199 audio tracks per client. Numbers below use the
200-participant worst case.

| Metric | Per 200-person room, budget 12 (rough) |
|---|---|
| Publisher ingress | 200 × 1.5–2.5 Mbps ≈ **0.3–0.5 Gbps** |
| Video egress | 200 × 12 × 0.25–0.5 Mbps ≈ **0.6–1.2 Gbps**; fewer with HD/gallery mix |
| Audio egress | 200 × 199 × 40 kbps ≈ **1.6 Gbps** |
| Total egress | **≈ 2.2–2.8 Gbps** (audio dominates) |
| SFU CPU | **16–32 vCPU** (39,800 audio subscriptions are not free) |
| SFU RAM | **32 GB** |
| NIC | **10 GbE minimum**, 25 GbE recommended |

The `high` profile raises video slots to 12, but a 200-person room remains
audio-bound. Raising the profile is not a substitute for node sizing, and 50
videos/client is outside a single node: it requires cascading/several SFUs.

Practical node sizing:

| Node | Profile | Room capacity (planning) | Notes |
|---|---|---|---|
| 1–2 vCPU / 2 GB / 1 GbE | `low` | **1 room of 25** (budget 2) | Current pilot; re-run acceptance after deploy. |
| 2 vCPU / 4 GB / 1 GbE | `low` | 1 room of 25, or 1 small 50-person room (budget 2) | Headroom for a second small room; measure. |
| 8–16 vCPU / 16 GB / 1 GbE | `standard` | **1 room of 50** (budget 6) | Default profile; video ~0.1–0.2 Gbps, audio ~0.1 Gbps. |
| 16–32 vCPU / 32 GB / 10 GbE | `high` | **1 room of 100–200** (budget 12) | Audio-bound; no headroom for egress/recording. |
| 32+ vCPU / 64 GB / 2×25 GbE | `high` + cascade | 2–3 rooms of 200 | Requires real load test and multi-node media. |

Do **not** size from participant count alone: video egress is `subscribers ×
subscribed videos × bitrate`, while audio egress is `N × (N−1) × 40 kbps`. The
profile is the video lever; audio correctness is why a 200-person room still
needs a substantial node even at 2 videos per client. A dedicated SFU is
required for more videos per client, higher gallery resolution, or multiple
simultaneous large rooms.

---

## 6. Operating notes and failure modes

* The page always renders all 25/36 tiles, but only the profile budget gets
  video above 8 participants: **2** on `low`, **6** on `standard`, **12** on
  `high` (pinned + active speaker first). The rest show avatars with a “play
  video” button; this is intentional and visible (no black tiles).
* The lower subscription limit is a hard ceiling. When it is below the
  profile budget, fewer tiles get video. Pinned/speaker/promoted are chosen
  first, so the hard cap cannot silently drop them unless the cap is 1.
* The budget override is optional: `limits.galleryVideoBudget` (wins) or
  `scale.maxVisibleVideos`. Both are validated and can only lower the effective
  set below the subscription ceiling. Raising the budget above the profile
  without a sized SFU is not supported.
* Profile precedence: `AGIL_SFU_PROFILE` → `scale.sfu.capacityProfile` →
  `standard`. The env represents the physical deployment; a tenant cannot
  advertise a bigger budget than the SFU can carry.
* Profiles are hard capacity, not just a video hint: the effective room cap is
  `min(room.maxParticipants, scale.maxParticipants, profile participants,
  scale.sfu.maxParticipants)`. On the `low` pilot room creation clamps to 25
  and REST join/lobby admit/WS handshake return `409 room_full` (reason
  `profile`) for the 26th seat. `/v1/admin/scale` reports
  `sfuCapacity.participants`, `effectiveMaxParticipants` and the `capacity`
  breakdown; room detail returns the same effective limit.
* If the SFU is disabled while `mediaMode='sfu'`, the server omits `media` and
  the widget falls back to mesh only for small calls; >8 participants get the
  explicit “media server unavailable” banner instead of a silent downgrade.
* Mobile Safari/Document PiP and backgrounding: `disconnectOnPageLeave: false`
  keeps the call alive; autoplay may require the first user gesture.
* Monitor per-room: SFU egress bitrate, packet loss, client CPU, audio decoder
  queue. A room can be “joined by 200” and still be unusable if the node NIC is
  saturated.
* TURN is still required for restrictive networks; LiveKit’s embedded TURN can
  cover SFU, coturn remains for mesh.

---

## 7. Verification

```bash
# widget: unit tests (pagination, profile selection, budget, promotion, quality)
npm run typecheck -w @agil/calls-widget
npm test -w @agil/calls-widget
npm run build -w @agil/calls-widget

# protocol capacities/profiles + server profile selection/status
npm test -w @agil/protocol
npm run typecheck -w @agil/calls-server
cd agil/core/apps/server && npx tsx --test test/capacity-profile.test.ts test/sfu-profile.test.ts test/sfu.test.ts test/scale.test.ts test/ws.test.ts

# synthetic adaptive-budget harness, pinned to the low pilot profile (no media)
node agil/core/qa/widget/gallery-budget-checks.mjs

# synthetic 200-participant UI harness (no media; needs Chrome/Edge)
node agil/core/qa/widget/large-room-checks.mjs

# load-report wording/units (no browser, no network)
node --test agil/core/qa/load/test/browser-media-load.test.mjs
```

Latest local evidence (capacity-profile limits):

* Protocol: **90/90** tests — capacity profile enum/table (participants
  25/50/200 and video budgets 2/6/12), default `standard`, unknown-value
  fallback, patch schema, non-secret env reservation.
* Widget: **114/114** tests — profile budgets 2/6/12, default standard, config
  overrides (`limits.galleryVideoBudget` wins, hard cap wins over both),
  promotion/eviction under low and standard budgets, pinned protection,
  audio-unchanged (plan + fake SFU room), pagination. Typecheck clean; Vite build
  clean (780.90 kB JS / 104.13 kB CSS + 902.86 kB lazy LiveKit chunk).
* Server: full suite **366/366** (up from 361), including the new
  `test/capacity-profile.test.ts` (low 25 rejects 26th REST + WS; standard 50
  rejects 51st; high 200 rejects 201st; room/scale lower limits win; lobby
  admit returns `room_full` with `reason=profile`), plus the existing profile
  precedence/status tests. Typecheck/build clean.
* Dashboard: **20/20** tests, typecheck and Vite build clean; scaling card shows
  `sfuCapacity.participants`/`effectiveMaxParticipants` and warns when
  `scale.maxParticipants` exceeds the profile; the create-room dialog warns
  before submit that the room will be clamped.
* Editor: **6/6** tests, typecheck and Vite build clean; the SFU profile field
  has a Russian label/hint and the summary warns when `scale.maxParticipants`
  (or `sfu.maxParticipants`) exceeds the profile.
* Budget harness: assertions unchanged and the mount is pinned to
  `capacityProfile: 'low'`; it was not re-run in this no-browser pass. On the low
  profile a 25-person room still shows budget 2, 22 avatars and a clickable play
  button.
* No 200-media run is claimed. The 200-participant result remains
  signaling/UI-level (`load-200-media.md`).

### 7.1 Post-deploy acceptance rerun (required)

No deploy is part of this change. On the current 1 vCPU / 2 GB pilot, set
`AGIL_SFU_PROFILE=low` explicitly (or `scale.sfu.capacityProfile: "low"`), then
rerun the real 25-participant acceptance. With `low` the server now clamps every
room to **25** participants and rejects the 26th (`409 room_full`), so a room
created with `maxParticipants: 200` cannot be overfilled:

```bash
node agil/core/qa/load/browser-media-load.mjs --users=25 --browsers=5 --duration=20
```

That harness creates the room through the admin API and needs `AGIL_ADMIN_KEY`.
Success criteria: 25/25 joined, 25 tiles on every page, at least one playing
remote video per page, `data-video-budget` = 2, 0 console/page errors, room
deleted. The previous 25×6 run on this host failed media (see
`pilot/acceptance-25-evidence.md`); the
low-profile rerun is the acceptance gate for the current node.

For a new deployment on an 8–16 vCPU / 16 GB SFU, leave the profile unset
(`standard`, 6 videos) and run the 50-participant media profile first. For
`high`, plan for 16–32 vCPU / 32 GB / 10 GbE and validate 100+ participants with
the 200-media procedure in `load-200-media.md`. A 50-video/client budget is not
covered by any profile and requires cascading/more nodes.

Reports/screenshots: `agil/core/qa/widget/gallery-budget-qa.json`,
`gallery-budget-25-1440.png`, `gallery-budget-25-390.png`,
`large-room-qa.json`, `large-room-1440-page1.png`, `large-room-speaker.png`,
`large-room-participants.png`, `large-room-390.png`,
`large-room-minimal-1440.png`, `large-room-minimal-390.png`.
