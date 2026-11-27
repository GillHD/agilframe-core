# Build your own UI (headless mode)

`@agil/calls-widget` / `@agil/calls-sdk` can run without the built-in interface.
The controller still joins the room, publishes and subscribes media, sends and
receives chat, keeps participants/state, polls and recording — but it renders no
markup of its own. The host draws the UI and calls the public instance API.

The default UI is unchanged when `ui` is omitted (or `ui: 'default'`).

- [1. Mounting headless](#1-mounting-headless)
- [2. Public API](#2-public-api)
- [3. Events](#3-events)
- [4. Vanilla JS example](#4-vanilla-js-example)
- [5. React and Svelte](#5-react-and-svelte)
- [6. Custom buttons and backend-driven actions](#6-custom-buttons-and-backend-driven-actions)
- [7. Icons by URL](#7-icons-by-url)
- [8. CSS and theme tokens](#8-css-and-theme-tokens)
- [9. Security and limitations](#9-security-and-limitations)

## 1. Mounting headless

```ts
import { mountWidget, type AgilWidgetInstance } from '@agil/calls-widget';

const call = await mountWidget(document.querySelector('#call')!, {
  ui: 'headless',              // or the alias: headless: true
  serverUrl: 'http://localhost:8787',
  room: 'team-sync',
  participantName: 'Анна',
  locale: 'ru',
  token: '<optional JWT>',     // with a token the widget joins during mount()
});

await call.join();             // no-op when a token already joined
```

With `AGILCalls.mount('#call', { ui: 'headless', ... })` the SDK is identical;
the SDK still injects the widget CSS, which is harmless in headless mode (only
theme variables are used). `ui` wins when both `ui` and `headless` are set.

In headless mode the widget creates a single empty root element:

```html
<div class="agil-root agil-headless" data-agil-root data-agil-ui="headless" data-agil-headless="true" ...>
  <!-- host-owned markup can be appended here -->
</div>
```

The root has the resolved theme variables (`--agil-*`) inline and the
`agil-headless` class (no `min-height: 320px` stage). The host may append its own
UI inside the root to inherit those variables, or render elsewhere and use the
root as a hidden controller host.

> A token passed in `options.token` joins during `mountWidget()`/`mount()`.
> Without a token the widget starts in phase `idle` and waits for `join()`.

## 2. Public API

All methods work from host buttons or a backend-driven message handler; none of
them require the built-in DOM. Global `m`/`v`/`f` keyboard shortcuts are a
default-UI feature and are **not** installed in headless mode, so the host keeps
full control of its own keyboard map.

| Method | Description |
|---|---|
| `join(): Promise<void>` | Acquire local media, join the room, connect signaling. |
| `leave(): void` / `destroy(): void` | Leave the call / remove the root and timers. |
| `getState(): CallState` | Full observable snapshot (phase, participants, settings, chat, recording, config). |
| `subscribe(listener): () => void` | Store subscription; called on every state change. |
| `getLocalStream(): MediaStream \| null` | Local camera/mic stream (blur-processed video included). |
| `getRemoteStreams(): Record<string, MediaStream>` | Participant id → remote stream (snapshot; departed ids and 0-track streams are never included). |
| `getScreenStream(): MediaStream \| null` | Local screen-share stream while sharing. |
| `getSelf(): Participant \| null` | Local participant after join. |
| `getParticipants(): Participant[]` | Remote participant list (copy). |
| `toggleMic(force?): Promise<boolean>` | Enable/disable the microphone. |
| `toggleCamera(force?): Promise<boolean>` | Enable/disable the camera. |
| `toggleScreenShare(force?): Promise<boolean>` | Start/stop screen sharing (permission-gated). |
| `raiseHand(force = true): boolean` / `lowerHand(): void` | Hand state; returns the resulting state. |
| `sendReaction(emoji): boolean` | Send a reaction (max 16 chars, control chars rejected). |
| `sendChat(text): Promise<ChatMessage>` | Send a chat message (works even when the built-in chat panel is hidden). |
| `startRecording(opts?): Promise<boolean>` | Start local recording; `false` when unsupported/denied. |
| `stopRecording(): Promise<void>` | Stop recording (upload or download handling matches the UI). |
| `listPolls(): Promise<AgilPoll[]>` | Current room polls. |
| `createPoll(input): Promise<AgilPoll>` | Host/moderator only. |
| `votePoll(pollId, optionIds): Promise<AgilPoll>` | Vote; server enforces one-vote rules. |
| `closePoll(pollId): Promise<AgilPoll>` | Host/moderator only. |
| `setBlurMode(mode, imageUrl?)` | Background blur/replacement. |
| `getStats(): Promise<CallStats>` | WebRTC/SFU quality snapshot. |
| `updateTheme(patch)` / `updateConfig(patch)` / `setThemeScheme(scheme)` | Live theme/config. |
| `setChatMode('builtin' \| 'external' \| 'hidden')` | Presentation switch for the default UI; headless hosts can ignore it. |

Streams are live objects owned by the widget. Do **not** clone tracks or call
`stop()` on them from the host; just assign them to `<video>`/`<audio>` elements
and clear `srcObject` when the tile is removed.

## 3. Events

```ts
const off = call.on('remote-stream', (payload) => {
  const { participantId, stream } = payload as { participantId: string; stream: MediaStream | null };
  // stream === null → remove the tile
});
```

| Event | Payload | Notes |
|---|---|---|
| `ready` | `{ serverUrl }` | Emitted before config load, during mount. |
| `joined` / `left` | `{ room, self }` / `{}` | Call lifecycle. |
| `participant-joined` | `Participant` | Remote participant added. |
| `participant-left` | `{ participantId, reason? }` | Remote participant removed. |
| `remote-stream` | `{ participantId, stream }` or `{ participantId, stream: null }` | Stream added/replaced/removed. |
| `media-state` | `Partial<CallSettingsState>` | `mic`, `cam`, `handRaised`, `fullscreen`, ... |
| `noise-detected` | `{ level, rms, at }` | Local mic noise crossed the advisory threshold. No audio samples are included; see `noise-detection.md`. |
| `screen-share-changed` | `{ active, track? }` | Screen share started/stopped. |
| `chat` | `ChatMessage` | Every chat message (local echo included). |
| `reaction` | `{ emoji, participantId?, name?, self }` | Local and remote reactions. |
| `poll` | `AgilPoll` | Poll created/updated/closed (`poll.updated` WS frame). |
| `state` | `CallState` | Full snapshot on every store change — use this (or `subscribe`) to re-render. |
| `toast` | `{ message, kind, actions? }` | Headless only; mirrors messages the default UI would toast. `actions` are `{ label, onClick }` recovery buttons (retry SFU/E2EE, open lobby queue, ...); call `onClick()` from the host button. |
| `error` | `{ code, message, offline? }` / signaling error | Media, join (including offline/timeout failures; `offline: true`), recording-consent and socket errors. |
| `quality-changed`, `connection-state`, `theme-changed`, `minimized-changed`, `chat-mode-changed` | see `AgilWidgetEventPayloads` | Diagnostics/optional UI. |

There are no DOM assumptions: payloads contain `MediaStream`, `Participant`,
`ChatMessage`, `CallState` and plain objects. `on('state')` fires often (quality,
duration, participant flags), so keep the handler cheap or use `subscribe()`.

A failed `join()` (bad token, offline server, timeout) always emits `error` and
leaves headless in `phase: 'error'` with `state.error`/`state.serverOnline` set;
it never switches to the default-UI-only `join-screen` phase. Call `join()`
again to retry after the host fixes its inputs.

## 4. Vanilla JS example

```html
<div id="call"></div>
<button id="mic">Mic</button>
<button id="hand">Hand</button>
<button id="chat">Send</button>

<script type="module">
  import { mountWidget } from '@agil/calls-widget';

  const call = await mountWidget(document.querySelector('#call'), {
    ui: 'headless',
    serverUrl: 'http://localhost:8787',
    room: 'team-sync',
    participantName: 'Анна',
  });

  const root = document.querySelector('#call .agil-root');
  const grid = document.createElement('div');
  const videos = new Map();
  root.appendChild(grid);

  await call.join(); // call from a click handler if the browser requires a gesture

  function renderVideos() {
    const all = new Map();
    if (call.getSelf() && call.getLocalStream()) all.set(call.getSelf().id, [call.getLocalStream(), true]);
    for (const [id, stream] of Object.entries(call.getRemoteStreams())) all.set(id, [stream, false]);
    for (const [id, [stream, self]] of all) {
      let video = videos.get(id);
      if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = self;
        grid.appendChild(video);
        videos.set(id, video);
      }
      if (video.srcObject !== stream) video.srcObject = stream;
    }
    for (const [id, video] of videos) {
      if (!all.has(id)) {
        video.srcObject = null;
        video.remove();
        videos.delete(id);
      }
    }
  }

  call.on('remote-stream', renderVideos);
  call.on('participant-left', renderVideos);
  call.on('state', (state) => {
    document.body.dataset.phase = state.phase;
    renderVideos();
  });

  document.querySelector('#mic').onclick = () => void call.toggleMic();
  document.querySelector('#hand').onclick = () => call.raiseHand();
  document.querySelector('#chat').onclick = () => call.sendChat('Привет из своего UI');
</script>
```

Notes:

- local video must be `muted` or the browser feeds the microphone back.
- call `await call.join()` (or pass a token) before relying on streams; the
  first `getLocalStream()` may be `null` until media is acquired.
- for a custom chat panel, render `call.getState().chat` and subscribe to
  `state`; send with `sendChat()`.
- for a custom join screen, call `join()` from a real user gesture (browsers
  require it for camera/microphone permissions in many cases).

## 5. React and Svelte

React (the same pattern works with Preact):

```tsx
import { useEffect, useRef, useState } from 'react';
import { mountWidget, type AgilWidgetInstance, type CallState } from '@agil/calls-widget';

export function Call({ room }: { room: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const callRef = useRef<AgilWidgetInstance | null>(null);
  const [state, setState] = useState<CallState | null>(null);

  useEffect(() => {
    let disposed = false;
    let unsubscribe = () => {};
    mountWidget(hostRef.current!, { ui: 'headless', room, serverUrl: location.origin })
      .then(async (call) => {
        if (disposed) {
          call.destroy();
          return;
        }
        callRef.current = call;
        unsubscribe = call.subscribe(setState);
        await call.join();
      })
      .catch(console.error);
    return () => {
      disposed = true;
      unsubscribe();
      callRef.current?.destroy();
      callRef.current = null;
    };
  }, [room]);

  const local = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (local.current && callRef.current) local.current.srcObject = callRef.current.getLocalStream();
  }, [state?.localStream]);

  return (
    <div>
      <div ref={hostRef} />
      <video ref={local} autoPlay playsInline muted />
      <button onClick={() => void callRef.current?.toggleMic()}>
        {state?.settings.micEnabled ? 'Mute' : 'Unmute'}
      </button>
      <button onClick={() => callRef.current?.raiseHand()}>Raise hand</button>
    </div>
  );
}
```

Svelte:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { mountWidget, type AgilWidgetInstance, type CallState } from '@agil/calls-widget';

  export let room: string;
  let host: HTMLDivElement;
  let call: AgilWidgetInstance | null = null;
  let state: CallState | null = null;

  onMount(() => {
    let off = () => {};
    let cancelled = false;
    mountWidget(host, { ui: 'headless', room, serverUrl: location.origin }).then(async (widget) => {
      if (cancelled) return widget.destroy();
      call = widget;
      off = widget.subscribe((next) => (state = next));
      await widget.join();
    });
    return () => {
      cancelled = true;
      off();
      call?.destroy();
    };
  });

  onDestroy(() => call?.destroy());
</script>

<div bind:this={host}></div>
<button on:click={() => call?.raiseHand()}>
  {state?.settings.handRaised ? 'Lower hand' : 'Raise hand'}
</button>
```

## 6. Custom buttons and backend-driven actions

Every control maps to a public method; there is no DOM-only action.

| UI action | Controller call | Backend / transport |
|---|---|---|
| Join / leave | `join()`, `leave()`, `destroy()` | `POST /v1/rooms/:id/join` (or token), `WS`, cleanup |
| Mic / camera | `toggleMic(force)`, `toggleCamera(force)` | WebRTC track `enabled`, SFU publication |
| Screen share | `toggleScreenShare(force)` | `getDisplayMedia` + screen track |
| Raise / lower hand | `raiseHand(true)`, `lowerHand()` | `WS { type: 'state', state: { handRaised } }` |
| Emoji reaction | `sendReaction('👍')` | `WS { type: 'reaction', emoji }` |
| Chat | `sendChat(text)` | `WS { type: 'chat' }`, `chat-history` |
| Poll list | `listPolls()` | `GET /v1/rooms/:id/polls` |
| Poll create/close | `createPoll(input)`, `closePoll(id)` | `POST /v1/rooms/:id/polls`, `.../close` |
| Poll vote | `votePoll(id, optionIds)` | `POST /v1/rooms/:id/polls/:pollId/vote` |
| Local recording | `startRecording({ consent? })`, `stopRecording()` | MediaRecorder; `POST /v1/recordings` when server storage is on |
| Cloud recording / egress | backend only (not a widget control) | `POST /v1/rooms/:id/egress/start` with a host/moderator room token, `POST /v1/rooms/:id/egress/:egressId/stop`, `GET /v1/rooms/:id/egress` |
| Blur | `setBlurMode('blur' \| 'image' \| 'off', url?)` | local MediaPipe/CSS fallback |
| Theme/config | `updateTheme`, `updateConfig`, `setThemeScheme` | local overrides (server config remains the base) |

Backend-driven hosts typically receive an action event over their own channel
and call the same method:

```ts
type Action =
  | { type: 'chat'; text: string }
  | { type: 'poll.vote'; pollId: string; optionIds: string[] }
  | { type: 'hand.raise' }
  | { type: 'reaction'; emoji: string }
  | { type: 'egress.start'; kind: 'recording' | 'rtmp' | 'hls'; rtmpUrl?: string };

async function onBackendAction(action: Action) {
  switch (action.type) {
    case 'chat': return void call.sendChat(action.text);
    case 'poll.vote': return void call.votePoll(action.pollId, action.optionIds);
    case 'hand.raise': return void call.raiseHand();
    case 'reaction': return void call.sendReaction(action.emoji);
    case 'egress.start':
      // Egress is a backend/room-token operation, not a widget media action.
      if (action.kind === 'rtmp' && !action.rtmpUrl) throw new Error('rtmpUrl is required for kind=rtmp');
      return fetch(`/v1/rooms/${roomId}/egress/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({
          kind: action.kind,
          ...(action.kind === 'rtmp' ? { rtmpUrl: action.rtmpUrl } : {}),
        }),
      });
  }
}
```

Keep host/room tokens on the server side whenever possible. `egress` is
intentionally not exposed as a widget controller method: it is a privileged
server API and its feature gates live there — `features.recording` plus
`mediaProcessing.egress` or `scale.streaming` for `kind:'recording'`, and
`features.liveStreaming` plus `scale.streaming` for `rtmp`/`hls`. It also
returns `409` when E2EE makes server-side media processing impossible. A
`kind:'rtmp'` request without a valid `rtmpUrl` is a `400`.

## 7. Icons by URL

`iconUrls` replaces **built-in default-UI** icons. Keys are the exported
`IconName` values (`mic`, `mic-off`, `camera`, `camera-off`, `screen`, `chat`,
`hand`, `settings`, `leave`, ...); values must resolve to `http:`/`https:`.

```ts
await mountWidget(el, {
  room: 'team-sync',
  iconUrls: {
    mic: '/brand/icons/mic.svg',
    'mic-off': '/brand/icons/mic-off.svg',
    camera: 'https://cdn.example.com/icons/camera.png',
    chat: '/brand/icons/chat.svg',
    leave: '/brand/icons/hangup.svg',
  },
});
```

How it works:

- the built-in SVG is replaced with `<img class="agil-icon agil-icon-custom">`
  using `document.createElement('img')`; no `innerHTML` and no raw SVG string;
- only `http(s)` URLs are allowed — `javascript:`, `data:` and unknown icon
  names are ignored (the built-in icon stays);
- width/height are copied from the SVG; `referrerPolicy="no-referrer"` is set;
- a `MutationObserver` re-applies replacements after panel/tile re-renders;
- if an image fails to load, the original SVG is restored (no render loop).

Custom icons are fixed-color images (unlike the inline SVGs, they do not use
`currentColor`). Headless mode has no built-in icons to replace — use the host's
own asset pipeline.

## 8. CSS and theme tokens

### Theme variables

The widget root always receives the resolved theme as inline CSS custom
properties. Keep using them in a custom UI:

```css
.my-call {
  color: var(--agil-color-text);
  background: var(--agil-bg-color);
  font-family: var(--agil-font-family);
  border-radius: var(--agil-radius-lg);
  gap: var(--agil-gutter);
}
```

Common tokens: `--agil-color-primary`, `--agil-color-on-primary`,
`--agil-color-text`, `--agil-color-text-muted`, `--agil-color-surface`,
`--agil-color-background`, `--agil-color-border`, `--agil-color-divider`,
`--agil-radius-sm|md|lg|pill`, `--agil-gutter`, `--agil-control-size`,
`--agil-font-family`, `--agil-font-size-base`, `--agil-bg-color`,
`--agil-bg-gradient`, `--agil-motion-fast|base`, `--agil-easing`.
Change them live with `updateTheme({ colors: { primary: '#16a34a' } })` or the
`theme` option; `setThemeScheme('light' | 'dark' | 'auto')` switches the palette.

### `customCss`

`customCss` is host-supplied CSS appended as one `<style>` element and scoped to
the widget root:

```ts
await mountWidget(el, {
  room: 'team-sync',
  // Theme tokens are inline custom properties: change them via the theme API.
  theme: { shape: { radiusMd: 10 } },
  customCss: `
    .agil-chat-list { max-height: 42vh; }    /* built-in default-UI element */
    .my-panel { border: 1px solid var(--agil-color-border); }
  `,
});
```

Rules:

- selectors are prefixed with a per-instance attribute selector
  (`[data-agil-widget="w…"]`), so CSS cannot leak to the host page and multiple
  widgets do not collide;
- `:root`, `html`, `body`, `.agil-root` and `[data-agil-root]` map to the widget
  root itself;
- `@media`, `@supports`, `@container`, `@layer` bodies are scoped recursively;
- `&` is replaced with the scope (simple CSS-nesting style);
- `@keyframes`/`@font-face` stay global by design (names must not collide with
  host CSS); `@import`, `@charset` and `@namespace` are dropped, including
  escaped/obfuscated spellings such as `@\69mport`;
- plain CSS only (no full nesting/declarations-with-nested-rules parser);
- inline theme variables set by the widget win over stylesheet custom
  properties — use `updateTheme()`/`theme` for tokens, not a CSS rule;
- two widgets get two distinct scopes, even when two copies of the widget
  bundle are loaded on the same page (scope ids include per-page entropy).

### Fully replace styles and markup

Use `ui: 'headless'` for full replacement: no built-in CSS classes are rendered,
so there is nothing to override. You can omit `customCss` entirely and style the
host-owned markup however you like; keep the `--agil-*` variables only if you
want the tenant theme to drive your UI. For the default UI, `customCss` is the
supported cosmetic override; wholesale markup changes are out of scope by design.

## 9. Security and limitations

- **`customCss` is trusted host code and is not sanitized.** Do not pass
  end-user-generated CSS. It can load remote `url()` assets (the host controls
  those URLs); `@import`/`@charset`/`@namespace` are ignored (escaped spellings
  are decoded before the check) to prevent page-wide stylesheet injection.
- **Join token transport:** the signaling token is sent in the
  `Sec-WebSocket-Protocol` handshake header, never in the WebSocket URL, so a
  failed upgrade cannot print the JWT to the browser console. Keep room/host
  tokens on the server side as before.
- **`iconUrls` is allow-listed:** only known icon names and `http(s)` URLs,
  rendered through `<img>`. No HTML/SVG injection, no `data:` URLs. A custom
  icon is an extra network request; `referrerPolicy="no-referrer"` is set.
- Headless mode does not render a join screen, lobby UI, panels, toasts,
  recording-consent dialog, mini window or Document PiP. The iframe embed
  (`createEmbed`) always runs the default UI; headless requires the JS SDK
  `mount()` in the host page. The host must render
  join/leave controls and recording consent (`startRecording({ consent: true })`
  when the tenant requires consent; otherwise `false` + `error` with
  `code: 'recording_consent_required'`). Actionable default-UI toasts arrive as
  `toast` events with an `actions` array; render the buttons yourself.
- Headless does not install the default UI's global `m`/`v`/`c`/`b`/`h`/`f`
  keyboard shortcuts, so host input is never muted behind the host UI. Wire your
  own keys to the public API if you want them.
- Whiteboard, screen-share annotations and the in-call assistant panel are
  default-UI surfaces; headless mode does not expose their controllers. Polls
  are available through the public methods above.
- Chat: in headless mode `sendChat()` ignores the presentational
  `chatMode: 'hidden'` switch; feature permissions still decide. Host-rendered
  chat should use `getState().chat` + `state`/`chat` events.
- Media is published only after `join()`, which should run from a user gesture
  when the browser requires one. The host must mute local self-preview and clear
  `srcObject` when removing tiles.
- The widget root is `position: relative` and themed; headless removes the
  built-in 320px min height but the host still owns the container size.
- `destroy()` removes the root, custom CSS, `on()` handlers and every
  `subscribe()` listener (no need to keep the returned unsubscribe for
  correctness, though calling it is still fine). Always call it on
  route/unmount to stop timers and release camera/microphone.
- No server changes are required for headless mode or custom CSS/icons. Egress
  remains the existing privileged room-token API described above.
