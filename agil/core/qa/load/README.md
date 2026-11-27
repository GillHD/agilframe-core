# Browser media load harness

`browser-media-load.mjs` launches real Chrome pages with fake camera/mic, joins
them to one `/embed.html` room, and records tiles/video/playing/errors per page.
It is the reusable version of the 50-browser smoke run.

```bash
# plan only (no key/browser/network)
node agil/core/qa/load/browser-media-load.mjs --dry-run --users=200 --browsers=4

# 50 browser pages against a pilot host
BASE_URL=https://pilot.example AGIL_ADMIN_KEY=... \
  node agil/core/qa/load/browser-media-load.mjs --users=50 --duration=60s

# 200 synthetic WS + 50 browser pages in one run
BASE_URL=https://pilot.example AGIL_ADMIN_KEY=... \
  node agil/core/qa/load/browser-media-load.mjs --users=50 --duration=60s --synthetic-ws=200
```

Reports are written to `reports/` (gitignored):

- `browser-media-<N>u-<timestamp>.json`
- `browser-media-<N>u-<timestamp>.md`
- `synthetic-ws-<N>-<timestamp>.json` (combined run)

Read [load-200-media.md](../../docs/load-200-media.md) before running anything
beyond the 50-browser pilot profile: it covers the dedicated 8–16 vCPU / 16 GB /
1 Gbps SFU prerequisite, TURN, rate limits, expected metrics, safety and the
"2 playing videos per page is by design" interpretation.

Tests: `node --test agil/core/qa/load/test/browser-media-load.test.mjs`
(or `npm run test:load-media`).
# Local benchmark with pre-encoded publishers

`encoded-media-load.mjs` starts LiveKit and a receiver page on the local computer. Signaling listens on loopback and the SFU advertises an IPv4 address assigned to the same host for WebRTC. FFmpeg creates VP8 clips before measurement. One Go process sends the clips as independent WebRTC camera publications. One Chromium tab subscribes to and displays every publication. Use this benchmark to measure capacity on one computer without requiring a deployed website.

Build the sender with Go 1.26.8 or newer using the module in `encoded-publishers/`. From the repository root on Windows, with LiveKit Server, Chromium and FFmpeg available:

```powershell
Push-Location agil/core/qa/load/encoded-publishers
go build -o ../../../../../.tmp/encoded-publishers.exe .
Pop-Location
node agil/core/qa/load/encoded-media-load.mjs .data/sfu-bin/livekit-server.exe .tmp/encoded-publishers.exe .tmp/encoded-media-report 10:low 25:low 50:low 10:high 25:high
```

Use a fresh output directory for each matrix. Set `CHROME_PATH` or `FFMPEG_PATH` if either executable is installed at a different path. On hosts with multiple network adapters, set `AGIL_QA_MEDIA_IP` to the IPv4 address of the adapter to use. The report compares 320×180 and 1280×720 streams at 15 FPS with an eight-second measurement window. It records the number of publications, streams with newly presented frames at the expected resolution, streams reaching at least 80% of target FPS, RTP decode counters, and total host CPU. Each scenario writes one grid screenshot.

To reuse prepared clips, pass `--clips=DIR`. That directory must contain VP8 IVF files named `low.ivf` for 320×180 and `high.ivf` for 1280×720, according to the selected scenarios. Both use 15 FPS. Use clips of about one minute with regular keyframes so subscriptions that start after scrolling can decode promptly. The harness validates the clip headers, publishes the compressed streams directly and skips FFmpeg for the whole run.

The default receiver subscribes to every stream simultaneously. Use `--widget` to start a disposable AGIL Core, run one real widget, and sample the visibility-based subscription budget during scrolling. The fixture uses a fake local capture to read Chromium's decoder stats and never publishes that capture. Choose more than 36 publishers to exercise the desktop gallery scroll.

```powershell
node --import tsx agil/core/qa/load/encoded-media-load.mjs .data/sfu-bin/livekit-server.exe .tmp/encoded-publishers.exe .tmp/encoded-widget-report 45:low --widget --clips=.tmp/encoded-media-report
```

In widget mode, the report includes a measurement window for the initial gallery and another after scrolling. It records the presented-frame deltas, decode statistics, and subscription counts for both views.

To measure audio, add `--audio=FILE` in widget mode and supply a prepared Opus Ogg clip. The sender publishes a microphone track for each participant. The receiving browser measures RTP and decoded audio energy from every microphone before, during, and after switching visible video rows. Playback is muted at the browser output during the test. Use a clip long enough for setup, scrolling, and both measurement windows. The following command prepares a 75-second test tone before the benchmark.

```bash
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 75 -c:a libopus -frame_duration 20 -b:a 32k tone.ogg
```

With `--clips=DIR --audio=FILE`, the sender packetizes the prepared VP8 and Opus files directly from disk.

The endpoint and video traffic stay on the test machine. Results characterize the combined host and browser for these video-only inputs and exclude TURN and real network conditions.
