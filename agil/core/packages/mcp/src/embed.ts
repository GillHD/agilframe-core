/**
 * Embed snippet generator for `agil_get_embed_snippet`.
 *
 * Produces copy-pasteable HTML for both integration modes from contract §8:
 *  - SDK mode: `AgilFrame.mount('#agil-call', {...})` (bundled widget);
 *  - iframe mode: `<iframe src="/embed.html?...">` (zero-JS parent page).
 *
 * All values that land in HTML/JS are escaped: `room`/`token` may come from an
 * untrusted client and must never break out of the snippet.
 */
import { ToolError } from './tool-kit.js';

export interface EmbedSnippetOptions {
  room: string;
  token?: string;
  serverUrl?: string;
  tenantId?: string;
  participantName?: string;
  role?: 'host' | 'moderator' | 'guest';
  locale?: 'ru' | 'en';
  /** Full ThemeTokens or a ThemePatch; passed as `theme` to the widget. */
  theme?: unknown;
  /** Feature overrides applied locally (not saved to the tenant). */
  features?: Record<string, boolean>;
  /** Minimal layout overrides passed through `config.layout` (contract §22). */
  layout?: EmbedLayoutOverrides;
  /** Which snippet is returned as the primary `snippet` field. */
  mode?: 'sdk' | 'iframe';
}

/** Layout overrides supported by the embed snippet (contract §22). */
export interface EmbedLayoutOverrides {
  chrome?: 'full' | 'compact' | 'none';
  minimized?: {
    enabled?: boolean;
    mode?: 'bar' | 'bubble';
    position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
    showSelfView?: boolean;
    keepControls?: boolean;
  };
  persistAcrossPages?: boolean;
  inheritHostStyles?: boolean;
}

export interface EmbedSnippetResult {
  mode: 'sdk' | 'iframe';
  snippet: string;
  sdkHtml: string;
  iframeHtml: string;
  iframeUrl: string;
  js: string;
  layout?: EmbedLayoutOverrides;
  notes: string[];
}

const SERVER_URL_RE = /^https?:\/\/[^\s"'<>]+$/;

export function assertServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!SERVER_URL_RE.test(trimmed)) {
    throw new ToolError(
      `Invalid serverUrl "${value}".`,
      'Expected an http(s) origin such as "http://localhost:8787" or "https://calls.example.com".',
    );
  }
  return trimmed;
}

/** HTML-escapes text for attribute and text-node contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON that is safe to inline inside a <script> element. */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildMountOptions(options: EmbedSnippetOptions, serverUrl: string): Record<string, unknown> {
  const mountOptions: Record<string, unknown> = {
    room: options.room,
    serverUrl,
  };
  if (options.token) mountOptions.token = options.token;
  if (options.tenantId) mountOptions.tenantId = options.tenantId;
  if (options.participantName) mountOptions.participantName = options.participantName;
  if (options.role) mountOptions.role = options.role;
  if (options.locale) mountOptions.locale = options.locale;
  if (options.theme !== undefined) mountOptions.theme = options.theme;
  const config: Record<string, unknown> = {};
  if (options.features && Object.keys(options.features).length > 0) config.features = options.features;
  const layout = normalizeLayout(options.layout);
  if (layout) config.layout = layout;
  if (Object.keys(config).length > 0) mountOptions.config = config;
  return mountOptions;
}

/** Drops undefined values and returns undefined when nothing is configured. */
function normalizeLayout(layout: EmbedLayoutOverrides | undefined): Record<string, unknown> | undefined {
  if (!layout) return undefined;
  const out: Record<string, unknown> = {};
  if (layout.chrome) out.chrome = layout.chrome;
  if (layout.minimized) {
    const minimized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(layout.minimized)) {
      if (value !== undefined) minimized[key] = value;
    }
    if (Object.keys(minimized).length > 0) out.minimized = minimized;
  }
  if (layout.persistAcrossPages !== undefined) out.persistAcrossPages = layout.persistAcrossPages;
  if (layout.inheritHostStyles !== undefined) out.inheritHostStyles = layout.inheritHostStyles;
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildIframeUrl(options: EmbedSnippetOptions, serverUrl: string): string {
  const params = new URLSearchParams();
  params.set('room', options.room);
  if (options.token) params.set('token', options.token);
  if (options.tenantId) params.set('tenant', options.tenantId);
  if (options.participantName) params.set('name', options.participantName);
  if (options.role) params.set('role', options.role);
  if (options.locale) params.set('lang', options.locale);
  const scheme = readThemeScheme(options.theme);
  if (scheme) params.set('theme', scheme);
  return `${serverUrl}/embed.html?${params.toString()}`;
}

function readThemeScheme(theme: unknown): string | undefined {
  if (typeof theme !== 'object' || theme === null) return undefined;
  const scheme = (theme as { scheme?: unknown }).scheme;
  return typeof scheme === 'string' && ['light', 'dark', 'auto'].includes(scheme) ? scheme : undefined;
}

export function buildEmbedSnippet(options: EmbedSnippetOptions, defaultServerUrl: string): EmbedSnippetResult {
  const serverUrl = assertServerUrl(options.serverUrl ?? defaultServerUrl);
  if (!options.room.trim()) {
    throw new ToolError('`room` must not be empty.', 'Pass the room id/slug, e.g. "team-sync".');
  }
  const mountOptions = buildMountOptions(options, serverUrl);
  const layout = normalizeLayout(options.layout) as EmbedLayoutOverrides | undefined;
  const resumeLine =
    options.layout?.persistAcrossPages === true
      ? `\n// On the following page (after navigating): AgilFrame.resume() — restores the call from sessionStorage.`
      : '';
  const js =
    `AgilFrame.mount('#agil-call', ${safeJsonForScript(mountOptions)})\n` +
    `  .then((call) => { window.agilCall = call; })\n` +
    `  .catch((error) => { console.error('AgilFrame failed to start', error); });` +
    resumeLine;
  const sdkHtml = [
    '<!-- AgilFrame: SDK mode (bundles the widget) -->',
    `<script src="${escapeHtml(serverUrl)}/sdk/agilframe.js"></script>`,
    '<div id="agil-call" style="height: 640px; width: 100%"></div>',
    '<script>',
    js,
    '</script>',
  ].join('\n');

  const iframeUrl = buildIframeUrl(options, serverUrl);
  const iframeHtml = [
    '<!-- AgilFrame: iframe mode (no JS on the parent page) -->',
    `<iframe src="${escapeHtml(iframeUrl)}"`,
    '        allow="camera; microphone; display-capture; fullscreen; clipboard-write"',
    '        style="width: 100%; height: 640px; border: 0"',
    '        title="AgilFrame"></iframe>',
  ].join('\n');

  const mode = options.mode ?? 'sdk';
  const notes = [
    mode === 'sdk'
      ? 'SDK mode: load /sdk/agilframe.js, then mount into any container. The widget reads the tenant config from the server.'
      : 'iframe mode: the parent page needs no JS; theme follows the `theme` query param, full config is fetched by the iframe.',
    'Never hard-code production tokens in public HTML: mint a short-lived token server-side (agil_create_token) and inject it per participant.',
    'To preview without a server, run the demo (npm run dev) and open the same URL with ?room=demo.',
  ];
  if (options.token) {
    notes.push('A token is embedded in the snippet below — it is a short-lived join token, keep it out of logs.');
  }
  if (layout) {
    notes.push(
      `Layout overrides are passed as \`config.layout\` (contract §22): chrome="${layout.chrome ?? 'full'}". ` +
        'chrome="none" renders only the video grid and controls — the widget becomes part of the company page.',
    );
  }
  if (layout?.chrome === 'none') {
    notes.push('chrome="none": the host page owns the header/background; embed the container into your page layout instead of a modal.');
  }
  if (layout?.minimized) {
    notes.push(
      'minimized: the call keeps running in a floating bar/bubble while the user navigates the company app; ' +
        'on Chromium the widget can also request Document Picture-in-Picture (requestPictureInPicture()).',
    );
  }
  if (layout?.persistAcrossPages) {
    notes.push(
      'persistAcrossPages: after a full page navigation call AgilFrame.resume() (or mount({resume:true})) — ' +
        'sessionStorage keeps {room, token, tenant, name, theme} and the call is restored.',
    );
  }
  if (layout?.inheritHostStyles) {
    notes.push('inheritHostStyles: tokens that are not set explicitly fall back to the host page fonts/colors.');
  }
  return {
    mode,
    snippet: mode === 'sdk' ? sdkHtml : iframeHtml,
    sdkHtml,
    iframeHtml,
    iframeUrl,
    js,
    ...(layout ? { layout } : {}),
    notes,
  };
}
