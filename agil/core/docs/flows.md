# Generic media flow routing: sources → processors → sinks

Status: **implemented in Core** (API + evaluator + JSON store + live triggers +
tests). Media adapters that this build cannot execute are **modelled and marked
`pending`** — they are validated and stored, never faked. No Edge firmware,
mixer or transcode adapter ships here, and no deploy/release is part of this
change.

Related: [`docs/routing.md`](routing.md) (legacy single-source surface),
[`docs/egress-production.md`](egress-production.md),
[`docs/media-encoding.md`](media-encoding.md),
protocol source `agil/core/packages/protocol/src/flows.ts`,
server source `agil/core/apps/server/src/flows.ts`.

## 1. What it does

A **flow** is a tenant-scoped media graph:

```
sources[]                      processors[]                    sinks[]
─────────                      ────────────                    ───────
room, edge, participant ──┐    layout grid|speaker      ┌────► room (publish target)
rtmp_ingest, srt_ingest   ├──► audio_mix (native)    ────┼────► room (another room → forward)
hls_ingest, file, sip     ┘    transcode (optional)      ├────► rtmp (grouped, one encode)
                                                         ├────► hls
                                                         ├────► srt
                                                         ├────► recording (MP4)
                                                         ├────► cdn
                                                         └────► webhook (signed JSON)
```

One flow covers the three shapes that used to need separate features:

- **branching** — one source feeds a call (`room`), an RTMP stream, HLS, a
  recording and a webhook from **one** composite egress encode;
- **fan-in / mix** — several sources (room + edge + participant) are mixed by
  the layout/audio processor into one program feed, then fanned out;
- **bridging** — a second `room` sink is modelled as "another room" (adapter
  pending; see §3).

Execution maps onto the existing LiveKit egress client:

| Configured | Executed as |
| --- | --- |
| `room` sink (first) | the room the sources publish into; no egress needed |
| `rtmp` sinks | one `StartRoomCompositeEgress` per layout, several `stream_outputs` URLs |
| `hls` sink | one segmented-file egress job per layout |
| `recording` sink | one file egress job per (layout, audioOnly); MP4 |
| `webhook` sink | signed JSON POST from the Core (not media egress) |
| `layout` processor | composite layout for every sink without an explicit `layout` |
| `audio_mix` processor | native room-composite audio mixing (all sources in the room) |

## 2. Data model

```ts
interface Flow {
  id: string;                       // fl_…, URL-safe
  tenantId: string;                 // always the API-key tenant
  name?: string;
  description?: string;
  enabled: boolean;                 // default true
  priority: number;                 // 0..1000, lower wins (default 100)
  sources: FlowSource[];            // 1..8
  processors: FlowProcessor[];      // 0..4
  sinks: FlowSink[];                // 1..12
  triggers: FlowTrigger[];          // 1..4, default [{kind:'manual'}]
  fallbackFlowId?: string;          // same tenant; chain depth ≤ 3
  createdAt: number;
  updatedAt: number;
  lastFiredAt?: number;             // schedule bookkeeping
  lastRun?: FlowRunRecord;          // sanitized diagnostics from the last run
}
```

### Sources

```ts
type FlowSource = {
  kind: 'room' | 'edge' | 'participant' | 'rtmp_ingest' | 'srt_ingest' | 'hls_ingest' | 'file' | 'sip';
  mode?: 'push' | 'pull'; // managed RTMP push or managed SRT/HLS pull
  sourceId?: string;      // operator-registered pull source in the flow's organization
  roomId?: string;        // room: required; participant/sip: room binding
  edgeId?: string;        // edge: optional selector (wildcard when absent)
  tag?: string;           // edge/participant selector
  participantId?: string; // participant selector
  url?: string;           // *_ingest/file: pull endpoint (credential-bearing)
  secretRef?: string;     // *_ingest: AGIL_ROUTE_SECRET_* holding the URL
  assetId?: string;       // file: uploaded file/recording id
  label?: string;
};
```

### Sinks

```ts
type FlowSink = {
  kind: 'room' | 'rtmp' | 'hls' | 'srt' | 'recording' | 'cdn' | 'webhook';
  label?: string;
  // room (publish target or "another room")
  roomId?: string; template?: string; role?: 'host'|'moderator'|'guest';
  publish?: Array<'audio'|'video'|'screen'>;
  // rtmp / srt / webhook signing
  url?: string; secretRef?: string;
  // composite outputs
  layout?: 'grid'|'speaker'; latency?: 'standard'|'low';
  // recording
  audioOnly?: boolean; format?: 'mp4'|'webm';
  // cdn (pending)
  provider?: 's3'|'gcs'|'azure'; bucket?: string; pathPrefix?: string;
  // webhook
  events?: Array<'started'|'failed'>;
};
```

Rules enforced by the schema:

- a flow needs a **room target** when it has a media sink: a room sink, a
  room-bound source, or an edge source (implicit `edge-<edgeId>` room);
- a room sink is `roomId` XOR `template`; the **first** room sink is the publish
  target, later room sinks are "another room" forwards (pending);
- `rtmp`/`srt` take `url` XOR `secretRef`; `secretRef` must be a server-owned
  `AGIL_ROUTE_SECRET_*` variable;
- `hls`/`recording`/`cdn` carry no URL; `webhook.url` is required (http/https,
  no userinfo) with an optional signing `secretRef`;
- processor kinds are unique per flow (`layout`, `audio_mix`; ≤ 2 transcode
  profiles); trigger kinds are unique;
- trigger/source consistency: `room_start` needs a room/participant source,
  `edge_online` an edge source, `schedule` a room-bound source.
- `fallbackFlowId` must reference another flow of the tenant, must not create a
  cycle and must not exceed depth 3.

### Processors

```ts
type FlowProcessor =
  | { kind: 'layout'; layout: 'grid'|'speaker' }
  | { kind: 'audio_mix'; mode?: 'mix'; audioOnly?: boolean }
  | { kind: 'transcode'; profile: 'h264_720p30'|'h264_1080p30'|'hevc_1080p30'|'aac_128k' };
```

`layout` and `audio_mix` execute on the composite egress. `transcode` is a
**pending adapter**: the egress client does not expose per-flow encoder profiles,
so a flow that requests a profile reports `pending` and starts nothing rather
than implying the profile was applied.

### Triggers

```ts
type FlowTrigger =
  | { kind: 'manual' }                       // POST /v1/admin/flows/:id/test
  | { kind: 'room_start' }                   // first participant in a source room
  | { kind: 'edge_online' }                  // Edge joined (flow join or routed room)
  | { kind: 'schedule'; everySec?: number; at?: number }; // one of everySec/at
```

`everySec` is 30 s … 24 h. `at` is an absolute epoch-ms instant (one-off).

## 3. Adapter capability matrix (the honest part)

Every source/sink/processor kind advertises `supported` or `pending`. The API
returns the matrix inside `flow.plan` and `GET /v1/admin/flows/:id/status`; a
pending step is reported with a stable reason and is **never started**.

| Kind | State | Executes as / why pending |
| --- | --- | --- |
| source `room` | supported | composite egress reads that LiveKit room |
| source `edge` | supported | the Edge is a participant of the publish room |
| source `participant` | pending | participant tags are not emitted by this build |
| source `rtmp_ingest` with `mode: "push"` | managed RTMP API | publishes into one SFU room via LiveKit Ingress |
| source `rtmp_ingest` with an external URL or secret | pending | legacy receiver configuration |
| source `srt_ingest` with `mode: "pull"` | managed SRT API | LiveKit pulls from the organization's registered listener into one SFU room |
| source `srt_ingest` with an external URL or secret | pending | legacy receiver configuration |
| source `hls_ingest` with `mode: "pull"` | managed HLS API | LiveKit pulls MPEG-TS HLS from the organization's gateway source into one SFU room |
| source `hls_ingest` with an external URL or secret | pending | legacy receiver configuration |
| source `file` | pending | needs a playback adapter into a room |
| source `sip` | pending | SIP legs are bridged by the external LiveKit SIP service; not a first-class flow source yet |
| sink `room` (first) | supported | publish/mix target room |
| sink `room` (2nd+) | pending | room → another room needs a room-output/forwarding adapter |
| sink `rtmp` | supported | composite `stream_outputs` (grouped per layout) |
| sink `hls` | supported | segmented-file egress |
| sink `recording` (MP4) | supported | file egress (`MP4`) |
| sink `recording` (WEBM) | pending | worker writes MP4; WEBM needs a transcode worker |
| sink `srt` | pending | egress client exposes RTMP/HLS outputs only |
| sink `cdn` | pending | per-flow object-storage output needs a worker storage mapping |
| sink `webhook` | supported | signed JSON POST by the Core |
| processor `layout` | supported | composite layout |
| processor `audio_mix` | supported | native composite audio mix |
| processor `transcode` | pending | per-flow encoder profile is not exposed |
| trigger `manual`/`room_start`/`edge_online`/`schedule` | supported | see §6 |

A pending **source** or **processor** makes the whole flow non-executable
(`plan.executable:false`): starting the supported branch would misrepresent the
configured media path. A pending **sink** only affects its branch; the other
branches still run and the run is reported as `partial`/`pending`.

Across rooms: one room-composite egress mixes exactly **one** LiveKit room.
Several sources are therefore only mixable when they resolve to the same room.
A flow with sources in two rooms reports `pending` (`FLOW_CROSS_ROOM_MIX_REASON`)
and starts nothing; a real multi-room mixer is a deferred adapter.

The internal RTMP Ingress driver uses the operator's HTTP(S) LiveKit control URL
(`AGIL_SFU_CONTROL_URL`) and creates a push receiver. A successful creation
returns connection details and a stream key. Only LiveKit's
`ENDPOINT_PUBLISHING` state confirms that the worker is publishing media.
The driver returns a credential-free status and checks the stored room and
participant identity before revocation. [LiveKit Ingress API](https://docs.livekit.io/reference/other/ingress/api/).

Core can now reserve one receiver per organization and flow in shared Redis.
The record binds an existing organization-owned room to a generated participant
identity. The active Core compares its Redis lease and the expected record in
one command for each change. Configure Redis persistence if records must
survive a Redis restart. RTMP stream keys stay out of the record. Managed
receivers require tenant and room IDs without an embedded `__`, the
separator used in LiveKit room names.

After an interrupted create, the internal lifecycle searches LiveKit using
the stored room and participant identity. An empty result leaves the
reservation pending. A new Core can bind the same receiver when it appears.
On revocation, Core keeps the reservation until LiveKit confirms the receiver
is absent. Repeating the revocation after a lost response clears the same
reservation without affecting a newer receiver.

### Managed RTMP push

Set `AGIL_FLOW_STORE=redis` and configure the LiveKit Ingress worker. On
each Core, set `AGIL_SFU_URL`, `AGIL_SFU_CONTROL_URL`,
`AGIL_SFU_API_KEY` and `AGIL_SFU_API_SECRET` for the same LiveKit cluster.
Use an RTMPS publishing endpoint for external encoders.

1. Create an SFU room under the organization that will own the flow.
2. Create a flow through `POST /v1/admin/flows`. Put the existing SFU room
   ID in both the source and sink.

   ```json
   {
     "id": "studio-input",
     "sources": [{ "kind": "rtmp_ingest", "mode": "push", "roomId": "studio" }],
     "sinks": [{ "kind": "room", "roomId": "studio" }]
   }
   ```

3. On the leader, call `POST /v1/admin/flows/studio-input/rtmp-ingress`
   with the organization's admin credential. Copy the returned `url`
   and `streamKey` into the encoder. The credential response uses
   `Cache-Control: no-store`. The flow definition and status calls do
   not expose the key.
4. Start the encoder and check
   `GET /v1/admin/flows/studio-input/rtmp-ingress`. `waiting` and
   `buffering` indicate that media is not yet publishing.
   `publishing` confirms delivery to LiveKit.
5. To rotate or stop the stream, use
   `DELETE /v1/admin/flows/studio-input/rtmp-ingress`. A later POST issues a
   new key. Disabling the flow, moving it to another room, replacing its
   managed source or deleting the flow waits for confirmed revocation.
   Revoke the associated receiver before deleting its room separately.

If the provider cannot confirm revocation, retain the flow and retry the
same operation on the active Core. A create that was interrupted before
returning credentials can appear as `provisioning`. Core looks for the
original receiver before proceeding. Once recovered, revoke it and request a
fresh key. This mode handles one room per flow and publishes the tracks from
the encoder. Use a separate flow for recording, export, composition, or
cross-room routing.

### Managed SRT pull

Use the same Redis and LiveKit configuration as [managed RTMP push](#managed-rtmp-push).
Run the sender in SRT listener mode. LiveKit connects as the caller using
`URL_INPUT`. Assign the listener to its organization in the Core startup
setting `AGIL_SRT_INGRESS_SOURCES`. Use the same settings on each Core.
Stop a receiver before changing its registered address.

```json
[
  {"tenantId":"demo","sourceId":"stage-camera","host":"10.20.0.15","port":5000}
]
```

The registry accepts private numeric IPv4 addresses and UDP ports. The source
address stays outside tenant responses. The Ingress worker needs a route to
the registered UDP port. [LiveKit Ingress workflow](https://docs.livekit.io/transport/media/ingress-egress/ingress/).

1. Create an SFU room and a flow with one SRT source and one sink for that room.

   ```json
   {
     "id": "stage-input",
     "sources": [{"kind":"srt_ingest","mode":"pull","roomId":"stage","sourceId":"stage-camera"}],
     "sinks": [{"kind":"room","roomId":"stage"}]
   }
   ```

2. Call `POST /v1/admin/flows/stage-input/srt-ingress` on the active Core.
   The operation starts pulling immediately. Use GET on the same route to
   check for `publishing`.
3. Use DELETE on the receiver route to stop the session. A room or source
   replacement, disabling the flow, or deleting the flow waits for confirmed
   revocation. Revoke the receiver before deleting its room separately.

### Managed HLS pull

Use Redis flow storage and the [LiveKit Ingress control endpoint](#managed-rtmp-push).
Run the [HLS gateway](../deploy/hls-ingress/gateway.py) on Linux within the
worker network. The gateway serves local files under `<root>/<tenantId>/<sourceId>/`.
It accepts one `index.m3u8` media playlist per source with relative `.ts` segment
names and serves unencrypted MPEG-TS HLS. Publish each completed segment before
updating the playlist. Write updates to temporary files and rename them in place.

```sh
python3 gateway.py --root /srv/agil-hls --bind 10.20.0.12 --port 8090 \
  --worker-network 10.20.0.11/32
```

Restrict TCP 8090 to the Ingress workers at the firewall. Give the gateway a
read-only mount. Keep each encoder's write access within its assigned source
directory. Each worker on that network can read the gateway's media. Keep the
gateway within the operator network and leave its port off public routers.
The gateway reads files from disk and rejects remote segment URLs, nested
playlists, key and initialization-map URIs, and symbolic links. Master
playlists, adaptive variants, encrypted HLS and fMP4 require a separate
conversion to this HLS profile before the gateway can serve them.

Set `AGIL_HLS_INGRESS_SOURCES` to the following JSON array on each Core. Use the
same entries on all Core replicas. `host` is the private IPv4 address of the
gateway and `port` is its TCP listener port. Stop a receiver before changing
its gateway binding.

```json
[{"tenantId":"demo","sourceId":"stage-hls","host":"10.20.0.12","port":8090}]
```

1. Create an SFU room. Put the playlist and segments in
   `/srv/agil-hls/demo/stage-hls/` for this example.
2. Create a flow with one managed HLS source and one sink for the same room.

   ```json
   {
     "id": "stage-video",
     "sources": [{"kind":"hls_ingest","mode":"pull","roomId":"stage","sourceId":"stage-hls"}],
     "sinks": [{"kind":"room","roomId":"stage"}]
   }
   ```

3. Call `POST /v1/admin/flows/stage-video/hls-ingress` on the active Core.
   Read the status from GET on the same route and check for `publishing`.
   The response contains the room ID, source ID and status.
4. Call DELETE on the same route to stop Ingress and retain its flow. Source or
   room changes, disabling a flow and deleting a flow wait for confirmed
   revocation. Revoke the receiver before deleting its room separately.

Flow creation, edits and deletion run in order for each organization on the
active Core. On leadership changes each Core drops its cached flow definitions
and rejects results from flow runs started by the previous leader. The API
returns an error if the configuration file could not be saved.

### Shared flow configuration

`AGIL_FLOW_STORE=file` is the default. It keeps definitions in
`<AGIL_DATA_DIR>/flows`. For Core replicas with separate disks, set
`AGIL_FLOW_STORE=redis` and give them the same `AGIL_REDIS_URL`,
`AGIL_CLUSTER_ID` and `AGIL_REDIS_KEY_PREFIX`. Each Core has its own
`AGIL_CLUSTER_NODE_ID`. Use Redis persistence and backups for recovery from
loss of the Redis host.

1. Preserve a backup of the existing flows directory. Start with the Core
   that has the authoritative files, and give it the leader lease for the
   migration. Switch other Cores to the same storage mode before they
   participate in the election.
2. Request `GET /v1/admin/flows` on that leader. The first flow request
   imports the legacy snapshots into Redis and records migration completion.
   Compare the returned definitions with the expected list for each tenant.
3. Bring the other Cores online. Verify that the active and standby endpoints
   return the same definitions. Writes go through the active Core. Test
   takeover on a non-production cluster before removing the file backups.

Redis assigns a monotonically increasing revision to each tenant snapshot.
Each update checks the previous snapshot and the current leadership lease in
one Redis operation. Deleting the last flow stores an empty revisioned
snapshot. Old files stay on disk and are used only for the initial import.
If migration is interrupted, Core resumes from its stored file checksums. A
new leader that lacks a required snapshot rejects flow requests until it has
the matching original file. A Redis outage blocks access to Redis-managed
definitions until Redis is available.

This storage mode covers flow definitions across Core replicas. Tenant
credentials and other local configuration still follow the cluster's own
configuration procedure.

## 4. API

All admin endpoints require a tenant credential (`x-api-key` or an SSO admin
session), are tenant-scoped and are leader-only mutations in HA mode. Unknown or
foreign ids answer `404`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/admin/flows` | list flows (`{flows: FlowView[]}`) |
| `POST` | `/v1/admin/flows` | create (`{flow}`) |
| `GET` | `/v1/admin/flows/:id` | read one (`{flow}`) |
| `PATCH` | `/v1/admin/flows/:id` | deep-partial update (`{flow}`) |
| `DELETE` | `/v1/admin/flows/:id` | delete (`{deleted:true,id}`) |
| `POST` | `/v1/admin/flows/:id/test` | evaluate; `apply:false` = dry run |
| `GET` | `/v1/admin/flows/:id/status` | plan, trigger readiness, next schedule, last run |
| `POST` | `/v1/admin/flows/:id/rtmp-ingress` | create an RTMP push receiver and return the publisher credential once |
| `GET` | `/v1/admin/flows/:id/rtmp-ingress` | read receiver status on the leader |
| `DELETE` | `/v1/admin/flows/:id/rtmp-ingress` | revoke the receiver while retaining the flow |
| `POST` | `/v1/admin/flows/:id/srt-ingress` | start a managed SRT pull |
| `GET` | `/v1/admin/flows/:id/srt-ingress` | read its status on the leader |
| `DELETE` | `/v1/admin/flows/:id/srt-ingress` | stop the pull while retaining the flow |
| `POST` | `/v1/admin/flows/tick` | run this tenant's due schedule triggers now |
| `GET/POST` | `/v1/admin/flows/edge-tokens` | Edge enrollment tokens (alias) |
| `DELETE` | `/v1/admin/flows/edge-tokens/:tokenId` | revoke an enrollment token (alias) |
| `POST` | `/v1/edge/join` | machine surface; may resolve a flow when no route matches |

`/v1/admin/routes` remains the **legacy alias surface** for the baseline
single-source rules (`docs/routing.md`). It is not removed; both surfaces are
evaluated: routes first for an Edge join, then flows. A legacy rule is
expressible as a flow (see §10).

### Views are secret-free

A flow view renders endpoints as `urlHost` + `hasSecret`; the raw URL/stream key
never leaves the server. `secretRef` is the env var **name**, not a secret.

```json
{ "kind": "rtmp", "layout": "grid", "latency": "standard",
  "urlHost": "rtmp://live.example/…", "hasSecret": true }
```

### PATCH semantics

Scalars merge; `sources`, `processors`, `sinks` and `triggers` **replace the
whole list** (send complete entries); `fallbackFlowId: null` removes the
fallback. Unlike the legacy route patch, lists are not merged by array position:
reordering a sink list cannot silently turn an RTMP sink into an HLS sink.

## 5. Examples

### Branching: hall call + YouTube + HLS + recording + webhook

```bash
curl -sS -X POST "$CORE/v1/admin/flows" \
  -H "x-api-key: $TENANT_KEY" -H 'content-type: application/json' \
  -d '{
    "name": "Hall program feed",
    "priority": 10,
    "sources": [
      { "kind": "room", "roomId": "hall" },
      { "kind": "edge", "edgeId": "cam-hall" }
    ],
    "processors": [{ "kind": "layout", "layout": "speaker" }, { "kind": "audio_mix" }],
    "sinks": [
      { "kind": "room", "roomId": "hall", "role": "host" },
      { "kind": "rtmp", "secretRef": "AGIL_ROUTE_SECRET_HALL_MAIN", "layout": "grid" },
      { "kind": "rtmp", "secretRef": "AGIL_ROUTE_SECRET_HALL_BACKUP", "layout": "grid" },
      { "kind": "hls", "layout": "speaker" },
      { "kind": "recording", "layout": "grid", "audioOnly": false },
      { "kind": "webhook", "url": "https://hooks.example/agil", "events": ["started", "failed"] }
    ],
    "triggers": [{ "kind": "room_start" }, { "kind": "edge_online" }, { "kind": "manual" }]
  }'
```

The two RTMP sinks share one layout → **one** encode with two `stream_outputs`
URLs. HLS and recording are separate jobs. The webhook receives one POST per
evaluation with the run status.

### Fan-in (mix) of room + Edge in the same room

```json
{
  "sources": [
    { "kind": "room", "roomId": "studio" },
    { "kind": "edge", "edgeId": "cam-studio" }
  ],
  "processors": [{ "kind": "layout", "layout": "grid" }, { "kind": "audio_mix" }],
  "sinks": [{ "kind": "hls" }],
  "triggers": [{ "kind": "room_start" }, { "kind": "edge_online" }, { "kind": "manual" }]
}
```

Both sources resolve to `studio`, so the mix is executable. Setting a second
`{ "kind": "room", "roomId": "overflow" }` sink models "another room"; it is
reported `pending` (forward adapter), while the HLS branch still runs.

### Edge-only flow (no legacy route)

```json
{
  "sources": [{ "kind": "edge", "edgeId": "cam-1" }],
  "sinks": [{ "kind": "room", "roomId": "edge-cam-1", "role": "host" }, { "kind": "hls" }],
  "triggers": [{ "kind": "edge_online" }]
}
```

Issue a token at `/v1/admin/flows/edge-tokens`, redeem it at `/v1/edge/join`.
The response carries `flowId` (and `routeId` = flow id), the room + join token,
the effective destinations and the egress summary. If the flow cannot execute
(pending source/processor), the join answers `409 flow_pending` with the reason
and does not consume the token.

### Scheduled flow

```json
{
  "sources": [{ "kind": "room", "roomId": "studio" }],
  "sinks": [{ "kind": "hls" }],
  "triggers": [{ "kind": "schedule", "everySec": 300 }]
}
```

The Core ticks every 30 s (`setInterval`, unref'd) and the same evaluation can be
driven explicitly with `POST /v1/admin/flows/tick` (ops/tests). A scheduled flow
only runs when its target room exists in this Core **and has participants**;
otherwise the occurrence is recorded as `skipped` with a reason and marked fired
so it cannot retry-storm.

### Test / dry run

```bash
# Resolve everything, start/notify nothing.
curl -sS -X POST "$CORE/v1/admin/flows/fl_ab12/test" \
  -H "x-api-key: $TENANT_KEY" -H 'content-type: application/json' \
  -d '{ "apply": false, "roomId": "hall" }'

# Simulate the room_start trigger (must be declared by the flow).
curl -sS -X POST "$CORE/v1/admin/flows/fl_ab12/test" \
  -H "x-api-key: $TENANT_KEY" -H 'content-type: application/json' \
  -d '{ "trigger": "room_start", "roomId": "hall" }'
```

The response reports `matched`, `disabled`, `shadowedBy`, `applied`, `roomId`,
`mixer {status,layout,audioMix,transcodeProfiles,sourceCount,roomIds}`,
per-sink statuses (with `pendingReason` for adapters and `delivery` for
webhooks), `summary {status,code,jobs,sinks,errors,pending}`, the fallback that
actually ran (`fallbackOf`) and sanitized `errors`. It never contains a stream
URL/key.

### Status

`GET /v1/admin/flows/:id/status` returns the adapter plan, per-trigger
readiness, the next schedule occurrence (`nextRunAt`), the fallback chain and
`lastRun`. This is the endpoint a dashboard uses to show "pending adapter"
badges without evaluating anything.

## 6. Triggers and selection

- **manual** — an admin diagnostic; always available regardless of declared
  triggers. Shadowing is not applied to `manual` (it evaluates the named flow),
  but a `room_start`/`edge_online` simulation reports `shadowedBy`.
- **room_start** — when the first participant joins a room
  (`participantCount === 1`, breakout rooms skipped), the highest-priority
  enabled flow with a `room_start` trigger whose room/participant source matches
  is evaluated. A failure never breaks the call.
- **edge_online** — two paths:
  1. a flow-only tenant joins via `/v1/edge/join` (flow join, §5);
  2. an Edge joins through a legacy route — the routing baseline then notifies
     the flow evaluator for the same room (fire-and-forget).
- **schedule** — see §5; per-flow, not per-room.

**Priority** — enabled flows that match the trigger/identity are sorted by
`priority` ascending, then `createdAt`, then `id`. The first one is evaluated; a
disabled flow is skipped. If none matches, an Edge join keeps `404 no_route`.

**Fallback** — when the selected flow's run ends `failed` or `unavailable`
(not for a pending adapter or a dry run), the flow named by `fallbackFlowId` is
evaluated with the same identity/room; the chain is depth-limited and
cycle-checked at write time. The response carries `fallbackOf`; each evaluated
flow stores its own `lastRun`.

## 7. Execution details

### Idempotency

Core tracks Egress jobs by
`tenantId + roomId + kind + layout + audioOnly + hash(sorted URLs)`.
Before reusing a job, Core checks its status in LiveKit. Another evaluation
can start a new job after the previous one finishes. While it is active,
starting or ending, evaluations reuse it. A cached pending job is reported
as started once LiveKit confirms it is active. If the status check fails, Core
reports the error and keeps tracking the previous job. Failed starts have a
15-second cooldown, and concurrent evaluations in the same Core process
share one start. After a Core process restart, check for jobs still running
before reapplying the flow. Stop them with
`POST /v1/rooms/:roomId/egress/:id/stop` or the admin cleanup route.

### Webhook sink

Delivered by the Core after the media outcome is known (so the payload carries
the run status), with the standard headers:

```http
content-type: application/json
x-agil-flow-id: fl_…
x-agil-flow-event: flow.started | flow.failed
x-agil-signature: sha256=<HMAC-SHA256(body, AGIL_ROUTE_SECRET_*)>   # when secretRef is set
x-agil-timestamp: <epoch ms>
```

Payload: `{id,type,ts,tenantId,flowId,trigger,roomId,status,sinks,jobs,errors,edgeId?}`.
A webhook failure is reported per sink and degrades a healthy media run to
`partial` with `code: "webhook_failed"`. Delivery is awaited (5 s timeout) so a
test/status response is truthful; it never throws.

### Degraded runs

- egress disabled/unconfigured → sink status `unavailable`,
  `summary.code: "egress_unavailable"`; a room/publish target still works;
- worker rejection → `failed` / `egress_failed`;
- one branch fails while another runs → `partial` / `partial_failure`;
- a pending branch alongside a running branch → `partial` / `adapter_pending`;
- adapter pending with nothing else running → `pending` with `pendingReason` per
  sink; if no branch can run the run is `pending`
  (`adapter_pending`/`source_pending`).

Upstream error text is sanitized (`sanitizeEgressErrorText`): URLs are reduced to
the host and tokens removed before the text reaches a response, `lastRun` or the
audit trail.

## 8. Security policy

- **Tenant isolation** — flows live in `<AGIL_DATA_DIR>/flows/<tenantId>.json`;
  every read/write is keyed by the API-key tenant, foreign ids answer `404`.
- **No secrets in responses/audit** — raw `url` is never returned; views expose
  `urlHost`/`hasSecret`. Audit entries carry source/sink kinds and hosts only.
- **secretRef** — `AGIL_ROUTE_SECRET_*` (server-owned, resolved from the startup
  env snapshot, re-checked at use). Any other namespace is `400`.
- **SSRF** — inline `rtmp`/`srt`/`webhook`/ingest URLs go through the shared
  network-endpoint policy: no userinfo, no private/link-local/metadata hosts,
  allowed schemes only; secure mode requires TLS for supported endpoints. The
  check runs on write and again at start/delivery. Pending adapters are stored
  only after the same host policy passes (TLS is not required for a config that
  cannot execute yet). DNS rebinding is not covered — run behind an allowlisting
  egress proxy when it matters.
- **Rate limits / HA** — admin endpoints honour
  `AGIL_ADMIN_ALLOW_IPS`/`AGIL_ADMIN_RATE_LIMIT_PER_MIN`; mutations are
  leader-only. The flow file is per-Core, like the legacy route file.

## 9. Limitations / deferred work

- **Adapters** — legacy URL-based RTMP/SRT/HLS ingest in the flow evaluator, file playback, SIP media source, SRT sink,
  CDN/object-storage sink, room→another-room forwarding, per-flow transcode and
  WEBM recording are **modelled and pending** (see §3). Implementing one means
  adding an adapter and flipping its capability entry; the evaluator then starts
  it like any other supported branch.
- **Cross-room mixer** — a real multi-room mixer (LiveKit Ingress/compositor or
  an external mixer) is required to mix sources from different rooms.
- **Participant sources** need participant tags, which this build does not emit.
- **Schedules** are interval/one-off (`everySec`/`at`), not cron expressions;
  the ticker is in-process (a standby keeps its own per-Core file).
- **Process-local idempotency** — no distributed egress registry.
- **No automatic egress stop** when a flow is deleted or its room closes.
- **No dashboard UI** in this change: the API and `@agil/protocol` DTOs are the
  contract a screen can use.
- **SFU media mode is required for egress** (`scale.mediaMode: "sfu"` or
  broadcast); a `mesh` tenant has no room to composite.

## 10. Migration from `/v1/admin/routes`

| Legacy route | Equivalent flow |
| --- | --- |
| `source: {type:'edge', edgeId}` | `sources: [{kind:'edge', edgeId}]` + `triggers:[{kind:'edge_online'}]` |
| `source: {type:'room', roomId}` | `sources: [{kind:'room', roomId}]` + `triggers:[{kind:'room_start'}]` |
| `destinations: [{type:'room',…}]` | `sinks: [{kind:'room',…}]` |
| `destinations: [{type:'stream', provider:'rtmp'}]` | `sinks: [{kind:'rtmp',…}]` |
| `destinations: [{type:'stream', provider:'hls'}]` | `sinks: [{kind:'hls',…}]` |
| `recording: {enabled:true}` | `sinks: [{kind:'recording',…}]` |
| `recording.layout` / room destination role | `layout` processor / sink `layout`, room sink `role` |

Both surfaces remain live; a routed Edge additionally notifies matching
`edge_online` flows, so a tenant can migrate incrementally. The legacy
`/v1/admin/routes` endpoints and `POST /v1/edge/join` behaviour are unchanged
(an Edge join only consults flows when no route matches).

## 11. Tests

```bash
# protocol contract (schemas, adapter plan, selection/fallback, patch, schedule, redaction)
npm run test -w @agil/protocol

# server flow integration (mock egress Twirp + local webhook receiver)
npx tsx --test agil/core/apps/server/test/flows.test.ts

# routing baseline regression (routes + Edge join + hook)
npx tsx --test agil/core/apps/server/test/routing.test.ts

# typecheck
npm run typecheck -w @agil/calls-server
```

Covered by the integration suite:

- CRUD + plan + tenant isolation + secret-free views/audit + PATCH replacement;
- branching room → room + grouped RTMP + HLS + recording + webhook, idempotent
  re-evaluation, dry run starting/notifying nothing;
- fan-in of same-room sources (one job) and cross-room fan-in reported pending
  with zero egress;
- pending adapters (participant/transcode/srt/cdn) reported, never started;
- priority/shadowing, disabled flows, fallback when the primary secret is
  missing (primary `unavailable`, fallback runs, both `lastRun` stored);
- room_start on the first participant (and no duplicate job later);
- flow-only Edge enrollment/join, the routed-Edge edge_online hook and
  `409 flow_pending` for a non-executable flow;
- schedule tick with an inactive room (skipped, marked fired) and with an active
  room (evaluated once);
- webhook failure reported per sink and run degraded to `partial`;
- SSRF/secret-policy rejections for private hosts, plaintext RTMP, metadata
  webhooks, URL credentials and foreign secret namespaces.
