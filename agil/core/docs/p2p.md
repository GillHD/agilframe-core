# P2P direct calls (1:1)

Status: **implemented and tested** at the HTTP contract, room/join limit and
widget level. P2P is an explicit transport for **direct** rooms only. It is not a
large-room mode: a P2P room has **exactly two seats** and no server media plane.

```
A ◄──────────── WebRTC media (SRTP/DTLS), direct ────────────► B
│                                                                 │
└──────── SDP/ICE relay over the AGIL signaling server ──────────┘
```

The signaling server still carries SDP/ICE and the control plane (chat, presence,
whiteboard, etc.). Audio/video never reaches the server in P2P mode. TURN relays
are still part of the ICE plan when a direct candidate pair cannot be established
(see «IP exposure and TURN» below).

## 1. API

`POST /v1/rooms` (public, when anonymous creation is allowed) and
`POST /v1/admin/rooms` accept:

| Field | Type | Meaning |
|---|---|---|
| `mode` | `'direct' \| 'group'` | Required to use `transport`; P2P is valid only with `direct`. |
| `transport` | `'p2p' \| 'sfu'` (optional) | `p2p` → room `mediaMode:'mesh'`, `maxParticipants:2`; `sfu` or omitted → the current effective media plane (`scale.mediaMode`). |

```bash
# Public API: a 1:1 P2P room
curl -sS -X POST http://localhost:8787/v1/rooms \
  -H 'content-type: application/json' \
  -d '{
    "tenantId": "demo",
    "name": "Звонок с Анной",
    "mode": "direct",
    "transport": "p2p",
    "context": { "messenger": "corp-messenger", "directPeerId": "user-7" }
  }'
```

```bash
# Admin API: the same room, authenticated by a tenant key
curl -sS -X POST http://localhost:8787/v1/admin/rooms \
  -H 'x-api-key: …' -H 'content-type: application/json' \
  -d '{"name":"Звонок с Анной","mode":"direct","transport":"p2p"}'
```

Response `room` contains the effective values:

```json
{
  "room": {
    "id": "…",
    "mode": "direct",
    "mediaMode": "mesh",
    "maxParticipants": 2
  }
}
```

`transport:'sfu'` is deliberately **current behaviour**, not a forced migration:
a direct room uses SFU when the tenant is configured for it (`scale.mediaMode:'sfu'`),
and stays mesh when the tenant is mesh-only. Omit `transport` for exactly the same
result. The join/welcome response has **no `media` block** for a P2P room; the
widget therefore never opens an SFU session and connects to the peer directly.

## 2. Validation

| Request | Result |
|---|---|
| `transport:'p2p'` with `mode:'group'` or no mode | `400 validation_failed` — transport is direct-only |
| `transport:'p2p'` with `maxParticipants` > 2 | `400 validation_failed` — P2P has exactly 2 seats; use `transport:'sfu'` for more |
| `transport:'p2p'` with any transport other than `p2p`/`sfu` | `400 validation_failed` (schema) |
| `transport:'p2p'` while server egress recording is enabled (`mediaProcessing.egress`) | `409 p2p_unsupported` (`details.feature:'egress'`) |
| `transport:'p2p'` while RTMP/HLS streaming is enabled (`scale.streaming.enabled`) | `409 p2p_unsupported` (`details.feature:'streaming'`) |
| `transport:'p2p'` while webinar/broadcast mode is enabled (`scale.webinar.enabled`) | `409 p2p_unsupported` (`details.feature:'webinar'`) |
| `transport:'p2p'` with client-side recording (`features.recording`) | allowed — local recording is a browser capability, not an egress job |

The 409 is checked against the **effective** room config, including
`configOverrides`, before the room is created. The error message names the
blocking feature and suggests `transport:'sfu'`; no room/quota is consumed.
The same rules apply to public and admin creation.

Server egress and P2P are mutually exclusive by design: egress must join the room
as a media participant and needs an SFU. A room that is created on the mesh plane
could never start the egress job — failing early is clearer than a broken
recording button. Local recording (`getDisplayMedia`/`MediaRecorder` in the
browser) does not need server media and keeps working.

## 3. Room full (third participant)

A P2P room is capped at two **seated** participants (a REST `/join` only issues a
token; the seat is taken when the WebSocket joins). The third join gets:

```http
HTTP/1.1 409 Conflict
{"error":{"code":"room_full","message":"Room is full: room maxParticipants is 2","details":{…}}}
```

embedded call personal rooms use this contract: every visitor gets a `mode:'direct',
transport:'p2p'` room, the invite link admits one other person, and a third
visitor sees an explicit “room is full: this is a 1:1 P2P call” message rather
than “room not found”.

## 4. Widget badge

The call header shows **P2P** for a direct 1:1 room on the mesh plane — never the
technical word “mesh”. Tests keep the technical mode in `data-mode`:

```html
<span class="agil-pill agil-media-mode" data-mode="mesh" data-transport="p2p"
      title="Режим связи: напрямую между участниками (P2P); медиа не проходит через сервер…">P2P</span>
```

* `data-mode` — effective media mode (`mesh`/`sfu`/`broadcast`), unchanged.
* `data-transport` — user-facing transport (`p2p`/`sfu`/`broadcast`/`mesh`).
* A grouped mesh room does **not** claim P2P: its technical badge is hidden
  instead of showing “mesh” (QA P3-13).
* SFU group calls still show **SFU**; broadcast shows **Broadcast**.
* The title explains that media goes directly between participants and does not
  pass through the server (including the IP/TURN caveat).

The badge is a single pill — no extra “transport” row is added to the 1:1 UI.

## 5. IP exposure and TURN trade-off

P2P has a real privacy/network cost that SFU rooms do not:

* **IP addresses are visible to the peer.** ICE candidates contain host and
  server-reflexive addresses; the other participant can learn them. For SFU
  rooms participants see the SFU/TURN addresses, not each other’s.
* **TURN relays media when a direct path fails.** Symmetric NAT, CGNAT,
  restrictive corporate firewalls or UDP blocking often require a TURN relay.
  In that case media is no longer strictly browser-to-browser: it is encrypted
  (DTLS-SRTP) but forwarded by the TURN server. TURN consumes relay bandwidth
  on the operator’s infrastructure.
* **No server-side processing.** Egress recording, RTMP/HLS streaming,
  server-side transcription/mixing and webinar controls require SFU. Local
  recording and the control-plane features (chat, files, whiteboard, captions
  produced on-device) remain available.
* **Do not use P2P as a capacity mode.** Each participant encodes/uploads one
  stream to each peer; it does not scale. P2P is for 1:1 only. Use SFU for 3+
  participants, webinars and any room that must be recorded server-side. The
  large-room story is SFU (see `large-rooms.md` and `scaling.md`); this document
  makes no 200-participant P2P claim.

Operators should configure a TURN pool (`scale.turn`) even for P2P: without it,
corporate networks can make 1:1 calls connect slowly or fail. TURN credentials
are delivered as env-var names and resolved per request; never inline them.

## 6. Dashboard / editor

* Dashboard → «Создать комнату»: the transport selector is enabled only for
  «Один на один»; the P2P option carries a warning about **2 seats**, direct
  media, IP visibility and the SFU-only egress restriction. The links dialog
  labels a direct mesh room as «P2P (напрямую, без серверного медиа)».
* Editor → «Комната» → test-room helper: the direct mode has the same
  `transport` selector and the generated `POST /v1/admin/rooms` JSON includes it
  only for `direct`.
* Dashboard docs list this file (`p2p.md`).

## 7. Verification

```bash
npm run build:protocol
npm run typecheck -w @agil/calls-server
npx tsx --test agil/core/apps/server/test/p2p-direct.test.ts
npm run test -w @agil/calls-widget     # media-badge.test.ts
npm run test -w @agil/demo             # embedded call-room.test.ts
```

Covered by tests: p2p direct → mesh/2, p2p wins over an SFU tenant default,
no `media` block, `transport:'sfu'`/omitted direct keeps SFU, group+p2p 400,
`maxParticipants:3`+p2p 400, egress/configOverrides egress 409, local recording
allowed, third seated participant gets `409 room_full`, badge text/P2P vs
SFU/transport attribute, and the embedded call request shape.
