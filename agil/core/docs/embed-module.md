# Embeddable Web Component (`@agil/calls-embed`)

`<agil-call>` is a framework-agnostic custom element that embeds the hosted
AgilFrame page (`/embed.html`) and talks to it over the documented
`postMessage` contract (contract §7). It works in plain HTML, React, Vue,
Svelte, Angular or any other host that can render a DOM element.

```
┌──────────────────────────── host page ────────────────────────────┐
│  <agil-call server-url room token …>                              │
│    shadow DOM                                                     │
│    ┌──────────────────────────────────────────────────────────┐   │
│    │  loading / error UI      floating launcher (optional)    │   │
│    │  ┌────────────────────────────────────────────────────┐  │   │
│    │  │  iframe  /embed.html?server&room&token&tenant…    │  │   │
│    │  │  widget: join screen, video grid, chat, themes    │  │   │
│    │  └────────────────────────────────────────────────────┘  │   │
│    └──────────────────────────────────────────────────────────┘   │
└───────────────▲───────────────────────────────────┬───────────────┘
                │  agil:ready/event/chat/state      │  agil:ping/action/
                │  agil:resize/pong                 │  theme/scheme/chat-send
                │  source + exact origin checked    │  exact targetOrigin
```

## Build and artifacts

```bash
npm run build:embed                 # repo root
npm run typecheck -w @agil/calls-embed
npm test -w @agil/calls-embed
```

| File | Format | Size (raw / gzip) |
| --- | --- | ---: |
| `agil/websdk/embed/dist/agil-call-embed.js` | ESM | 47.78 kB / 13.83 kB |
| `agil/websdk/embed/dist/agil-call-embed.iife.js` | IIFE, `AgilCallEmbed` | 35.70 kB / 11.95 kB |
| `agil/websdk/embed/dist/types/index.d.ts` | TypeScript declarations | — |

The ESM and IIFE builds auto-register `<agil-call>` in a browser. Import in
Node/SSR is safe and performs no registration. Source maps are emitted next to
the bundles.

## Script tag

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="https://calls.example.com/embed/agil-call-embed.iife.js"></script>
  </head>
  <body>
    <!-- inline call: 640 px tall -->
    <agil-call
      id="call"
      server-url="https://calls.example.com"
      tenant="acme"
      room="team-sync"
      token="<short-lived-jwt>"
      name="Anna"
      theme="auto"
      language="en"
      height="640px"
    ></agil-call>

    <script>
      const call = document.getElementById('call');

      call.addEventListener('agil-ready', (event) => {
        console.log('capabilities', event.detail.capabilities);
      });
      call.addEventListener('agil-joined', () => console.log('joined'));
      call.addEventListener('agil-chat', (event) => {
        console.log('chat:', event.detail.message.text);
      });
      call.addEventListener('agil-error', (event) => {
        console.error(event.detail.code, event.detail.message);
      });

      // Optional: join / chat / theme / leave programmatically.
      // await call.join();
      // await call.sendChat('Hello');
      // await call.setTheme('dark');
      // await call.leave();
    </script>
  </body>
</html>
```

### Floating launcher

```html
<agil-call
  launcher
  server-url="https://calls.example.com"
  room="team-sync"
  token="<short-lived-jwt>"
  theme="auto"
  language="en"
></agil-call>
```

The iframe is created on the first click, not at page load. Closing the modal
keeps the call alive; `call.close()` hides it and `call.open()` restores it.
`launcher="Video support"` uses that text as the button's accessible label.

## React

```tsx
import { useEffect, useRef } from 'react';
import '@agil/calls-embed';
import type { AgilCallElement, AgilChatDetail } from '@agil/calls-embed';

// Tell JSX about the custom element (React 19 uses React.JSX; the shape is the
// same). Remove this block if your project types custom elements elsewhere.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'agil-call': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        'server-url'?: string;
        tenant?: string;
        room?: string;
        token?: string;
        name?: string;
        theme?: 'light' | 'dark' | 'auto';
        language?: string;
        height?: string;
        launcher?: boolean | string;
        'relay-only'?: boolean;
        'allowed-origins'?: string;
      };
    }
  }
}

export function SupportCall({ token }: { token: string }) {
  const callRef = useRef<AgilCallElement | null>(null);

  useEffect(() => {
    const call = callRef.current;
    if (!call) return;
    const onChat = (event: Event) => {
      const detail = (event as CustomEvent<AgilChatDetail>).detail;
      console.log('chat', detail.message.text);
    };
    const onError = (event: Event) => {
      console.error((event as CustomEvent).detail);
    };
    call.addEventListener('agil-chat', onChat);
    call.addEventListener('agil-error', onError);
    return () => {
      call.removeEventListener('agil-chat', onChat);
      call.removeEventListener('agil-error', onError);
      // Do not call destroy() here: React StrictMode runs cleanup + effect
      // again on the same node and destroy() is permanent. Disconnecting the
      // element already tears the iframe/bridge down; call destroy() only when
      // the element is really removed for good.
    };
  }, []);

  return (
    <agil-call
      ref={callRef as React.Ref<HTMLElement>}
      server-url="https://calls.example.com"
      tenant="acme"
      room="team-sync"
      token={token}
      name="Anna"
      theme="auto"
      language="en"
      height="640px"
      launcher
    />
  );
}
```

Notes:

- Importing the package is side-effectful (registration) — do it once in the
  app entry or the component module.
- `destroy()` in the effect cleanup removes the iframe and bridge. If you want
  to keep a call alive across route changes, only call `close()`/`leave()`.
- Changing `token`/`room`/`server-url` attributes rebuilds the iframe. Use
  `call.setTheme()` for live theme changes.

## Vue 3

```ts
// vite.config.ts — treat <agil-call> as a native custom element
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'agil-call',
        },
      },
    }),
  ],
});
```

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import '@agil/calls-embed';
import type { AgilCallElement, AgilChatDetail } from '@agil/calls-embed';

defineProps<{ token: string }>();
const call = ref<AgilCallElement | null>(null);

function onChat(event: Event) {
  console.log((event as CustomEvent<AgilChatDetail>).detail.message.text);
}

onMounted(() => call.value?.addEventListener('agil-chat', onChat));
onBeforeUnmount(() => {
  call.value?.removeEventListener('agil-chat', onChat);
  call.value?.destroy();
});
</script>

<template>
  <agil-call
    ref="call"
    server-url="https://calls.example.com"
    tenant="acme"
    room="team-sync"
    :token="token"
    name="Anna"
    theme="auto"
    language="en"
    height="640px"
  ></agil-call>
</template>
```

For a launcher use `<agil-call launcher ...>`. Vue passes `launcher` as an
attribute; `launcher="Support"` sets a custom label.

## Svelte

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import '@agil/calls-embed';
  import type { AgilCallElement, AgilChatDetail } from '@agil/calls-embed';

  export let token: string;
  let call: AgilCallElement;

  onMount(() => {
    const onChat = (event: Event) => {
      console.log((event as CustomEvent<AgilChatDetail>).detail.message.text);
    };
    call.addEventListener('agil-chat', onChat);
    return () => {
      call.removeEventListener('agil-chat', onChat);
      call.destroy();
    };
  });
</script>

<agil-call
  bind:this={call}
  server-url="https://calls.example.com"
  tenant="acme"
  room="team-sync"
  {token}
  name="Anna"
  theme="auto"
  language="en"
  height="640px"
></agil-call>
```

Svelte 4 uses `on:agil-ready={handler}`; Svelte 5 uses `onagil-ready={handler}`.
`addEventListener` (as shown) works in both and is the most portable option.

## Attributes

| Attribute | Allowed values | Default | Notes |
| --- | --- | --- | --- |
| `server-url` | absolute `http(s)` URL | current origin | Credentials, query and fragment are rejected. A path prefix is allowed. Plain `http://` is rejected outside loopback/`10.0.2.2` unless `allow-insecure` is set (development only). |
| `tenant` | ≤100 chars | server-resolved | `?tenant=`. |
| `room` | ≤200 chars, required | — | `?room=`. Missing/blank shows the fallback UI and emits a fatal `agil-error`. |
| `token` | ≤8192 chars | — | `?token=`. Never rendered as text or logged. Rejected if it contains whitespace/control characters. |
| `identity-token` | ≤8192 chars | — | `?identity_token=`. Corporate OIDC token, same validation/redaction as `token`. |
| `role` | `host`, `moderator`, `guest` | — | `?role=` for anonymous (token-less) joins. |
| `name` | ≤200 chars | — | `?name=`. |
| `theme` | `light`, `dark`, `auto` | iframe default (`auto`) | `?theme=` and component chrome. Unknown values are ignored by the attribute path; `setTheme()` rejects them. |
| `language` | BCP-47 (`en`, `ru`, `en-US`, …) | browser | `?lang=` + chrome strings (`ru`/`en`; other tags fall back to English). |
| `widget-path` | same-origin path | `embed.html` | Relative paths resolve under the `server-url` path prefix (subpath deployments are preserved). `/embed.html` targets the origin root. `..`, query, fragment and absolute/cross-origin URLs are rejected. |
| `height` | `auto` or `1–5000` + `px/rem/em/vh/dvh/svh/lvh/%` | `640px` | Inline mode. Bare numbers become `px`. |
| `relay-only` | boolean | `false` | Adds `?relay=1` (TURN only). |
| `allowed-origins` | exact origins, comma/space separated, ≤32 | iframe origin | Wildcards are rejected. The iframe origin is always added. |
| `launcher` | boolean or label | `false` | Floating button/modal. A non-boolean value is used as the accessible label (≤60 chars). |
| `allow-insecure` | boolean | `false` | Allows plain `http://` for non-loopback servers. Development only. |

Properties reflect the attributes: `serverUrl`, `tenant`, `room`, `token`,
`identityToken`, `callRole` (the `role` attribute; `role` itself is the standard
`HTMLElement.role` ARIA property), `name`, `theme`, `language`, `widgetPath`,
`height`, `relayOnly`, `allowedOrigins`, `launcher`, `allowInsecure`.

## Methods

| Method | Returns | Behavior |
| --- | --- | --- |
| `join()` | `Promise<void>` | Opens the launcher (if any), waits for handshake, posts `agil:action {action:'join'}`. With `token`, the hosted widget auto-joins on mount. Without a token, the iframe join screen receives focus (see limitation). |
| `leave()` | `Promise<void>` | Posts `agil:action {action:'leave'}`; no-op without an iframe. |
| `setTheme(theme)` | `Promise<void>` | String: posts `agil:scheme`; object: posts a sanitized `agil:theme` patch. Updates the component chrome immediately. No iframe reload. |
| `sendChat(text)` | `Promise<void>` | Posts `agil:chat-send`; rejects empty text or >4000 characters. |
| `open()` / `close()` | `void` | Launcher modal only. `close()` keeps the call running. |
| `destroy()` | `void` | Stops timers/listeners, blanks and removes the iframe, empties the shadow root. Later method calls reject with `destroyed`. |

Promises resolve once the command is posted; they do not wait for the widget
to complete the action. `join()`/`sendChat()` reject on configuration errors or
handshake timeout.

Read-only state: `status` (`idle | loading | connected | joined | left | error |
destroyed`), `isReady`, `isJoined`, `isLauncherOpen`, `callState`, `lastError`.

## Events

| Event | Detail | When |
| --- | --- | --- |
| `agil-ready` | `{ capabilities, room? }` | Iframe sent `agil:ready` (handshake complete). |
| `agil-joined` | `{ payload? }` | Widget emitted `joined`. |
| `agil-left` | `{ payload? }` | Widget emitted `left`. |
| `agil-chat` | `{ message }` | Widget emitted `agil:chat`. |
| `agil-state` | `{ state }` | Widget emitted `agil:state` (participants, quality, phase, settings, …). |
| `agil-minimized` | `{ minimized }` | Widget emitted `agil:minimized` (same shape as RN/Flutter/Capacitor). |
| `agil-fullscreen` | `{ fullscreen }` | Widget emitted `agil:fullscreen` (same shape as RN/Flutter/Capacitor). |
| `agil-event` | `{ name, payload? }` | Any other widget `agil:event` (`participant-joined`, `quality-changed`, `connection-state`, …). |
| `agil-error` | `{ code, message, fatal, widgetCode? }` | Config/load/bridge failure or widget `error`/`action-denied`. |

Events are `bubbles: true` and `composed: true`, so a document-level listener
works across the shadow boundary. Event details are sanitized and redacted;
`lastError` mirrors the last fatal fallback UI error.

Error codes: `invalid-config`, `missing-room`, `load-timeout`,
`bridge-timeout`, `bridge-error`, `iframe-error`, `widget-error`,
`action-denied`, `destroyed`.

## Bridge protocol

Outbound (component → iframe), always with the canonical iframe origin as
`targetOrigin`:

| Message | Purpose |
| --- | --- |
| `{type:'agil:ping'}` | Handshake/keepalive; iframe answers `agil:pong`. |
| `{type:'agil:action', action}` | `join`, `leave`, `toggle-mic`, `toggle-camera`, `toggle-chat`, `share-screen`, `blur-on`, `blur-off`, `minimize`, `restore`, `pip`, `fullscreen`, `newtab`. |
| `{type:'agil:theme', theme}` | Partial theme patch. |
| `{type:'agil:scheme', scheme}` | `light` / `dark` / `auto`. |
| `{type:'agil:chat-send', text}` | External chat message. |

Inbound (iframe → component), accepted only from `event.source ===
iframe.contentWindow` and an exact allowlisted origin:

| Message | Forwarded as |
| --- | --- |
| `agil:ready` | `agil-ready` |
| `agil:event {event:'joined'}` | `agil-joined` |
| `agil:event {event:'left'}` | `agil-left` |
| `agil:event {event:'error'}` | `agil-error` (fatal before ready) |
| `agil:event {event:'action-denied'}` | `agil-error` (except the documented `join` fallback) |
| `agil:event {event:'…'}` (any other) | `agil-event {name, payload?}` |
| `agil:chat` | `agil-chat` |
| `agil:state` | `agil-state` |
| `agil:minimized` / `agil:fullscreen` | `agil-minimized` / `agil-fullscreen` (`{minimized}` / `{fullscreen}`) |
| `agil:resize {height}` | Resizes inline `height="auto"` (optional extension) |
| `agil:pong` | Handshake completion |

Handshake:

1. Element builds the URL, parses the origin allowlist, creates the iframe.
2. Bridge listener is attached **before** navigation, then `agil:ping` is sent
   every second (initial pings during navigation are harmless).
3. Iframe answers `agil:pong` and posts `agil:ready` with capabilities.
4. Queued commands flush; `agil-ready` is dispatched.
5. A 20 s watchdog shows the fallback UI if the iframe never answers; a late
   handshake can still recover the element.

## Security model

- **URL builder** (`buildEmbedUrl`) is the only path to the iframe URL. It
  enforces `http(s)`, rejects userinfo/query/fragment on `server-url`, requires
  a room, bounds every field, blocks control characters, and refuses a
  `widget-path` that leaves the server origin. Errors never echo values.
- **Origin allowlist** (`parseAllowedOrigins` / `isAllowedOrigin`) canonicalizes
  origins and compares by exact string equality. `*`, `https://*.example.com`,
  paths, queries, fragments, credentials and non-http schemes are rejected.
- **postMessage** outbound always uses `iframe.src`'s canonical origin. There is
  no API to pass `*`; the bridge constructor rejects it.
- **Inbound validation** checks the source window and origin before parsing.
  Malformed, oversized and unknown messages are dropped.
- **Payload sanitization** limits depth/array/object/string sizes, drops
  `__proto__`/`prototype`/`constructor`, functions and symbols, and breaks
  cycles.
- **Token handling**: the token only appears in the iframe `src` query (the
  embed contract). It is never logged, never set with `textContent`/`innerHTML`,
  never put in `title`/`aria-label`, and is redacted from every error message
  and event detail. The iframe uses `referrerpolicy="no-referrer"`.
- **CSP**: the host must be allowed by the server's `frame-ancestors`; the
  tenant's `integrations.allowedOrigins` must accept the host for the iframe's
  own postMessage checks. Client-side checks cannot replace either.
- The iframe is granted `camera; microphone; display-capture; fullscreen;
  picture-in-picture; autoplay; clipboard-write` and `allowfullscreen`. It is
  not sandboxed because the hosted widget needs same-origin storage/media
  access; if your threat model requires `sandbox`, run the widget on a separate
  origin.

## Auto-height and mobile

- `height="640px"` (default) gives a fixed inline frame.
- `height="auto"`:
  - same-origin iframes are measured with `ResizeObserver` (clamped 320–2400px);
  - cross-origin iframes can send `{type:'agil:resize', height}`;
  - otherwise 640px remains as a safe fallback.
- Launcher mode uses the dialog height (desktop `min(760px, 100dvh - 40px)`).
  At ≤640px the dialog becomes a full-viewport sheet (`100dvh`) with safe-area
  padding. Add `<meta name="viewport" content="width=device-width">` to the
  host page for correct mobile layout.
- `prefers-reduced-motion` disables the spinner/launcher animations.

## Error and fallback UI

- Invalid configuration (missing room, invalid origin, bad height/server):
  the stage shows an alert with the localized title, a redacted message and a
  **Try again** button; `agil-error` fires with `fatal: true`.
- Iframe load timeout (15 s) / bridge timeout (20 s): same fallback; a late load
  or handshake hides it automatically.
- Widget `error` before `agil:ready` is fatal and shows the fallback; widget
  errors after ready are informational (`fatal: false`).
- `action-denied` is surfaced non-fatally. The one exception is the
  `join`/`unknown-action` pair, which is the documented hosted-page limitation.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Blank iframe / fallback | Server serves `/embed.html`; CSP `frame-ancestors` includes the host; no `X-Frame-Options: SAMEORIGIN`; HTTPS/mixed content. |
| Never reaches `agil-ready` | `/embed.html` returns 200; tenant allows the host; token still valid; the iframe's own console shows a mount error. |
| `Invalid origin: wildcards…` | `allowed-origins` must list exact origins (`https://app.example.com`), never `*`. |
| `height="auto"` stays 640px | Cross-origin iframe: add `agil:resize` support or set a fixed height. |
| `join()` doesn't enter the call | With a token the widget auto-joins; without one, the hosted join screen must be confirmed. Current `embed.html` has no programmatic join action. |
| Launcher modal not full-screen on phone | Add the viewport meta tag; the breakpoint is 640 CSS px. |
| Token visible in DevTools/network | Expected: it is in the iframe query per contract. Use short-lived tokens, HTTPS and `referrerpolicy="no-referrer"`; it never appears in component text/logs. |

## Tests

`agil/websdk/embed/test/*.test.ts` (node:test + tsx) covers:

- URL builder: encoding, parameter omission, path prefixes, same-origin
  enforcement, protocol/credentials rejection, bounds, token-free errors;
- origin allowlist: canonicalization, wildcard/path rejection, exact matching
  (no suffix attacks), fallback inclusion;
- bridge: exact `targetOrigin` (never `*`), queueing until pong, ready
  capabilities, source/origin rejection, timeout/recovery, stop semantics,
  unsupported commands, postMessage failures, payload sanitization, and an
  assertion that the library never writes to `console`.

```bash
npm run typecheck -w @agil/calls-embed
npm test -w @agil/calls-embed
npm run build:embed
```

## Limitations

- No programmatic join on the current hosted page (see above).
- `agil:ready` is required for capabilities; a pong-only iframe can accept
  commands but the component won't emit `agil-ready`.
- Cross-origin auto-height depends on the optional `agil:resize` extension.
- The iframe's own outbound messages still use `targetOrigin: '*'` (hosted
  contract, outside this package); this package validates strictly on receipt.
- `allowed-origins` cannot enforce framing; configure server CSP.
- The package is workspace-private, not published or deployed by this change.
- Mobile fullscreen is a CSS dialog sheet, not the native Fullscreen API.
