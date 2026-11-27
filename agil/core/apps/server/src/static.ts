/**
 * Static file serving for the built frontend artifacts.
 *
 * The server hosts everything a demo/e2e/integrator needs from one origin:
 *   `/?room=…`    -> call entry      (legacy room links to embed.html)
 *   `/`           -> optional demo SPA (AGIL_STATIC_DIR, fallback to index.html)
 *   `/editor/`    -> visual editor   (AGIL_EDITOR_DIR)
 *   `/dashboard/` -> developer panel (AGIL_DASHBOARD_DIR)
 *   `/sdk/`       -> agilframe.js and legacy agil-calls.js (AGIL_SDK_DIR)
 *   `/widget/`    -> widget bundle   (AGIL_WIDGET_DIR)
 *
 * Rules: `/v1/*` and `/ws` are never handled here; path traversal is rejected;
 * hashed assets get a long immutable cache, index.html is always revalidated;
 * a missing build answers 503 JSON with a build hint instead of a stack trace.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RequestContext } from './http.js';
import { sendBuffer, sendJson } from './http.js';

export interface Mount {
  /** URL prefix, always with a trailing slash (the demo mount is `/`). */
  prefix: string;
  dir: string;
  /** Human-readable artifact name for 503/404 messages. */
  label: string;
  /** Fall back to `index.html` for extension-less paths (SPA router). */
  spa: boolean;
  /**
   * Restricts the SPA fallback to known page routes. When omitted, every
   * extension-less path under the prefix falls back to the app shell (editor and
   * dashboard SPAs). The demo host page uses an explicit allow-list so typos,
   * `/api/*`, `/mcp` and other unknown paths return JSON 404 instead of HTML.
   */
  spaPaths?: readonly string[];
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

const IMMUTABLE_RE = /[.-][a-f0-9]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|wasm)$/i;
const HAS_EXTENSION_RE = /\.[a-z0-9]{1,12}$/i;

/** Resolves a URL path to a file inside `dir`; null on traversal/unsafe input. */
export function safeJoin(dir: string, relative: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const normalizedRelative = decoded.replace(/\\/g, '/');
  const root = path.resolve(dir);
  const resolved = path.resolve(root, `.${normalizedRelative.startsWith('/') ? '' : '/'}${normalizedRelative}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function cacheControlFor(filePath: string): string {
  const name = path.basename(filePath);
  if (name === 'index.html') return 'no-cache';
  if (IMMUTABLE_RE.test(name)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export interface StaticOptions {
  mounts: Mount[];
}

/** Builds the mount table from resolved env directories. */
export function staticMounts(env: {
  staticDir: string;
  editorDir: string;
  dashboardDir: string;
  sdkDir: string;
  widgetDir: string;
}): Mount[] {
  return [
    { prefix: '/wiki/', dir: path.join(env.staticDir, 'wiki'), label: 'wiki', spa: true, spaPaths: ['/'] },
    { prefix: '/editor/', dir: env.editorDir, label: 'editor', spa: true },
    { prefix: '/dashboard/', dir: env.dashboardDir, label: 'dashboard', spa: true },
    { prefix: '/sdk/', dir: env.sdkDir, label: 'sdk', spa: false },
    { prefix: '/widget/', dir: env.widgetDir, label: 'widget', spa: false },
    {
      prefix: '/',
      dir: env.staticDir,
      label: 'demo',
      spa: true,
      // Only real demo pages may fall back to index.html; everything else
      // (unknown routes, /api/*, /mcp, ...) must answer JSON 404.
      spaPaths: ['/', '/index.html', '/embed.html'],
    },
  ];
}

function readIfFile(filePath: string): Buffer | null {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return null;
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

function notAvailable(ctx: RequestContext, label: string, dir: string, file: string): void {
  sendJson(ctx.res, 503, {
    error: {
      code: 'not_available',
      message: `${label} static build is not available (${path.join(dir, file)}). Run \`npm run build\` first.`,
    },
  });
}

/** Whether the SPA fallback to index.html is allowed for this relative path. */
function spaFallbackAllowed(mount: Mount, relative: string): boolean {
  if (!mount.spaPaths) return true;
  const normalized = relative === '' ? '/' : relative;
  return mount.spaPaths.includes(normalized);
}

function notFound(ctx: RequestContext, relative: string, label: string): void {
  sendJson(ctx.res, 404, {
    error: {
      code: 'not_found',
      message: `${relative.replace(/^\/+/, '') || 'index.html'} not found in ${label} build`,
    },
  });
}

/**
 * Serves one static request. Returns true when the request was handled (the
 * caller answers 404 otherwise). Never throws.
 */
export function serveStatic(ctx: RequestContext, options: StaticOptions): boolean {
  const method = ctx.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;

  let pathname: string;
  try {
    pathname = decodeURIComponent(ctx.path);
  } catch {
    return false;
  }
  pathname = pathname.replace(/\\/g, '/');
  if (pathname.includes('..') || pathname.includes('\0')) {
    sendJson(ctx.res, 400, { error: { code: 'validation_failed', message: 'Invalid path' } });
    return true;
  }

  const mount = options.mounts.find((candidate) =>
    candidate.prefix === '/' ? true : pathname === candidate.prefix.slice(0, -1) || pathname.startsWith(candidate.prefix),
  );
  if (!mount) return false;

  if (mount.prefix === '/' && (pathname === '/' || pathname === '/index.html') && ctx.query.get('room')?.trim()) {
    // The standalone call ships without the optional marketing page.
    ctx.res.statusCode = 302;
    ctx.res.setHeader('location', `/embed.html${ctx.url.search}`);
    ctx.res.setHeader('cache-control', 'no-store');
    ctx.res.setHeader('referrer-policy', 'no-referrer');
    ctx.res.end();
    return true;
  }

  const relative = pathname === '/sdk/agilframe.js' && mount.prefix === '/sdk/'
    ? '/agil-calls.js'
    : mount.prefix === '/' ? pathname : pathname.slice(mount.prefix.length - 1);
  const root = path.resolve(mount.dir);
  const indexPath = path.join(root, 'index.html');

  // Directory-ish request: append index.html only for allowed app-shell routes.
  const isDirectoryish = relative === '' || relative === '/' || relative.endsWith('/');
  const shellAllowed = spaFallbackAllowed(mount, relative);
  const candidatePath = isDirectoryish && shellAllowed
    ? indexPath
    : safeJoin(root, relative.startsWith('/') ? relative : `/${relative}`);
  if (!candidatePath) {
    sendJson(ctx.res, 400, { error: { code: 'validation_failed', message: 'Invalid path' } });
    return true;
  }

  let filePath = candidatePath;
  let data = readIfFile(filePath);

  // SPA fallback: only known app-shell routes (e.g. `/editor/foo`).
  // Unknown extension-less paths (`/nonexistent`, `/mcp`, `/api/*`) fall through
  // to a JSON 404 instead of serving demo HTML.
  const baseNameForFallback = path.basename(relative);
  if (
    !data &&
    mount.spa &&
    spaFallbackAllowed(mount, relative) &&
    (!HAS_EXTENSION_RE.test(baseNameForFallback) || isDirectoryish || baseNameForFallback.toLowerCase().endsWith('.html'))
  ) {
    filePath = indexPath;
    data = readIfFile(filePath);
  }

  if (!data) {
    const baseName = path.basename(relative);
    const wantsShell =
      spaFallbackAllowed(mount, relative) &&
      (isDirectoryish ||
        !HAS_EXTENSION_RE.test(baseName) ||
        baseName.toLowerCase().endsWith('.html'));
    if (!existsSync(mount.dir) && wantsShell) {
      notAvailable(ctx, mount.label, mount.dir, 'index.html');
      return true;
    }
    if (mount.prefix !== '/' && pathname === mount.prefix.slice(0, -1)) {
      // `/editor` -> redirect to the mounted base so relative asset URLs work.
      ctx.res.statusCode = 308;
      ctx.res.setHeader('location', mount.prefix);
      ctx.res.end();
      return true;
    }
    notFound(ctx, relative, mount.label);
    return true;
  }

  const headers: Record<string, string> = {
    'content-type': contentTypeFor(filePath),
    'cache-control': cacheControlFor(filePath),
    'x-content-type-options': 'nosniff',
  };
  if (method === 'HEAD') {
    ctx.res.statusCode = 200;
    for (const [key, value] of Object.entries(headers)) ctx.res.setHeader(key, value);
    ctx.res.setHeader('content-length', String(data.length));
    ctx.res.end();
    return true;
  }
  sendBuffer(ctx.res, 200, data, headers);
  return true;
}
