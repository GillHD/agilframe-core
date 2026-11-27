# AgilFrame Android SDK (`agil-calls`)

Tier-1 native Android module for the hosted AgilFrame widget. It gives an
Android app a real screen, a typed event/command bridge and a join API while
media, chat, themes and participants keep running in the hosted `/embed.html`
page. **This is a WebView integration, not a native WebRTC client.**

Keep Android System WebView current on test devices. If the system WebView is
too old to start the widget, the hosted page displays an upgrade message.
The example gives the WebView the available screen space during a call and
restores its scrollable connection form after leaving.

Package: [`agil/mobile/android`](../../mobile/android). Optional Compose module:
[`agil-calls-compose`](../../mobile/android/agil-calls-compose). Example:
[`agil/mobile/android/example`](../../mobile/android/example).

```
┌──────────────────────────── Android app ─────────────────────────────┐
│  AgilCallView (FrameLayout)                                          │
│    ├─ WebView ── https://calls.example.com/embed.html?…             │
│    │              hosted widget: join screen, video, chat, themes    │
│    │                                                                 │
│    ├─ injected shim: window "message" events → AgilCallsBridge       │
│    │                 (per-load nonce envelope, top frame only)       │
│    ├─ commands: window.postMessage → widget's own listener           │
│    ├─ navigation guard: server origin + exact allowlist              │
│    ├─ runtime CAMERA / RECORD_AUDIO permission flow                  │
│    └─ safe-area/window-inset padding                                 │
│                                                                      │
│  AgilClient (HttpURLConnection + executor)                           │
│    └─ POST /v1/rooms/{room}/join → token | 202 pending lobby ticket  │
└──────────────────────────────────────────────────────────────────────┘
```

No widget/server changes are required. The SDK uses the existing
`POST /v1/rooms/:roomId/join` endpoint and the hosted `/embed.html` page
(`agil/core/docs/contract.md` §7).

---

## 1. What is included

| Feature | Status |
|---|---|
| `AgilCallView` (Kotlin, `FrameLayout` + hardened `WebView`) | ✅ |
| URL builder/validation (`/embed.html?server&room&token&identity_token&tenant&role&lang&name&theme&relay`) | ✅ |
| Events `ready / joined / left / chat / error / state` (+ generic events) | ✅ |
| Commands mute/camera/chat/screen-share/blur/minimize/restore/pip/fullscreen/new-tab/leave/raise/reaction, theme+config patches, ping | ✅ |
| `AgilClient` join API with typed errors, timeouts, cancellation | ✅ |
| Waiting-room support: HTTP 202 / `pending:true` → `AgilJoinResult.Pending` | ✅ |
| OIDC/SSO `identityToken` in config, URL and join body | ✅ |
| Android runtime camera/microphone permission flow | ✅ |
| Safe-area/window insets, autoplay, media permission grant/deny | ✅ |
| Exact-origin navigation allowlist, HTTPS enforcement, token redaction | ✅ |
| Per-load nonce envelope binding the JS bridge to the widget top frame | ✅ |
| Compose wrapper `AgilCall` (optional module) | ✅ |
| Example Activity, consumer ProGuard rules, publishable AAR | ✅ |
| Pure-JVM JUnit tests for URL/validation/redaction/join client/bridge | ✅ 68 tests |
| Headless JS shim check (`agil/core/scripts/shim-smoke.mjs`, Node `vm`) | ✅ |
| Native WebRTC, CallKit/ConnectionService, push, background audio | ❌ next tier |
| Instrumentation tests executed here | ❌ not run (no emulator/device) |
| Gradle build executed here | ❌ not run (no JDK 17 / Gradle 8 on the host) |

---

## 2. Toolchain

| Component | Version |
|---|---|
| JDK | **17** |
| Gradle | **8.9+** (8.10.2 recommended; no wrapper is committed for this module) |
| Android Gradle Plugin | **8.7.3** |
| Kotlin | **2.1.0** |
| Compose compiler plugin (optional module) | **2.1.0** |
| compileSdk | **35** |
| targetSdk (example) | **35** |
| minSdk | **26** |
| Kotlin/JVM target | **17** |

`AGP 8.7.3` requires Gradle 8.9+ and JDK 17. Point `JAVA_HOME`/`org.gradle.java.home`
at a JDK 17 installation; do not run the build with a JDK 8 default.

The module deliberately has **no third-party runtime dependencies**: it uses
platform `WebView`, `HttpURLConnection`, `org.json` and `java.util.concurrent`.
Only the optional Compose module pulls Compose BOM `2024.12.01` + `ui`/`runtime`.

---

## 3. Build and test commands (no wrapper)

```bash
# once
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk   # or agil/mobile/android/local.properties:
#   sdk.dir=/path/to/android-sdk
cd agil/mobile/android

# Gradle must be installed locally (8.9+); this repo does not commit a wrapper
gradle --version

# unit tests (pure JVM; no device)
gradle :agil-calls:testDebugUnitTest

# library artifacts
gradle :agil-calls:assembleDebug
gradle :agil-calls:assembleRelease
gradle :agil-calls:lintRelease

# optional Compose wrapper
gradle :agil-calls-compose:assembleRelease

# example app
gradle :example:assembleDebug
gradle :example:installDebug        # needs a connected device/emulator

# publish to the local Maven repository only (no remote deployment)
gradle :agil-calls:publishToMavenLocal
gradle :agil-calls-compose:publishToMavenLocal
```

Windows PowerShell equivalents are identical (`gradle.bat`/`gradle` on `PATH`).
Android Studio: open `agil/mobile/android/settings.gradle.kts` as a project and set
**Settings → Build Tools → Gradle → Gradle JDK** to 17.

If `gradle` is not on `PATH`, use the full path to its `bin/gradle` script. The
build requires the base Android SDK platform 35. The current Gradle build
selects Build-Tools 34.0.0. Install both with Android Studio's SDK Manager or
`sdkmanager "platforms;android-35" "build-tools;34.0.0"`.

The debug example APK was built with Gradle 8.11.1 and JDK 17. The example
enables WebView inspection only when the app is debuggable. Use a current
Android System WebView to test the hosted widget. WebView 91 on the Android 12
lab emulator loaded the HTML but failed to initialize the call. The current
widget uses browser APIs such as `structuredClone`, which were absent there.

To retest the installed debug example, use a dedicated device and allow
camera and microphone when Android asks. The runner starts a disposable Core,
opens a second participant in desktop Chromium and uses ADB reverse for the
local page. ADB and Chromium can be overridden with `ADB_PATH` and `CHROME_PATH`.

```powershell
node --import tsx agil/core/qa/android-device-e2e.mjs DEVICE_SERIAL --installed
node --import tsx agil/core/qa/android-device-e2e.mjs DEVICE_SERIAL --installed --deny-media
node --import tsx agil/core/qa/android-device-e2e.mjs DEVICE_SERIAL --installed --network-fallback
node --import tsx agil/core/qa/android-device-e2e.mjs DEVICE_SERIAL --installed --attachment-manual
```

The first run checks toggles, resumption from the background and removal of
the guest after leaving. The second run temporarily revokes the example's
media permissions, declines the Android prompts and checks that the guest can
watch the call. The runner restores the earlier permission choices.
The third run uses a direct call and overrides the RTT reported by WebRTC on
Android. It verifies the camera pause, continued audio and chat, and fresh
decoded camera frames on the desktop after restoring normal statistics.
The attachment run opens and cancels the system picker, then reopens it with
a test document. Tap the document named in the terminal when it appears on the
device. The desktop downloads the attachment and compares its contents with
the test file.

> **Initial SDK verification.** The environment used
> to author this module has JDK 8 only, no Gradle 8 installation and only
> Android platform 31. Gradle/AGP builds and instrumentation tests therefore
> were **not** executed here. The pure-Kotlin/Android sources were compiled
> manually with a cached Kotlin 1.6 compiler against `android-31/android.jar`
> (which contains only APIs the SDK uses), and the 68 JVM unit tests ran green:
>
> ```
> JUnit version 4.13.2
> ...................................................................
>
> OK (68 tests)
> ```
>
> The bridge shim was additionally executed headlessly in Node `vm` with a fake
> window (`node agil/mobile/android/scripts/shim-smoke.mjs`): it installs only in
> the top frame of the exact widget origin, forwards widget messages inside the
> per-load nonce envelope, filters host commands and ignores foreign
> `message` sources. The Compose wrapper was type-checked against minimal
> Compose API stubs, not a real Compose compile; run
> `:agil-calls-compose:assembleRelease` before publishing.
>
> Kotlin 2.1.0/AGP 8.7.3 may surface additional warnings but the sources use
> long-stable platform APIs. Run the Gradle commands above in CI before
> publishing.

---

## 4. Add the SDK to an app

### 4.1 Local project dependency

`settings.gradle.kts` of the app:

```kotlin
include(":agil-calls")
project(":agil-calls").projectDir = file("../video-calls/packages/android/agil-calls")
// optional:
include(":agil-calls-compose")
project(":agil-calls-compose").projectDir =
    file("../video-calls/packages/android/agil-calls-compose")
```

`build.gradle.kts`:

```kotlin
dependencies {
    implementation(project(":agil-calls"))
    // implementation(project(":agil-calls-compose")) // Compose apps
}
```

### 4.2 AAR / Maven

```bash
gradle :agil-calls:assembleRelease
# agil-calls/build/outputs/aar/agil-calls-release.aar
gradle :agil-calls:publishToMavenLocal
# ~/.m2/repository/com/agilcalls/agil-calls/0.1.0/
```

Coordinates: `com.agilcalls:agil-calls:0.1.0` and
`com.agilcalls:agil-calls-compose:0.1.0`. The POM declares a proprietary
license. Publishing to a remote repository is intentionally out of scope here.

### 4.3 Manifest permissions

The library manifest merges:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
<uses-feature android:name="android.hardware.microphone" android:required="false" />
```

Applications that never use camera/microphone can remove the runtime
permissions in their own manifest:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.CAMERA" tools:node="remove" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="remove" />
</manifest>
```

Do **not** enable `android:usesCleartextTraffic="true"` in a release manifest.
The SDK accepts plain HTTP only for loopback/emulator hosts (`localhost`,
numeric IPv4 `127.0.0.0/8`, `::1`, `10.0.2.2`, `10.0.3.2`) unless
`allowInsecure = true` is set for local development — a DNS name such as
`127.evil.com` does not count as loopback. A debug-only manifest
overlay in `example/src/debug/AndroidManifest.xml` demonstrates this.
Android 9+ blocks cleartext at the OS level regardless of the SDK check, so an
HTTP dev server also needs a debug-only cleartext/network-security config; the
example app's debug overlay provides it.

---

## 5. Quick start

```kotlin
class CallActivity : Activity() {
    private lateinit var call: AgilCallView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        call = AgilCallView(this).apply {
            listener = AgilCallEventListener { event ->
                when (event) {
                    is AgilCallEvent.Ready -> showCallUi(event.capabilities)
                    is AgilCallEvent.Joined -> setStatus("joined")
                    is AgilCallEvent.Left -> setStatus("left")
                    is AgilCallEvent.Chat -> showChat(event.message)
                    is AgilCallEvent.State -> showParticipants(event.snapshot)
                    is AgilCallEvent.Error -> showError(event.error)
                    is AgilCallEvent.Generic -> Unit
                }
            }
            externalLinkHandler = { url -> openInBrowser(url) }
            load(
                AgilCallConfig(
                    serverUrl = "https://calls.example.com",
                    room = "team-sync",
                    token = joinToken,          // short-lived; never log it
                    participantName = "Anna",
                    theme = AgilTheme.AUTO,
                ),
            )
        }
        setContentView(call)
    }

    override fun onResume() { super.onResume(); call.onResume() }
    override fun onPause() { call.onPause(); super.onPause() }
    override fun onDestroy() { call.release(); super.onDestroy() }
}
```

Without a token the widget shows its own join screen (name, camera, microphone).
With a token the call starts after the page finishes its own join flow.

### Join token

Create the token on the customer's backend, never with an admin API key inside
the app:

```bash
curl -s -X POST https://calls.example.com/v1/rooms/team-sync/join \
  -H 'content-type: application/json' \
  -d '{"name":"Anna","locale":"ru"}'
# { "token":"eyJ...", "expiresAt":1760014400000, "room":{...},
#   "participant":{...}, "permissions":["chat", ...] }
```

A tenant with `security.waitingRoom` answers **HTTP 202** with
`{pending:true, requestId, roomId, status:'pending', expiresAt, pollAfterMs}`
and **no token**; the guest must be admitted by a host before a token is issued.
`AgilClient` models that as `AgilJoinResult.Pending` (never as a parse error).

Then use `AgilClient`:

```kotlin
val client = AgilClient(AgilClientConfig("https://calls.example.com"))

client.join(
    roomId = "team-sync",
    request = AgilJoinRequest(name = "Anna", locale = "ru"),
    callback = object : AgilJoinCallback {
        override fun onJoined(result: AgilJoinResult) {
            when (result) {
                is AgilJoinResult.Joined -> {
                    // result.token is a secret; pass it to AgilCallConfig, never log it
                    call.load(
                        AgilCallConfig(
                            serverUrl = "https://calls.example.com",
                            room = result.room?.id ?: "team-sync",
                            token = result.token,
                            participantName = result.participant?.name ?: "Anna",
                        ),
                    )
                }
                is AgilJoinResult.Pending -> {
                    // Waiting room: no token yet. Poll
                    // GET /v1/rooms/{room}/lobby/{result.requestId} every
                    // result.pollAfterMillis ms, or let the widget lobby screen
                    // handle it (load AgilCallConfig without token).
                    showLobby(result.requestId, result.expiresAtEpochMillis)
                }
            }
        }

        override fun onError(error: AgilJoinException) {
            when (error) {
                is AgilJoinException.InvalidConfig -> showValidationError(error.message)
                is AgilJoinException.Http -> when (error.code) {
                    "password_required" -> showPasswordPrompt()
                    "password_invalid" -> showPasswordPrompt(retry = true)
                    "identity_required" -> showSsoPrompt()
                    "invalid_identity_token" -> showSsoPrompt(retry = true)
                    "room_full" -> showRoomFull()
                    "room_locked" -> showRoomLocked()
                    else -> showServerError(error.message)
                }
                is AgilJoinException.Timeout,
                is AgilJoinException.Network -> showRetry()
                is AgilJoinException.Parse,
                is AgilJoinException.Cancelled,
                is AgilJoinException.Closed -> Unit
            }
        }
    },
).also { handle -> /* handle.cancel() on screen destroy */ }
```

### OIDC / SSO (`identityToken`)

Tenants with `security.requireVerifiedIdentity` need a verified corporate
identity. Pass the OIDC ID token as `identityToken` in the join request **and/or**
in the widget URL:

```kotlin
// 1. Join with the assertion (the server returns 401 identity_required without it).
client.join(
    "team-sync",
    AgilJoinRequest(name = "Anna", identityToken = oidcIdToken),
    callback,
)

// 2. Load the widget with the same assertion so its own join screen works too.
call.load(
    AgilCallConfig(
        serverUrl = "https://calls.example.com",
        room = "team-sync",
        identityToken = oidcIdToken,   // -> /embed.html?...&identity_token=…
        role = AgilRole.MODERATOR,     // -> &role=moderator
        language = "ru",
    ),
)
```

`identity_token` is part of the embed contract, so it travels in the WebView
page URL (history/process memory) exactly like `token`; the SDK never logs it,
masks it in `toString()`/`redactedUrl` and never puts it in error messages.
Prefer a short-lived assertion and HTTPS. The server still derives the role
from the verified identity/token — `role` is a UI/permissions hint only
(`host`/`moderator`/`guest`), never an authorization grant.

`joinBlocking(roomId, request)` exists for worker threads; it throws
`AgilJoinException` and **must not** be called on the main thread. Call
`client.close()` when the screen goes away; a `join()` after `close()` still
settles the callback with `AgilJoinException.Closed`.

`AgilClient` sends `POST {server}/v1/rooms/{url-encoded-room}/join` with JSON
`{name?, password?, participantId?, locale?, identityToken?}` and optional
`Authorization: Bearer <inviteToken>`. `locale` is normalized to `ru`/`en`
(the server rejects anything else). Redirects are disabled on purpose so a
join request cannot be forwarded to another host. Responses are capped at
262,144 characters. Callbacks are posted to the main thread.

### Join result types

| Type | When | Fields |
|---|---|---|
| `AgilJoinResult.Joined` | HTTP 200 with `token` | `token`, `status="joined"`, `expiresAtEpochMillis`, `room`, `participant`, `permissions` |
| `AgilJoinResult.Pending` | HTTP 202 or `pending:true`/`status:"pending"` | `requestId`, `status` (default `"pending"`), `roomId`, `expiresAtEpochMillis`, `pollAfterMillis`, no token |
| `AgilJoinException.Http` | any non-2xx (and redirects) | `status`, `code` (`password_required`/`password_invalid`/`identity_required`/`invalid_identity_token`/`room_full`/`room_locked`/`geo_blocked`/`quota_exceeded`/…), redacted `serverMessage` |
| `AgilJoinException.Parse` | 2xx body is neither Joined nor Pending | token-free message (`no token`, `no requestId`, `malformed`, `too large`) |

---

## 6. `AgilCallConfig`

| Property | Type | Default | Meaning |
|---|---|---|---|
| `serverUrl` | `String` | — | Server base, `http(s)`; subpath preserved |
| `room` | `String` | — | Room id (≤ 200; no `/`, `\`, `.`/`..`) |
| `token` | `String?` | `null` | Short-lived join token |
| `tenant` | `String` | `"demo"` | Tenant id (≤ 64) |
| `participantName` | `String?` | `null` | Display name for the join screen (≤ 120) |
| `identityToken` | `String?` | `null` | OIDC/SSO assertion (`identity_token=`, ≤ 16384); redacted like `token` |
| `role` | `AgilRole?` | `null` | `HOST`/`MODERATOR`/`GUEST` hint (`role=host\|moderator\|guest`) |
| `language` | `String?` | `null` | `ru`/`en`; `en-US`/`ru-RU` normalize to the primary subtag |
| `theme` | `AgilTheme?` | `null` | `LIGHT` / `DARK` / `AUTO` scheme only |
| `relayOnly` | `Boolean` | `false` | Forces TURN-only media (`relay=1`) |
| `widgetPath` | `String` | `"embed.html"` | Relative path; `/embed.html` for the origin root |
| `allowedOrigins` | `List<String>` | empty | Extra exact origins for the navigation guard |
| `safeArea` | `Boolean` | `true` | Add system-bar/cutout padding via window insets |
| `allowInsecure` | `Boolean` | `false` | Allow HTTP outside dev hosts (dev only) |
| `autoplay` | `Boolean` | `true` | `mediaPlaybackRequiresUserGesture = false` |
| `backgroundColor` | `Int` | `0xFF080D16` | WebView background |
| `bridgeTimeoutMillis` | `Long` | `20_000` | Handshake watchdog; `0` disables |

Construction validates every field and throws `AgilCallConfigException` with a
**token-free** message and a `field` name. Validation failures during
`AgilCallView.load` are delivered as
`AgilCallEvent.Error(AgilCallError.InvalidConfig(...))`; the previously loaded
page is left untouched.

With a subpath server (`https://host/calls`), the default relative path resolves
to `https://host/calls/embed.html`; pass `widgetPath = "/embed.html"` to target
the origin root instead.

### Safe area and window insets

`AgilCallView` applies `systemBars() | displayCutout()` insets as padding on
API 30+, and the deprecated system-window insets on API 26–29, when
`safeArea = true`. The host Activity must be edge-to-edge for these insets to be
non-zero (Android 15 targets do this by default). If the Activity already pads
its content, set `safeArea = false` to avoid double padding.

---

## 7. Events

All events arrive on the main thread through `AgilCallEventListener`.

| Event | Fields | When |
|---|---|---|
| `Ready` | `capabilities`, `room?` | Widget mounted (`agil:ready`) |
| `Joined` | `participantCount` (best effort, never `null`) | Participant joined (`agil:event joined`) |
| `Left` | `reason` (`"local"` unless the widget sends one) | Participant left (`agil:event left`) |
| `Chat` | `message` (`text`, ids, name, `timestamp`) | `agil:chat` |
| `State` | `snapshot` (phase, participants, quality, settings, …) | `agil:state` |
| `Error` | `error` (typed `AgilCallError`) | Config/load/bridge/widget/permission errors |
| `Generic` | `name`, `payloadJson?` | Any other widget event (`quality-changed`, …) |

`AgilCallError` cases: `InvalidConfig`, `LoadFailed`, `Http`, `NavigationBlocked`,
`PermissionDenied`, `Bridge`, `Timeout`, `RenderProcessGone`, `Widget`,
`ActionDenied`. `fatal` tells the host that the screen cannot continue without
an action (fix config, grant permission or recreate the view).

`Widget` errors honor the widget's own `fatal` flag: a signaling failure after
the handshake the widget marks `fatal:true` is reported as fatal, while anything
received before `agil:ready` is always fatal (a failed mount).

`AgilCallView.isReady` becomes `true` after `agil:ready` or a successful
ping/pong handshake; `isJoined` follows `joined`/`left` and state phases.

The widget's `joined` payload is `{room, self}` and its `left` payload is `{}`,
so the SDK fills the documented fields itself: `Joined.participantCount` comes
from a `participants`/`participantIds` field when present, else from the latest
`agil:state` snapshot, else `1` (the local participant), and the authoritative
count is always in the following `State` snapshot; `Left.reason` is `"local"`
for the widget's local-leave event or the widget-provided reason.

### Bridge details and the one timing caveat

`/embed.html` posts to `window.parent` with `targetOrigin:'*'`. In a top-level
WebView `window.parent === window`, so those are same-window `message` events.
The SDK injects a shim that:

1. installs a `message` listener and forwards documented `agil:*` widget
   messages (`ready/event/chat/state/pong/minimized/fullscreen`) to the native
   `AgilCallsBridge.postMessage` JavaScript interface;
2. filters host commands (`action/theme/scheme/chat-send/ping`) so they are
   never echoed back;
3. checks `window.location.origin` against the configured server origin and
   only runs in the top frame;
4. is idempotent and installs a small "shim alive" beacon;
5. wraps every forwarded message in a **per-load nonce envelope** (see
   §10): `{"__agilBridgeNonce":"<nonce>","message":"<widget json>"}`.

Commands are sent with `window.postMessage(<json>, window.location.origin)`,
which the widget's own `message` listener accepts (same origin, `source ===
window.parent`). Commands issued before the handshake are queued (up to 50) and
flushed after the first pong/ready/state/chat/event. A ping loop re-installs the
shim and pings every 800 ms until ready.

**Caveat:** the shim is installed from `WebViewClient.onPageStarted` (plus
`onPageCommitVisible`/`onPageFinished` and the ping loop). If the widget posts
`agil:ready` *before* the first shim installation, the `Ready` event (and its
capabilities) may be missed. The ping fallback still detects the mounted widget
via `agil:pong`, sets `isReady = true`, flushes commands and continues with
`state`/`chat`/events. Hosts should not block the whole UI solely on `Ready`.
`androidx.webkit`'s document-start API would remove this caveat, but the core
module intentionally avoids the extra dependency.

---

## 8. Commands

| Method | Wire message |
|---|---|
| `toggleMute()` | `agil:action toggle-mic` |
| `toggleCamera()` | `agil:action toggle-camera` |
| `toggleChat()` | `agil:action toggle-chat` |
| `toggleScreenShare()` | `agil:action share-screen` |
| `blurOn()` / `blurOff()` | `agil:action blur-on` / `blur-off` |
| `minimize()` / `restore()` | `agil:action minimize` / `restore` |
| `togglePictureInPicture()` | `agil:action pip` |
| `toggleFullscreen()` | `agil:action fullscreen` |
| `openInNewTab()` | `agil:action newtab` |
| `raiseHand()` | `agil:action raise-hand` (extension, see below) |
| `sendReaction(emoji)` | `agil:action {action:'reaction', emoji}` (≤ 16 chars) |
| `leave()` | `agil:action leave` |
| `sendAction(name)` | `agil:action <name>`, validated against `WIDGET_ACTIONS` |
| `sendChat(text)` | `agil:chat-send` (≤ 4000 chars) |
| `setTheme(theme)` | `agil:scheme` (`light`/`dark`/`auto`) |
| `applyTheme(patch)` | `agil:theme` (`ThemePatch` JSON, no reload) |
| `applyConfig(patch)` | `agil:config` (`TenantConfigPatch` JSON, no reload) |
| `ping()` | `agil:ping` |
| `reload()` | reloads the page and restarts the bridge/timeout |
| `unload()` | stops the page and clears the configuration |
| `release()` | destroys the WebView (call from `onDestroy`) |

`WIDGET_ACTIONS` is the documented `agil:action` set
(`agil/websdk/embed/src/bridge.ts`, `agil/core/docs/contract.md` §7) plus the
`raise-hand`/`reaction` extensions that map to the widget's public
`raiseHand()`/`sendReaction()` API. A hosted page that does not implement an
extension answers `agil:event {event:'action-denied', payload:{action, reason}}`;
`raiseHand()`/`sendReaction()` therefore surface as non-fatal
`Error(ActionDenied)` there. For a custom native screen-sharing button,
check `AgilCallEvent.Ready.capabilities.screenShare` before offering the action.
If the room permits sharing and `getDisplayMedia` is unavailable,
`toggleScreenShare()` emits a non-fatal `Error(ActionDenied)` with action
`share-screen` and reason `screen-share-unavailable`. The WebView can still
play an incoming screen share. PiP has its own availability check.

Invalid commands (empty/too-long chat, unknown action, bad emoji) arrive as
`Error(InvalidConfig)`. A denied widget action arrives as `Error(ActionDenied)`.

---

## 9. Permissions

The WebView can capture media only after the **app** holds `CAMERA` /
`RECORD_AUDIO`. `AgilCallView` implements `WebChromeClient.onPermissionRequest`:

1. rejects requests whose origin is not the **widget server origin** —
   `allowedOrigins` entries are navigation/message targets only and never get
   camera/microphone (same rule as iOS);
2. grants immediately when the app already has both permissions;
3. otherwise calls `Activity.requestPermissions(...)` with
   `AgilCallView.PERMISSION_REQUEST_CODE` and remembers the pending request;
4. grants/denies after `onRequestPermissionsResult`, emitting
   `PermissionDenied` (non-fatal) when denied.

A partial grant (user allows the camera but not the microphone) currently denies
the whole Web permission request; request both permissions before mounting if
you need a guaranteed outcome, and treat `PermissionDenied.resources` as
"camera/microphone unavailable".

Forward the result from the host Activity:

```kotlin
override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
) {
    if (!callView.onRequestPermissionsResult(requestCode, permissions, grantResults)) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }
}
```

The example requests camera/microphone before the first join. If you use
AndroidX `ActivityResultContracts`, add `AgilCallView.PERMISSION_REQUEST_CODE`
to your contract or request media permissions before mounting the view; the
view also emits `PermissionDenied` if it cannot prompt.

For chat attachments and custom camera backgrounds, forward the Activity result
to the same call view. The picker uses Android's Storage Access Framework and
accepts one document with a read grant. The view does not request a storage
permission. For Compose, use `onViewReady` to obtain the view.

```kotlin
override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (!callView.onActivityResult(requestCode, resultCode, data)) {
        super.onActivityResult(requestCode, resultCode, data)
    }
}
```

The call configuration and the participant's role must allow file sharing for
the attachment button to appear.

Autoplay is controlled by `autoplay` (`mediaPlaybackRequiresUserGesture`).
WebView/OS policies can still require a user gesture for unmuted media on some
devices; the widget's own join button normally supplies it.

---

## 10. Security model

- **HTTPS required.** Plain HTTP is accepted only for loopback/emulator hosts or
  when `allowInsecure = true` (development only).
- **No credentials or query/fragment** in `serverUrl`; no `javascript:`,
  `file:`, `data:`, `ws:`.
- **Exact origin allowlist** (`allowedOrigins`): no wildcards, no paths, no
  query/fragment. The widget origin is always the trust anchor. The navigation
  guard blocks every main-frame navigation outside it and reports
  `NavigationBlocked`; `externalLinkHandler` can open blocked links.
- **TLS errors are never bypassed**: `onReceivedSslError` always cancels.
- **Mixed content is disabled**: `MIXED_CONTENT_NEVER_ALLOW`.
- **File/content access disabled**; geolocation denied; third-party cookies
  disabled; console output discarded (no logcat leakage).
- **JavaScript interface hardening (frame binding)**: `addJavascriptInterface`
  exposes the bridge object to **every frame**, and native code only sees the
  top-level URL, so each page load gets a fresh 256-bit nonce. The shim embeds
  it only in the widget-origin top-frame closure and wraps every forwarded
  message as `{"__agilBridgeNonce":"<nonce>","message":"<widget json>"}`;
  `AgilCallsBridge.postMessage` rejects anything without the current nonce.
  A subframe or foreign-origin page can still *call* the interface but cannot
  produce a valid envelope, so it cannot forge `agil:ready`/`agil:event`/
  `agil:chat`/`agil:state`/`agil:pong`. The nonce is regenerated on every
  `load()` and cleared on `unload()`/`release()`; without it the shim is inert.
  This mirrors the Capacitor/RN nonce envelope and compensates for
  `addJavascriptInterface` having no frame/origin information (iOS uses
  `frameInfo.isMainFrame`). Runtime behavior is covered by
  `agil/core/scripts/shim-smoke.mjs`; the JVM tests pin the envelope contract.
- **Token handling**: the join token (and the optional `identity_token`) sit in
  the `/embed.html` query string, per the embed contract. They are never logged
  or included in error messages. `AgilTokenRedactor` masks `token`,
  `identity_token`/`id_token`, `access_token`, `refresh_token`, JWT-looking
  strings and `Bearer` values in host diagnostics. Still treat URLs as secrets:
  WebView history/DOM storage and any host logging can expose them. Use short
  TTLs and clear WebView data on sign-out if needed.
- **Join client**: redirects disabled, response size capped, no API key in the
  app, server error text redacted, `identityToken` sent only in the POST body
  (never in a URL by `AgilClient`), callbacks on the main thread, cancellation
  supported, `Closed` always settles the callback.
- **No logging at all** from the SDK — not even in debug builds. Add host-side
  logging with `AgilTokenRedactor` if needed.
- **Renderer isolation**: `onRenderProcessGone` reports a fatal error, destroys
  the WebView and requires the host to recreate the view (returning `true`
  prevents a process crash).

### URL rules

- `serverUrl`: absolute `http(s)`, host required, no userinfo/query/fragment,
  trailing slash removed, subpath preserved; `.`/`..` and percent-encoded
  traversal (`%2e%2e`, `%2f`) segments rejected.
- Values: room ≤ 200, tenant ≤ 64, name ≤ 120, `language` normalized to
  `ru`/`en` (≤ 35 before normalization), token ≤ 8192, `identityToken` ≤ 16384,
  without whitespace/control characters.
- Plain HTTP is accepted only for `localhost`, `::1`,
  `0:0:0:0:0:0:0:1`, `10.0.2.2`, `10.0.3.2` and **numeric IPv4 `127.0.0.0/8`
  literals**; a DNS name such as `127.evil.com` or `127.0.0.1.nip.io` is not a
  dev host and requires HTTPS (or `allowInsecure = true`).
- `widgetPath`: relative or leading `/`, no scheme, no `//`, no backslash, no
  `.`/`..` segments (also when percent-encoded), no encoded separators, no
  query/fragment. The generated URL always stays on the server origin.
- Query values are percent-encoded with UTF-8 (`URLEncoder`).

---

## 11. Compose wrapper

```kotlin
import com.agilcalls.compose.AgilCall
import com.agilcalls.sdk.AgilCallConfig
import com.agilcalls.sdk.AgilCallEvent
import com.agilcalls.sdk.AgilCallEventListener

@Composable
fun CallScreen(token: String) {
    var status by remember { mutableStateOf("connecting") }
    AgilCall(
        config = AgilCallConfig(
            serverUrl = "https://calls.example.com",
            room = "team-sync",
            token = token,
        ),
        modifier = Modifier.fillMaxSize(),
        listener = AgilCallEventListener { event ->
            when (event) {
                is AgilCallEvent.Joined -> status = "joined"
                is AgilCallEvent.Error -> status = event.error.message
                else -> Unit
            }
        },
        onViewReady = { view ->
            // forward Activity permission results to view.onRequestPermissionsResult(...)
        },
    )
}
```

The Compose wrapper owns the view lifecycle (`release()` on disposal), reloads
when `config` changes and keeps the latest listener without recomposition
churn. Compose dependencies are declared in `agil-calls-compose`; the core
module stays dependency-free.

---

## 12. ProGuard / R8

The AAR ships `consumer-rules.pro`, applied automatically by AGP:

```proguard
-keep public class com.agilcalls.sdk.AgilCallView { public *; }
-keep public class com.agilcalls.sdk.AgilCallConfig { public *; }
-keep public interface com.agilcalls.sdk.AgilCallEventListener { *; }
-keep class com.agilcalls.sdk.AgilCallEvent$* { *; }
-keep class com.agilcalls.sdk.AgilCallError$* { *; }
-keep class com.agilcalls.sdk.AgilJoinResult$* { *; }
-keep class com.agilcalls.sdk.AgilJoinException$* { *; }
# The runtime annotation is how the bridge method is found after shrinking.
-keepattributes RuntimeVisibleAnnotations
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
```

The `JavascriptInterface` keep rule is mandatory: R8 renames methods by default,
which would break `window.AgilCallsBridge.postMessage`. If your app uses
reflection/serialization on the model types, keep them as usual. Compose
consumers additionally keep `com.agilcalls.compose.AgilCallKt` via the Compose
module's consumer rules.

---

## 13. Limitations

- **Not native WebRTC.** Video/audio run in Android System WebView. Native
  LiveKit + ConnectionService/CallKit is a later tier.
- **WebView dependency.** Current AndroidX/System WebView is required; very old
  or heavily modified WebViews may lack `getUserMedia`/MediaRecorder features.
  The SDK does not bundle a WebView.
- **Shim timing caveat** described in §7: `Ready` capabilities can be missed on
  a very early page, while commands recover via ping/pong.
- **Screen share** (`getDisplayMedia`) and picture-in-picture are not available
  in Android WebView; `toggleScreenShare()`/`togglePictureInPicture()` reach the
  page but are answered with `action-denied`.
- **`raise-hand`/`reaction` extensions** map to the widget's `raiseHand()`/
  `sendReaction()` API; a hosted page that only implements the documented
  `agil:action` set answers `action-denied`. They do not affect the token/role.
- **No background/CallKit/push.** The OS may pause WebView when the app goes to
  background. Incoming calls and system call UI are not implemented.
- **Fullscreen video:** the widget's own fullscreen API requires a
  `WebChromeClient.onShowCustomView` implementation, which this tier does not
  provide; use the widget's in-page layout.
- **File chooser / file sharing** from the widget is not implemented
  (`onShowFileChooser` is not overridden).
- **One active call per view/Activity.** Multiple simultaneous WebView calls
  are not supported on low-end devices.
- **Rotation/config changes** recreate the view (and the WebView); keep the
  room/token in a ViewModel and call `load(...)` again, or declare the relevant
  `configChanges` as the example Activity does. WebView state is not persisted
  by the SDK.
- **Token/identity token in URL/history.** Use short TTLs and HTTPS; do not log
  URLs. The SDK redacts them in its own errors, but WebView internals (history,
  cache) may still contain the URL.
- **Partial media grants** deny the whole Web permission request (camera and
  microphone together); request both up front or handle `PermissionDenied`.
- **No device tests here.** Instrumentation tests require an emulator/device and
  were not run in the authoring environment.
- **Renderer crash recovery** requires recreating `AgilCallView`; the SDK
  destroys the dead WebView and reports `RenderProcessGone`.

---

## 14. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `InvalidConfig: serverUrl must use https…` | Use HTTPS; for dev use `localhost`/`10.0.2.2`/a numeric `127.x.y.z` address or `allowInsecure = true` (debug only) |
| `Timeout` after 20 s | `/embed.html` unreachable, CSP/frame policy, self-signed cert, wrong `serverUrl`/subpath |
| No `Ready`, but chat/state work | early `agil:ready` before shim install; use `isReady`/state, or upgrade to a document-start shim tier |
| `PermissionDenied` | Camera/mic not granted; request them before joining or forward `onRequestPermissionsResult` |
| Black screen | HTTP blocked/mixed content/self-signed cert; use HTTPS and a trusted certificate |
| `Http 404` | Wrong `widgetPath`; subpath deployments need `widgetPath = "embed.html"` (default) or `/embed.html` for root |
| `NavigationBlocked` for SSO | Add the exact origin to `allowedOrigins`, or handle `externalLinkHandler` |
| `onJoined` gives `AgilJoinResult.Pending` | Tenant has a waiting room (HTTP 202); poll the lobby with `requestId` or load the widget without a token |
| `Http 401 identity_required` | Tenant requires OIDC; send `AgilJoinRequest(identityToken = …)` and/or `AgilCallConfig(identityToken = …)` |
| `InvalidConfig: language must be "ru" or "en"` | The widget/server only support those locales; regional tags are normalized |
| `InvalidConfig: widgetPath must not contain …` | Percent-encoded traversal (`%2e%2e`, `%2f`) is rejected on purpose |
| No audio in background | WebView/OS limitation; native audio stack is not part of this tier |
| Renderer crash | Recreate `AgilCallView` after `RenderProcessGone`; WebView cannot be reused |

---

## 15. Files

```
agil/mobile/android/
├── settings.gradle.kts
├── build.gradle.kts                 # AGP/Kotlin versions
├── gradle.properties
├── agil/core/scripts/
│   ├── shim-smoke.mjs               # headless JS check of the injected shim
│   └── verify-jvm.ps1               # JDK 8 + Kotlin 1.6 fallback: compile + JUnit
├── agil-calls/                      # core library (com.agilcalls:agil-calls)
│   ├── build.gradle.kts
│   ├── consumer-rules.pro
│   ├── proguard-rules.pro
│   └── src/
│       ├── main/java/com/agilcalls/sdk/
│       │   ├── AgilCallConfig.kt
│       │   ├── AgilCallUrl.kt
│       │   ├── AgilTokenRedactor.kt
│       │   ├── AgilCallEvent.kt
│       │   ├── AgilCallError.kt
│       │   ├── AgilJoin.kt
│       │   ├── AgilClient.kt
│       │   ├── AgilBridgeProtocol.kt
│       │   ├── AgilBridgeEnvelope.kt
│       │   └── AgilCallView.kt
│       └── test/java/com/agilcalls/sdk/   # pure JVM JUnit tests
├── agil-calls-compose/              # optional Compose wrapper
└── example/                         # example Activity app
```

See also: [`agil/mobile/android/README.md`](../../mobile/android/README.md),
[`agil/core/docs/embed-module.md`](embed-module.md), [`agil/core/docs/contract.md`](contract.md) §7,
[`agil/core/docs/api.md`](api.md) §4, the fixes/retest handoff
`agil/core/docs/qa-android-fixes.md` and the Flutter/React Native
tiers ([`agil/core/docs/flutter-sdk.md`](flutter-sdk.md), [`agil/core/docs/mobile.md`](mobile.md)).
