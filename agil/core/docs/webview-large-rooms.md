# WebView SDK large rooms (Stage 3b)

The mobile SDKs (`@agil/calls-react-native`, Capacitor, the iOS Swift package, the
Android library) and the web embed component (`@agil/calls-embed`) are **WebView
shells** around the hosted `/embed.html` widget. They do not render the video
grid or the participant panel themselves: the widget does. Stage 3b makes those
shells survive a 200-participant room without re-sending the full participant
list on every widget tick, and keeps presentation, reconnect state and the
security envelope (origin, token, nonce) correct on phones.

Stage 3a/1 (widget rendering, pagination and video subscriptions for 200
participants) is owned by `agent-101`; this document and the SDK code never
change widget UI or the `agil/websdk/widget` sources.

## Profile: 200 participants

The large-room profile is one room with up to **200** participants, matching
`LARGE_ROOM_MAX_PARTICIPANTS` in `agil/websdk/widget/src/call/large-room.ts`.
The server's effective limit follows the deployed SFU capacity profile
(low 25 / standard 50 / high 200), so the SDK default is an upper bound only.

| Layer | Setting | Default | Notes |
| --- | --- | --- | --- |
| Server/protocol | `scale.sfu.capacityProfile` | `standard` | Room capacity is `min(room.maxParticipants, scale.maxParticipants, profile participants, sfu.maxParticipants)`; low 25 / standard 50 / high 200 |
| React Native | `<AgilCall limits={{ maxParticipants: 200 }} />` | 200 | Clamped to 2..200; controls the participant digest |
| Embed | `<agil-call max-participants="200">` | 200 | Clamped to 2..200 |
| iOS | `AgilCallConfiguration(maxParticipants: 200)` | 200 | Throws `AgilConfigurationError` outside 2..200 |
| Android | `AgilCallConfig(maxParticipants = 200)` | 200 | Throws `AgilCallConfigException` outside 2..200 |
| Capacitor | `openCall({ limits: { maxParticipants: 200 } })` | 200 | Clamped to 2..200 |

The limit is an **SDK-side buffer/digest cap**, not a second server-side quota.
The server still enforces the room capacity; the SDK cap only bounds how many
participant ids it keeps and how large a snapshot it emits.

## Bridge events: snapshot + delta, never 200 ids per tick

The widget's `agil:state` includes `participantIds` (in `agil/websdk/demo/src/embed.ts`
it is `[self.id, ...participants.map(p => p.id)]`). Forwarding that array on
every state change costs ~2 KB per tick across the native bridge and forces
hosts to diff 200-row lists on the JS thread.

The SDKs now keep the canonical participant set in a per-load digest and expose:

| Event | Payload | When |
| --- | --- | --- |
| React Native | `{ type: 'participants', participants: ParticipantUpdate }` | first state + changes |
| Embed | `agil-participants` → `{ participants: ParticipantUpdate }` | first state + changes |
| Capacitor | `{ type: 'participants', participants: ParticipantUpdate }` | first state + changes |
| iOS | `AgilCallEvent.participants(AgilParticipantUpdate)` | first state + changes |
| Android | `AgilCallEvent.Participants(update)` | first state + changes |

`ParticipantUpdate`:

```ts
interface ParticipantUpdate {
  kind: 'snapshot' | 'delta' | 'summary';
  count: number;           // authoritative count, including self
  revision: number;        // monotonic, starts at 1
  added: string[];         // delta: ids that joined (snapshot: full bounded set)
  removed: string[];       // delta: ids that left
  ids?: string[];          // snapshot only, bounded to maxParticipants
  truncated?: boolean;     // widget sent more ids than the cap
}
```

Rules shared by all five SDKs:

1. The first `agil:state` with ids emits one `snapshot` (≤ 200 ids) and sets
   `revision = 1`.
2. Later states emit a `delta` with only the added/removed ids; unchanged ticks
   emit nothing.
3. Churn of **≥ 32 ids and ≥ 50 %** of the room re-emits a `snapshot` so a host
   that missed deltas can resynchronise without replaying history.
4. A state without `participantIds` emits a `summary` only when the count
   changes. A present-but-empty `participantIds` array is a valid empty-room
   snapshot, not a summary.
5. All ids are trimmed, control-character rejected, deduplicated and capped;
   `truncated: true` marks a widget that sent more than the cap.

`agil-state` / `AgilCallState` is compacted: `participantIds` is removed and
replaced with `participantCount` and `participantRevision`. This is a documented
breaking change for hosts that read `state.participantIds`; they must move to
the `participants` event. The TypeScript state types declare
`participantIds?: never`, so a host that still reads or assigns it fails
typecheck rather than silently getting `undefined` at runtime. The iOS and
Android compact snapshots follow the same rule (always empty `participantIds`)
and add `participantCount`/`participantRevision`. The `Participants` update kind
distinguishes a count-only `summary` from an empty-room `snapshot`; the parsed
(pre-compaction) native snapshot keeps a `hasParticipantIds` flag for the digest.
The widget itself never runs on the host thread, so this is an SDK boundary
change only.

## Reconnect state

The widget already emits `connection-state` (`agil:event`) with
`{ connection, overall, mediaMode }` and periodically reports
`connectionState` in `agil:state`. The SDKs deduplicate transitions into:

| SDK | Event |
| --- | --- |
| React Native | `{ type: 'connection', connection: ConnectionUpdate }` |
| Embed | `agil-connection` → `{ connection }` |
| Capacitor | `{ type: 'connection', connection }` |
| iOS | `AgilCallEvent.connection(AgilConnectionUpdate)` |
| Android | `AgilCallEvent.Connection(update)` |

```ts
interface ConnectionUpdate {
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting'
       | 'disconnected' | 'offline' | 'closed' | 'failed' | 'unknown';
  previous?: ConnectionUpdate['state'];
  reconnecting: boolean;
  attempt?: number;   // when the widget reports it
  delayMs?: number;   // backoff
}
```

On the **connection transition**, the compact `state` emitted with it carries
`state.reconnect: { attempt?, delayMs? }` when the widget reports those numbers,
so a banner can render without a second lookup. This is transition-only: later
`reconnecting` state ticks are deduplicated, do not emit another `connection`
event and do **not** re-attach `state.reconnect`. Hosts that need a live banner
should keep the last `connection` event or read `state.connectionState`.
`reload()`/`reconnect()`/`load()` start a new document: the participant digest
restarts with one snapshot and the bridge nonce rotates. The Capacitor facade
has no public `reconnect()`: a host that needs a fresh document calls
`openCall()` again (the URL/token comes from the supplied options) or reloads
its own WebView.

## Viewport, safe area, fullscreen, scroll

The widget page already declares
`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
and pads its controls with `env(safe-area-inset-*)`. The shells must not fight
that layout:

### iOS (`AgilCallView`)

- `WKWebView.scrollView.contentInsetAdjustmentBehavior = .never` — the widget
  (not the WebView) owns safe-area padding; `respectsSafeArea` optionally pins
  the whole WebView to `safeAreaLayoutGuide`.
- `bounces = false`, `alwaysBounceVertical/Horizontal = false`,
  `isDirectionalLockEnabled = true` — no rubber-banding around the
  participant list.
- `minimumZoomScale = maximumZoomScale = 1`, `allowsLinkPreview = false` — no
  accidental viewport zoom on the video grid.
- `preferredContentMode = .mobile` — `width=device-width` is honoured on iPad.
- `preferences.isElementFullscreenEnabled = true` (iOS 15.4+) and
  `allowsPictureInPictureMediaPlayback = true` — gallery/tile fullscreen and
  PiP work from a 200-tile room.
- `allowsInlineMediaPlayback = true`, autoplay without a gesture.

### Android (`AgilCallView`)

- `useWideViewPort = true`, `loadWithOverviewMode = false`, `setSupportZoom(false)`
  — the widget's meta viewport wins; no double-tap zoom.
- `isNestedScrollingEnabled = true`, `overScrollMode = OVER_SCROLL_NEVER`,
  scrollbars off — the inner participant list scrolls without overscroll glow.
- `onApplyWindowInsets` pads for system bars **and** `displayCutout` when
  `safeArea = true` (API 30 insets; legacy inset fields + cutout below API 30).
- `WebChromeClient.onShowCustomView`/`onHideCustomView` host HTML5 video
  fullscreen above the WebView; `onHideCustomView` restores the widget.
- `mediaPlaybackRequiresUserGesture = !autoplay`, `mixedContentMode =
  MIXED_CONTENT_NEVER_ALLOW`.

### React Native / Capacitor

- React Native applies `safeAreaInsets` as container padding because Android
  WebView does not implement CSS `env(safe-area-inset-*)`;
  `allowsFullscreenVideo`, `allowsInlineMediaPlayback` and
  `mediaPlaybackRequiresUserAction: false` are set on the WebView.
- Capacitor ships its own native shells (`AgilCallViewController` /
  `AgilCallActivity`) rather than embedding the SDK view, but applies the same
  presentation rules. iOS: `contentInsetAdjustmentBehavior = .never`,
  bounces/always-bounce off, directional lock, zoom clamped to 1,
  `allowsLinkPreview = false`, `preferredContentMode = .mobile`, element
  fullscreen (iOS 15.4+), PiP, inline autoplay without a gesture, and the
  WebView pinned to `safeAreaLayoutGuide`. Android: `useWideViewPort = true`,
  `loadWithOverviewMode = false`, zoom off, `isNestedScrollingEnabled = true`,
  `OVER_SCROLL_NEVER`, scrollbars off, padding for system bars and
  `displayCutout`, and `WebChromeClient.onShowCustomView`/`onHideCustomView`
  for HTML5 fullscreen.

### Embed

- `iframe` has `allow="… fullscreen …"`, `allowfullscreen`, and the element
  keeps `height="auto"` bounded to 320..2400 px; no CSS viewport hacks.

## Security invariants (unchanged)

1. **Origin**: the bridge accepts messages only from the widget's exact origin
   (`https://host[:port]`); extra `allowedOrigins` expand navigation only, never
   the bridge trust boundary. The embed bridge additionally checks
   `event.source === iframe.contentWindow`.
2. **Token**: the join token and `identity_token` live only in the WebView URL
   query and are never logged, echoed in errors, or placed in `postMessage`
   payloads. Reconnect/reload rebuilds the URL from the same immutable
   configuration, so the token is preserved. Redaction is tested.
3. **Nonce**: the React Native bridge, the iOS and Android SDKs and the
   Capacitor **Android** shell inject a per-document random nonce; the shim wraps
   every forwarded message as `{__agilBridgeNonce, message}` and native rejects a
   message without the current value. Native also rejects a direct `postMessage`
   from a subframe or an allowlisted SSO page. The embed iframe and the
   Capacitor **iOS** shell have no nonce by design: the embed checks
   `event.source === iframe.contentWindow` and the iOS shell checks the message
   handler's main frame plus the exact widget origin. SDK-initiated reload
   rotates the nonce (a previous page cannot post into the new session).
4. The large-room digest only *consumes* already-authenticated bridge messages;
   it does not widen what the page can send.

## Minimal examples

React Native:

```tsx
<AgilCall
  serverUrl="https://calls.example.com"
  roomId="large-room-1"
  joinToken={token}
  limits={{ maxParticipants: 200 }}
  onEvent={(event) => {
    if (event.type === 'participants') {
      // event.participants.kind === 'snapshot' | 'delta' | 'summary'
    } else if (event.type === 'connection') {
      // event.connection.state / attempt / delayMs
    }
  }}
/>
```

See `agil/mobile/react-native/example/large-room.tsx`.

Embed:

```html
<agil-call
  server-url="https://calls.example.com"
  room="large-room-1"
  token="<short-lived>"
  max-participants="200"
></agil-call>
<script type="module">
  const call = document.querySelector('agil-call');
  call.addEventListener('agil-participants', (e) => applyDelta(e.detail.participants));
  call.addEventListener('agil-connection', (e) => showBanner(e.detail.connection));
</script>
```

See `agil/websdk/embed/example/large-room.html`.

iOS:

```swift
let config = try AgilCallConfiguration(
    serverURL: "https://calls.example.com",
    roomId: "large-room-1",
    joinToken: token,
    maxParticipants: 200
)
view.onEvent = { event in
    if case .participants(let update) = event { apply(update) }
    if case .connection(let update) = event { banner(update) }
}
```

Android:

```kotlin
callView.listener = AgilCallEventListener { event ->
    when (event) {
        is AgilCallEvent.Participants -> apply(event.update)
        is AgilCallEvent.Connection -> banner(event.update)
        else -> Unit
    }
}
callView.load(AgilCallConfig(serverUrl = server, room = room, token = token, maxParticipants = 200))
```

Capacitor:

```ts
await AgilCalls.openCall({ serverUrl, roomId, joinToken, limits: { maxParticipants: 200 } });
const handle = await AgilCalls.addListener('callEvent', (event) => {
  if (event.type === 'participants') apply(event.participants);
  if (event.type === 'connection') banner(event.connection);
});
```

## Tests

JS (run from each package; no native toolchain needed):

```bash
npm test -w @agil/calls-react-native
npm test -w @agil/calls-embed
npm test -w @agil/calls-capacitor
npm run typecheck -w @agil/calls-react-native
npm run typecheck -w @agil/calls-embed
npm run typecheck -w @agil/calls-capacitor
```

- `test/large-room.test.ts` in each JS package covers the 200-id snapshot,
  single-join/leave deltas, resync threshold, count-only summaries, connection
  dedupe and compact state. The same file also exercises a >200-id widget state
  through the real parse path and asserts `truncated: true`. Only the RN test
  additionally asserts reconnect token/identity-token preservation; embed and
  Capacitor verify URL building in `test/url.test.ts`.
- `test/bridge.test.ts` / embed `test/bridge.test.ts` cover parsing/compaction,
  and Capacitor `test/native-source.test.ts` statically checks the native shell
  presentation settings.

Native (static on this host, real toolchains in CI):

```bash
node agil/mobile/ios/scripts/webview-large-rooms-check.mjs
node agil/mobile/android/scripts/webview-large-rooms-check.mjs
node agil/mobile/android/scripts/shim-smoke.mjs
# macOS: bash agil/mobile/ios/scripts/ci.sh
# Android: ./gradlew :agil-calls:testDebugUnitTest (with the SDK)
```

`AgilLargeRoomTests.swift` (XCTest) and `AgilLargeRoomTest.kt` (JUnit) cover the
same digest rules on the real toolchains.

## Limitations

- The widget still **sends** `participantIds` in `agil:state`; compaction happens
  in the SDK. Avoiding the wire payload entirely needs a widget-side
  `agil:participants` delta emitter (Stage 3a owner). The SDK tolerates both.
- The digest keeps ids, not names/roles. Participant metadata still arrives via
  the widget's `participant-joined`/`participant-left` generic events; a host
  that only reads `agil-state` will not have names.
- `state.participantIds` is intentionally removed in public state now; the TS
  types declare it `never`, and native compact snapshots expose
  `participantCount` / `participantRevision` with an empty id list (the bounded
  ids arrive once in the `participants` snapshot). This is a breaking change for
  hosts that rendered the list from it.
- Pathological participant ids are normalized differently by the SDKs: JS drops
  ids longer than 200 characters, iOS truncates them to 200, and Android caps
  them at 128 before the digest. Normal room ids (UUIDs, namespaced slugs) are
  identical on every SDK.
- Capacitor fullscreen/safe-area behavior is implemented in the shell sources
  but was **not device-verified** on this host (see the native status above).
- Native SDKs were **not built** on this host (no Xcode/Android toolchain);
  static checks + XCTest/JUnit sources are provided, but device/simulator
  verification remains required.
- Reconnect attempt/backoff numbers are only exposed when the widget reports
  them on a `connection-state` event; a bare `connectionState: reconnecting`
  yields a transition with no `attempt`/`delayMs`, and repeated reconnecting
  ticks do not repeat the transition payload.
- The 200 cap is SDK-side. Raising the server/plan limit above 200 does not make
  the SDK track more than 200 ids; the extra ids are truncated and flagged.
