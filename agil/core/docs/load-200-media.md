# Browser media load: 50 now, 200 later

**Status:** reusable harness, validated at 50 browser pages. The 200 media run is
**not executed by this change** and must not be claimed as passed.

| | |
|---|---|
| Harness | `agil/core/qa/load/browser-media-load.mjs` |
| Signaling companion | `agil/core/qa/backend/load-ws.mjs` (`--synthetic-ws`) |
| Tests | `agil/core/qa/load/test/browser-media-load.test.mjs` |
| Reports | `agil/core/qa/load/reports/` (gitignored) |
| Related | [large-rooms.md](large-rooms.md), sfu-loadtest.md, qa-load-200-ws.md, qa-turn.md |

The harness drives real Chrome pages with fake camera/mic through `/embed.html`.
It creates a room through the admin API, issues one participant token per page,
joins the pages, waits for tiles and video frames, records per-page metrics and
errors, writes a JSON report plus a Markdown summary, and deletes the room.

## What this proves — and what it does not

**Proves (at 50):** 50 real browser clients simultaneously join one room, receive
media tracks, render tiles and keep playing video without page/console errors.

**Does not prove:**

- 200 media clients — the 200-participant result so far is signaling-only
  (qa-load-200-ws.md);
- 200 HD videos or 50 videos per client — one page subscribes only the
  capacity-profile video budget (2 on the low pilot, 6 on standard, 12 on high;
  `maxVideoSubscriptions` is still a hard cap, [large-rooms.md](large-rooms.md));
- TURN capacity, SFU CPU/bandwidth, or 200-way simulcast churn at scale;
- production capacity. A 200 media run requires the dedicated pilot host below.

## Prerequisites

### Dedicated pilot SFU / app host (not production)

The profile must match the host; a 1 vCPU / 2 GB node cannot serve the numbers
below. Set `AGIL_SFU_PROFILE` (or `scale.sfu.capacityProfile`) to the profile you
are validating and record it in the report.

| Run | Profile | vCPU | RAM | NIC |
|---|---|---|---|---|
| 25–50 participants (smoke) | `standard` | **8–16** dedicated to the SFU | **16 GB** | **1 Gbps**, ≤60–70 % |
| 100–200 participants | `high` | **16–32** dedicated to the SFU | **32 GB** | **10 Gbps**, ≤60–70 % |

| Resource | Requirement |
|---|---|
| Media | LiveKit SFU with a separate Redis, RTC UDP range open |
| Egress/recording | **off** during the run |

The existing 1 vCPU / 2 GB pilot runs the `low` profile (2 videos/client) and is
enough for signaling and the 50-browser smoke, not for a 200-media run:
`sfu-loadtest.md` showed 50 publishers at ~40 % CPU / 250 MiB, while 100
publishers on 1 vCPU already saturated the host. Capacity guidance in
`large-rooms.md` lists 16–32 vCPU / 32 GB / 10 GbE for one 200-person room with
`high` (budget 12) and no egress headroom. Plan the first 200 media run on an
isolated high-profile node and measure; the planning table is not a benchmark.

### Load-generator host (separate from the SFU)

| Resource | Requirement |
|---|---|
| vCPU / RAM | 4–8 vCPU / 8–16 GB (Chrome is the limiter) |
| Chrome/Edge | 120+ (Chrome for Testing is fine) |
| Browser contexts | **50 per Chrome process** validated; use `--browsers=4` for 200 pages |
| Node.js | 20+ with `puppeteer-core` installed (`npm install` at the repo root) |
| Disk | a few hundred MB for profiles/reports |

For the multi-browser acceptance test, run Chrome clients on a separate host to
measure SFU capacity without competing browser load.

Use the [single-receiver benchmark](../qa/load/README.md#local-benchmark-with-pre-encoded-publishers)
to measure one machine's combined SFU and decoder capacity. It runs locally with
pre-encoded publishers and one subscribing tab. Record separately how many
publishers joined, how many tracks the browser presented, and how many kept
pace with the target frame rate.

### TURN

- coturn reachable on UDP/TCP 3478 (and 5349 if TLS), relay range open
  (the local lab uses UDP 49200–49250; size it for 200 clients).
- Verify the TURN path with `?relay=1` on one page before a big run:
  `/embed.html?...&relay=1` forces `iceTransportPolicy: 'relay'` in the embed.
- Watch coturn relay allocation counts and UDP bursts; `qa-turn.md` notes that
  the relay port range can be exhausted under load.
- Keep TURN credentials in the server config, never in this harness or reports.

### API and limits

- `AGIL_ADMIN_KEY` for the pilot tenant. The harness never prints it or puts it
  in reports.
- Raise the admin token rate limit for the run:
  - browser-only 200 pages: `AGIL_ADMIN_RATE_LIMIT_PER_MIN>=300`;
  - combined 200 WS + 50 browser pages: `AGIL_ADMIN_RATE_LIMIT_PER_MIN>=600`.
  The default 120/min blocks 200 tokens (see `qa-load-200-ws.md`). This is a
  pilot setting; document it for production.
- Group rooms are capped at **200 seats** (`large-rooms.md`). The harness asks
  for `users + 10`, so `--users=200` requests 210 and the server clamps it to
  200. The report records both numbers.

## Run 50 now (validated profile)

```bash
# from the repo root
BASE_URL=https://pilot.example \
AGIL_ADMIN_KEY=... \
node agil/core/qa/load/browser-media-load.mjs --users=50 --duration=60s
```

Always run the plan first — it needs no key, browser, network or output dir:

```bash
node agil/core/qa/load/browser-media-load.mjs --dry-run --users=50
```

The dry run prints the room request, token count, pages per Chrome process,
Chrome path and every warning as JSON on stdout. Progress and warnings go to
stderr. A real run writes the JSON + Markdown report files, prints their paths
to stderr, and prints the final report JSON on stdout for CI.

### Measured result of the working 50-browser run

Source: the "50 реальных браузеров с fake media" section of
qa-load-200-ws.md, run on the 1 vCPU / 2 GB pilot.

| Metric | Result |
|---|---|
| Pages / tokens | **50 / 50** |
| Pages joined (tile ≥ 2) | **50 / 50** |
| Page/console errors | **0** |
| Tiles per page | **36–37** (desktop pagination cap 36) |
| Videos with real frames per page | **2** (self + active/pinned) |
| Pages with a playing video | **50 / 50** |
| Stabilization | **~35 s** |
| Room cleanup | room created and deleted; `/v1/admin/rooms` empty |

Why 2 playing videos per page when 36–37 tiles exist: that run used the `low`
pilot profile (2 remote videos/client) and the gallery is paginated and
virtualized (`large-rooms.md` §1.1). Only the visible/self/pinned tiles get live
video; the rest are avatar/adaptive placeholders or use a bounded subscription
slice. This is a capacity-profile setting, not a product limit: on `standard`
the same page would subscribe up to 6 remote videos.

## Run 200 later

Do this only after the dedicated high-profile node (16–32 vCPU / 32 GB /
10 Gbps), TURN and the admin rate limit are in place, with
`AGIL_SFU_PROFILE=high` (12 remote videos/client) or an explicitly validated
profile. A `standard` (6-video) node is not sized for 200 participants per the
planning table.

```bash
# dry run first
node agil/core/qa/load/browser-media-load.mjs --dry-run --users=200 --browsers=4

# real 200 media run: 4 Chrome processes x 50 contexts
BASE_URL=https://pilot-sfu.example \
AGIL_ADMIN_KEY=... \
node agil/core/qa/load/browser-media-load.mjs \
  --users=200 --browsers=4 --concurrency=10 --duration=120s --join-timeout=300s
```

`--browsers=4` is deliberate: one Chrome with 200 pages is outside the validated
50-context profile, and the harness warns about it. The report records pages per
browser (50+50+50+50).

### Expected metrics (targets, not measured)

| Metric | 50 measured (low profile) | 200 target (high profile) |
|---|---|---|
| Tokens issued | 50/50 | 200/200 |
| Pages joined | 50/50 | 200/200 |
| Tiles per page | 36–37 | 36–37 (pagination cap) |
| Playing videos per page | 2 | 12 (target; not measured) |
| Pages with a playing video | 50/50 | 200/200 |
| Page/console errors | 0 | 0 (`--max-errors=0`) |
| Stabilization | ~35 s | 60–180 s on the dedicated node |
| Room maxParticipants | 60 | 200 (server clamps 210 → 200) |
| SFU CPU | not measured | <70% sustained |
| SFU NIC | not measured | <60–70% of 10 Gbps |
| TURN relays | direct path | watch allocations and the relay range |
| Room cleanup | deleted | deleted and verified via GET 404 |

If the run passes, record the JSON/Markdown paths, host CPU/RAM/NIC, SFU and
coturn numbers in the QA report. If it fails, do not rerun immediately: collect
the report, the SFU metrics and the TURN allocation count first.

## Combined 200 synthetic WS + 50 browser pages

The `--synthetic-ws` flag starts `agil/core/qa/backend/load-ws.mjs` concurrently
with the browser phase. The WS child holds its 200 sockets until the browser
steady window ends, then is stopped via stdin, writes its own report and exits;
the harness merges its summary into the browser report.

```bash
# 200 WS + 50 browser pages = 250 concurrent sessions (two rooms)
BASE_URL=https://pilot.example \
AGIL_ADMIN_KEY=... \
node agil/core/qa/load/browser-media-load.mjs \
  --users=50 --duration=60s --synthetic-ws=200
```

What the combined run proves:

- 200 WebSocket sessions + 50 browser media sessions overlap on the same host;
- signaling/presence, chat/caption/state fan-out under the combined load;
- browser tiles/video/error metrics remain within the 50-browser profile.

The WS phase still carries **no audio or video**. Do not describe the combined
run as "250 media participants". Both rooms are independent and both are
deleted; the report records the WS report path, welcome count, socket errors and
exit code. `--ws-hold` is only a safety cap (default join timeout + duration +
120 s); normal shutdown is graceful.

## Reports and exit codes

Default output directory: `agil/core/qa/load/reports/` (gitignored).

| File | Content |
|---|---|
| `browser-media-<N>u-<timestamp>.json` | full run: config, room, token latency, health, browser per-page metrics, timeline, steady samples, errors, synthetic WS summary, verdict |
| `browser-media-<N>u-<timestamp>.md` | human summary with the verdict and interpretation |
| `synthetic-ws-<N>-<timestamp>.json` | raw `load-ws.mjs` report from the combined run |

Key JSON fields:

- `browser.pages[]` — per page `index`, `browser`, `joined`, `joinedAtMs`,
  `tiles`, `videos`, `playing`, `remotePlaying`, `paused`, `audio`, decoded `frames`, `errors`;
- `browser.tiles/videos/playing/remotePlaying` — min/max/avg over final per-page snapshots;
- `browser.mediaModes` — number of final snapshots in each widget media mode;
- `browser.timeline[]` — join-phase samples; `browser.steady[]` — steady window;
- `browser.errors[]` — first 100 page/console errors, tokens redacted;
- `tokens.latencyMs`, `health.before/during/after`, `cleanup.roomDeletion`;
- `verdict.ok` / `verdict.reasons` — the pass/fail decision.

Exit codes: `0` pass, `1` verification failed (join, playing, errors, cleanup),
`2` usage error, `3` runtime/setup error (API, Chrome, puppeteer-core, output).

Pass requires all pages launched and joined, at least one playing remote video per page
in multi-user runs, and errors ≤ `--max-errors` (default 0). The WS phase must pass
when requested and the room must be deleted. In a single-user run the local preview
is sufficient. Use the default error limit and cleanup when reporting capacity.

## Safety

- **Pilot host only.** Never point this at production; it creates a 200-seat
  room, burns token quota and drives 50+ Chrome contexts and media streams.
- Announce the window; run `--dry-run` and a `--users=5 --duration=10s` smoke
  first on any new host.
- Watch host CPU/RAM/NIC, SFU metrics and coturn allocations during the run.
- Stop with `Ctrl+C`; the harness closes pages/browsers, stops the WS child and
  deletes the room in a `finally` block. If the process is killed hard, delete
  the room manually through the admin API.
- Harden cleanup separately: verify `GET /v1/admin/rooms/<id>` returns 404 and
  that `/v1/admin/rooms` has no QA room left.
- Do not leave `--keep-room` rooms behind; they are debug-only.
- No deploy is part of this harness. It only calls the admin API and embeds the
  existing widget.

## Interpretation rules

- **The per-page video count is the capacity profile, not a product limit.** The
  `low` pilot forwards 2 remote videos/client (pinned + active speaker);
  `standard` forwards 6 and `high` 12. Other visible tiles are avatar/adaptive
  and the gallery is paginated at 36 desktop / 25 phone tiles. A 50-video budget
  per client is not a profile and requires cascading/more nodes.
- **200 participants ≠ 200 videos per client.** Each browser subscribes the
  profile video budget (all visible videos up to 8 participants, then the
  profile budget; hard cap `maxVideoSubscriptions`) and receives an adaptive
  layer, not 200 HD streams. Egress scales as participants × subscribed streams,
  not as a 200×200 mesh.
- **Synthetic WS is not media.** The 200 WS run proves joins, presence and
  chat/caption/state fan-out; it does not exercise RTP, TURN, decoders or CPU.
- **A 50-browser pass is not a 200-media capacity claim.** Use the 200 target
  table only after a 200 run on the dedicated node; until then, the honest claim
  is "50 real browser clients with media validated; 200 signaling validated".

## Harness options

```text
--users=N             browser pages to launch and join (default 50, max 200)
--duration=D          steady window after join: 60, 90s, 2m (default 60s)
--concurrency=N       pages joining at once (default min(10, users))
--browsers=N          Chrome processes, pages split evenly (default 1)
--synthetic-ws[=N]    also run N (default 200) synthetic WS participants
--ws-script=PATH      WS load script (default agil/core/qa/backend/load-ws.mjs)
--ws-hold=D           WS safety cap (default join-timeout + duration + 120s)
--join-timeout=D      max wait for joins (default 180s)
--poll-ms=N           readiness/steady poll interval (default 2000)
--rtc-stats           sample video RTP and decoded frame counters on each browser page
--camera-file=PATH    replay a local Y4M fixture as the Chrome synthetic camera
--base=URL            target origin (default $BASE_URL or calls.example.com)
--tenant=ID           tenant (default demo)
--theme=light|dark|auto
--chrome=PATH         Chrome/Edge binary (default $CHROME_PATH or OS candidate)
--headed              show windows (debug)
--out=DIR             report directory (default agil/core/qa/load/reports)
--max-errors=N        tolerated page/console errors (default 0)
--keep-room           do not delete the room (debug only)
--dry-run             plan only: no network, token, browser or output dir
--quiet               suppress progress lines
```

Environment: `BASE_URL`, `AGIL_ADMIN_KEY`, `CHROME_PATH`.

For local SFU diagnosis, use `--rtc-stats` with a longer polling interval such
as `--poll-ms=3000`. Each sample reports the number of pages connected to the
SFU, with usable browser statistics, with outbound video packets, with inbound
video packets and with decoded video frames. RTP counters are cumulative for
the current peer connections. Compare consecutive samples to investigate a
stall. Counts come from the browser. For server-side publication or subscription
acceptance, compare them with the LiveKit room and track metrics. Collecting
these statistics adds browser work, so keep the options identical when
comparing capacity runs.

To use a fixed 12 fps source at 320×180, generate `camera-180p.y4m` locally with
FFmpeg and pass `--camera-file=./camera-180p.y4m`.

```bash
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=12 -t 10 -pix_fmt yuv420p camera-180p.y4m
```

Y4M supplies raw frames and the browser still encodes them. For a receiving
and decoding benchmark with compressed inputs, use the single-receiver harness
with `--clips=DIR` and prepared VP8 IVF files. [Single-receiver benchmark](../qa/load/README.md#local-benchmark-with-pre-encoded-publishers)
