/** Demo session broker. MediaMTX control API and this process run on a private network. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createReplayCatalog, readSmallJson } from './broadcast-state.mjs';
import { chatSource, openBroadcastChat } from './broadcast-chat.mjs';
import { createChatCaptcha } from './chat-captcha.mjs';
import { createChatIdentities } from './chat-moderation.mjs';

const env = process.env;
const site = new URL(env.AGIL_OBS_SITE_ORIGIN);
const publicUrl = new URL(env.AGIL_OBS_PUBLIC_URL);
const ingest = new URL(env.AGIL_OBS_INGEST_URL);
const control = new URL(env.AGIL_OBS_MTX_CONTROL_URL);
const hls = new URL(env.AGIL_OBS_MTX_HLS_URL);
const webrtc = env.AGIL_OBS_MTX_WEBRTC_URL ? new URL(env.AGIL_OBS_MTX_WEBRTC_URL) : undefined;
const playback = env.AGIL_OBS_MTX_PLAYBACK_URL ? new URL(env.AGIL_OBS_MTX_PLAYBACK_URL) : undefined;
const catalog = await createReplayCatalog(env.AGIL_OBS_REPLAY_DIR);
if (Boolean(playback) !== Boolean(catalog)) throw new Error('Set both OBS playback origin and replay directory');
const organizerKey = env.AGIL_OBS_ORGANIZER_KEY;
const callbackKey = env.AGIL_OBS_CALLBACK_KEY;
const local = ['localhost', '127.0.0.1', '[::1]'];
const relayKey = env.AGIL_OBS_RELAY_KEY;
function edgeOrigin(entry) {
  const edge = new URL(entry);
  if (edge.username || edge.password || edge.pathname !== '/' || edge.search || edge.hash ||
      !(edge.protocol === 'https:' || (edge.protocol === 'http:' && local.includes(edge.hostname)))) throw new Error('Invalid OBS viewer node URL');
  return edge.origin;
}
const routingPolicy = env.AGIL_OBS_EDGE_ROUTING || 'balanced';
if (!['latency', 'load', 'balanced'].includes(routingPolicy)) throw new Error('Invalid OBS viewer routing policy');
const edges = JSON.parse(env.AGIL_OBS_EDGES || '[]').map(({ hls, realtime, control, hlsCapacity, realtimeCapacity }) => {
  if (!control && hlsCapacity === undefined && realtimeCapacity === undefined) return { hls: edgeOrigin(hls), realtime: edgeOrigin(realtime) };
  const url = new URL(control);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      ![hlsCapacity, realtimeCapacity].every((capacity) => Number.isSafeInteger(capacity) && capacity > 0)) {
    throw new Error('Set a private OBS node Control API origin and positive session capacities');
  }
  return { hls: edgeOrigin(hls), realtime: edgeOrigin(realtime), control: url.origin, hlsCapacity, realtimeCapacity };
});
if (!(publicUrl.protocol === 'https:' && ingest.protocol === 'rtmps:') &&
    !(publicUrl.protocol === 'http:' && ingest.protocol === 'rtmp:' && local.includes(publicUrl.hostname) && local.includes(ingest.hostname))) {
  throw new Error('Use HTTPS and RTMPS for a deployed OBS demo');
}
if ([publicUrl, ingest].some((url) => url.username || url.password || url.search || url.hash) ||
    ingest.pathname.replace(/\/$/, '') !== '/obs') throw new Error('Use an ingest address ending in /obs');
if (!organizerKey || organizerKey.length < 24 || !/^[\w-]{24,}$/.test(callbackKey ?? '')) {
  throw new Error('Set independent organizer and callback keys of at least 24 characters');
}
if (edges.length && (!relayKey || !/^[\w-]{24,}$/.test(relayKey))) throw new Error('Set an independent relay key for viewer nodes');
const port = Number(env.AGIL_OBS_PORT || 8898);
const ttlMs = Number(env.AGIL_OBS_TTL_MS || 30 * 60000);
const limit = Number(env.AGIL_OBS_MAX_SESSIONS || 3);
if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
  throw new Error('Invalid OBS demo session limits');
}

function chatSetting(key, fallback, maximum) {
  const value = Number(env[key] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${key}`);
  return value;
}
const chatProxies = new Set((env.AGIL_OBS_CHAT_TRUSTED_PROXIES || '').split(',').map((value) => value.trim()).filter(Boolean));
if ([...chatProxies].some((address) => !isIP(address))) throw new Error('Invalid OBS chat trusted proxy address');
const chatStore = openBroadcastChat({
  filename: env.AGIL_OBS_CHAT_FILE,
  limit: chatSetting('AGIL_OBS_CHAT_LIMIT', 100_000, 1_000_000),
  sourcePerMinute: chatSetting('AGIL_OBS_CHAT_SOURCE_PER_MINUTE', 12, 120),
  streamPerSecond: chatSetting('AGIL_OBS_CHAT_STREAM_PER_SECOND', 100, 1000),
});
const chatCaptcha = createChatCaptcha({
  siteKey: env.AGIL_OBS_TURNSTILE_SITE_KEY?.trim(), secret: env.AGIL_OBS_TURNSTILE_SECRET_KEY?.trim(),
  hostnames: new Set([site.hostname]),
});
const chatIdentities = createChatIdentities();

const hash = (value) => createHash('sha256').update(value).digest();
const accepts = (expected, value) => typeof value === 'string' && timingSafeEqual(expected, hash(value));
const bearer = (request) => /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
const organizerHash = hash(organizerKey);
const relayHash = relayKey ? hash(relayKey) : undefined;
const sessions = new Map();
const pathName = (id) => `obs/${id}`;
let pending = 0;
let replayStreams = 0;
const loadSamples = new Map();

function edgeLoad(node) {
  const edge = edges[node];
  if (!edge.control) return undefined;
  const sample = loadSamples.get(node);
  if (sample && sample.until > Date.now()) return sample.value;
  async function count(protocol) {
    const url = new URL(`/v3/${protocol}/sessions/list?itemsPerPage=1`, edge.control);
    const response = await fetch(url, { signal: AbortSignal.timeout(700), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Could not read OBS viewer sessions');
    }
    const { itemCount } = await response.json();
    if (!Number.isSafeInteger(itemCount) || itemCount < 0) throw new Error('Invalid OBS viewer session count');
    return itemCount;
  }
  const value = Promise.all([count('hls'), count('webrtc')]).then(([hls, realtime]) =>
    Math.round(100 * (hls / edge.hlsCapacity + realtime / edge.realtimeCapacity)) / 100,
  ).catch(() => undefined);
  loadSamples.set(node, { until: Date.now() + 3000, value });
  return value;
}

async function media(method, operation, id, body) {
  const response = await fetch(new URL(`/v3/${operation}${id ? `/${pathName(id)}` : ''}`, control), {
    method, signal: AbortSignal.timeout(4000), redirect: 'error',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Media control returned ${response.status}`);
  if (method === 'GET') return response.json();
  await response.body?.cancel();
  return true;
}

async function stop(session) {
  session.ended = true;
  session.removing ??= removeMediaPath(session.id).then(() => {
    if (session.chat) {
      if (session.recorded) chatStore.forgetAuthors(session.id);
      else chatStore.discard(session.id);
    }
    sessions.delete(session.id);
  }).finally(() => { session.removing = undefined; });
  await session.removing;
}

async function removeMediaPath(id) {
  const status = await media('GET', 'paths/get', id);
  const source = status?.source;
  const protocol = source?.type === 'webRTCSession' ? 'webrtc/sessions' :
    ['rtmpConn', 'rtmpsConn'].includes(source?.type) ? 'rtmp/conns' : undefined;
  if (protocol && typeof source.id === 'string' && /^[a-f0-9-]{36}$/i.test(source.id)) {
    const response = await fetch(new URL(`/v3/${protocol}/kick/${source.id}`, control), {
      method: 'POST', signal: AbortSignal.timeout(4000), redirect: 'error',
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw new Error('Media publisher could not be stopped');
  }
  await media('DELETE', 'config/paths/delete', id);
}

function reply(response, status, body) {
  if (body !== undefined) response.setHeader('content-type', 'application/json; charset=utf-8');
  response.writeHead(status).end(body === undefined ? undefined : JSON.stringify(body));
}

async function replayParts(id) {
  const url = new URL('/list', playback);
  url.searchParams.set('path', pathName(id));
  const result = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!result.ok) {
    await result.body?.cancel();
    if (result.status === 404) return [];
    throw new Error('Media playback metadata unavailable');
  }
  const list = await result.json();
  if (!Array.isArray(list)) throw new Error('Invalid media playback metadata');
  return list.filter((span) => typeof span?.start === 'string' && Number.isFinite(Date.parse(span.start)) &&
    Number.isFinite(span.duration) && span.duration > 0).slice(0, 120).map(({ start, duration }) => ({ start, duration: Math.min(duration, ttlMs / 1000) }));
}

async function serveReplay(request, response, id, part) {
  const stored = await catalog?.read(id);
  if (!stored) return reply(response, 404);
  const current = sessions.get(id);
  if (current) {
    if (!current.ended || part !== undefined) return reply(response, 404);
    return reply(response, 200, { title: stored.title, replayUntil: stored.replayUntil, parts: [] });
  }
  const parts = await replayParts(id);
  if (part === undefined) return reply(response, 200, { title: stored.title, replayUntil: stored.replayUntil,
    parts: parts.map(({ start, duration }, index) => ({ start, duration, url: new URL(`/obs-demo/replays/${id}/${index}`, publicUrl).href })) });
  const span = parts[Number(part)];
  if (!span) return reply(response, 404);
  const upstreamUrl = new URL('/get', playback);
  upstreamUrl.search = new URLSearchParams({ path: pathName(id), start: span.start, duration: String(span.duration), format: 'fmp4' });
  if (replayStreams >= 8) return reply(response, 429);
  replayStreams += 1;
  const stop = new AbortController();
  response.once('close', () => stop.abort());
  try {
    const upstream = await fetch(upstreamUrl, { redirect: 'error', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(120000)]),
      ...(request.headers.range && { headers: { range: request.headers.range } }) });
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'content-type']) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response.writeHead(upstream.status);
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } finally { replayStreams -= 1; }
}

async function serveChat(request, response, id, session, messageId, url, target) {
  const cursor = url.searchParams.get('before');
  const before = cursor === null ? undefined : Number(cursor);
  if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(before) || before < 1)) return reply(response, 400);
  if (url.searchParams.get('archive') === '1') {
    if (request.method !== 'GET' || messageId !== undefined) return reply(response, 405);
    if ((session && !session.ended && session.expiresAt > Date.now()) || !chatStore.exists(id) || !await catalog?.read(id)) {
      return reply(response, 404);
    }
    return reply(response, 200, chatStore.list(id, before));
  }
  if (!session?.chat || session.ended || session.expiresAt <= Date.now()) return reply(response, 404);
  if (messageId === 'blocked') {
    if (request.method !== 'GET') return reply(response, 405);
    if (!accepts(session.manageHash, bearer(request))) return reply(response, 401);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 40_000) return reply(response, 400);
    return reply(response, 200, session.chat.blocked(offset));
  }
  if (messageId === 'policy' || messageId === 'ban' || messageId === 'bans') {
    if (!accepts(session.manageHash, bearer(request))) return reply(response, 401);
    if (messageId === 'policy' && request.method === 'GET') return reply(response, 200, session.chat.policy());
    if (messageId === 'policy' && request.method === 'PUT') {
      const input = await readSmallJson(request, 32_768);
      if (input.status) return reply(response, input.status);
      if (session.ended || session.expiresAt <= Date.now()) return reply(response, 404);
      if (!session.chat.updatePolicy(input.value)) return reply(response, 400, { error: 'invalid_chat_policy' });
      return reply(response, 200, session.chat.policy());
    }
    if (messageId === 'ban' && request.method === 'POST' && /^\d{1,15}$/.test(target ?? '')) {
      return reply(response, session.chat.ban(Number(target), session.expiresAt) ? 204 : 404);
    }
    if (messageId === 'bans' && request.method === 'DELETE' && /^[\w-]{22}$/.test(target ?? '')) {
      return reply(response, session.chat.unban(target) ? 204 : 404);
    }
    return reply(response, 405);
  }
  if (request.method === 'POST' && (messageId === undefined || messageId === 'identity')) {
    const address = chatSource(request, chatProxies);
    const retry = session.chat.networkRetry(address);
    if (retry) {
      response.setHeader('retry-after', String(retry));
      return reply(response, 429, { error: 'chat_busy' });
    }
    if (messageId === 'identity') return reply(response, 201, { credential: chatIdentities.issue(id), expiresAt: session.expiresAt });
  }
  if (request.method === 'GET' && messageId === undefined) {
    const { etag, ...page } = session.chat.list(before);
    if (etag) {
      response.setHeader('etag', etag);
      if (request.headers['if-none-match'] === etag) return reply(response, 304);
    }
    return reply(response, 200, { ...page, ...(chatCaptcha && { captcha: chatCaptcha.settings }) });
  }
  if (request.method === 'POST' && messageId === undefined) {
    const input = await readSmallJson(request);
    if (input.status) return reply(response, input.status);
    if (session.ended || session.expiresAt <= Date.now()) return reply(response, 404);
    const sourceId = chatIdentities.viewer(id, input.value?.credential);
    if (!sourceId) return reply(response, 403, { error: 'chat_identity_required' });
    const attempt = session.chat.admit(sourceId, chatSource(request, chatProxies));
    if (attempt.banned) return reply(response, 403, { error: 'viewer_banned' });
    if (attempt.retry) {
      response.setHeader('retry-after', String(attempt.retry));
      return reply(response, 429, { error: attempt.blocked ? 'source_blocked' : 'comment_rate_limited' });
    }
    const binding = [id, sourceId];
    let chatPass;
    if (chatCaptcha && !chatCaptcha.accepts(input.value?.chatPass, binding)) {
      const result = await chatCaptcha.verify(input.value?.turnstileToken, binding);
      if (session.ended || session.expiresAt <= Date.now()) return reply(response, 404);
      if (result.status === 'unavailable') return reply(response, 503, { error: 'captcha_unavailable' });
      if (result.status === 'required') return reply(response, 403, { error: 'captcha_required', captcha: chatCaptcha.settings });
      if (result.status === 'invalid') {
        session.chat.rejectCaptcha(attempt.source, input.value?.name);
        return reply(response, 403, { error: 'captcha_invalid', captcha: chatCaptcha.settings });
      }
      chatPass = result.pass;
    }
    if (attempt.source.blockedUntil > Date.now()) {
      response.setHeader('retry-after', String(Math.ceil((attempt.source.blockedUntil - Date.now()) / 1000)));
      return reply(response, 429, { error: 'source_blocked' });
    }
    const { status, body, retry } = session.chat.post(input.value, attempt.source);
    if (retry) response.setHeader('retry-after', String(retry));
    const pass = status !== 403 && chatPass;
    return reply(response, status, pass ? { ...body, chatPass: pass } : body);
  }
  if (request.method === 'DELETE' && messageId !== undefined) {
    if (!accepts(session.manageHash, bearer(request))) return reply(response, 401);
    return reply(response, session.chat.remove(Number(messageId)) ? 204 : 404);
  }
  return reply(response, 405);
}

async function callback(request, response) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) return reply(response, 413);
  }
  let event;
  try { event = JSON.parse(body); } catch { return reply(response, 400); }
  const match = /^obs\/([\w-]{22})$/.exec(event?.path ?? '');
  const session = match && sessions.get(match[1]);
  if (!session || session.ended || session.expiresAt <= Date.now()) return reply(response, 403);
  const publish = event.action === 'publish' && event.protocol === (session.mode === 'realtime' ? 'webrtc' : 'rtmp') &&
    accepts(session.publishHash, event.token || new URLSearchParams(event.query).get('token'));
  const view = event.action === 'read' && event.protocol === (session.mode === 'realtime' ? 'webrtc' : 'hls');
  const relay = relayHash && event.action === 'read' && event.protocol === 'rtsp' &&
    event.user === 'relay' && accepts(relayHash, event.password);
  reply(response, publish || view || relay ? 204 : 403);
}

async function rtc(request, response, url, session, operation, resource) {
  if (!webrtc || session.mode !== 'realtime') return reply(response, 404);
  const method = request.method;
  if (operation === 'whip' && method !== 'OPTIONS' && !accepts(session.publishHash, bearer(request))) return reply(response, 401);
  if (!(resource ? ['PATCH', 'DELETE'].includes(method) : ['OPTIONS', 'POST'].includes(method))) return reply(response, 405);
  const target = new URL(`/${pathName(session.id)}/${operation}${resource ? `/${resource}` : ''}`, webrtc);
  const headers = {};
  for (const name of ['authorization', 'content-type', 'if-match']) {
    if (request.headers[name]) headers[name] = request.headers[name];
  }
  let body;
  if (method === 'POST' || method === 'PATCH') {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) return reply(response, 413);
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  const upstream = await fetch(target, { method, body, headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  for (const name of ['content-type', 'link', 'etag', 'accept-patch', 'accept-post']) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
  const location = upstream.headers.get('location');
  if (location) {
    const id = new URL(location, target).pathname.split('/').at(-1);
    if (!/^[\w-]{16,64}$/.test(id)) throw new Error('Invalid WebRTC session response');
    response.setHeader('location', `${url.pathname}/${id}`);
  }
  response.writeHead(upstream.status);
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
  else response.end();
}

async function serve(request, response) {
  const url = new URL(request.url, publicUrl);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  if (request.method === 'POST' && url.pathname === `/internal/media-auth/${callbackKey}`) return callback(request, response);
  if (!url.pathname.startsWith('/obs-demo/')) return reply(response, 404);
  const origin = request.headers.origin;
  if (origin && origin !== site.origin && origin !== publicUrl.origin) return reply(response, 403);
  if (origin) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-expose-headers', 'Location, Link, ETag, Retry-After, Accept-Patch, Accept-Post');
    response.setHeader('vary', 'Origin');
  }
  const signalRoute = /^\/obs-demo\/rtc\/([\w-]{22})\/(whip|whep)(?:\/([\w-]{16,64}))?$/.exec(url.pathname);
  if (request.method === 'OPTIONS') {
    response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.setHeader('access-control-allow-headers', 'Authorization, Content-Type, If-Match, If-None-Match');
    response.setHeader('access-control-max-age', '600');
    if (!signalRoute || request.headers['access-control-request-method']) return reply(response, 204);
  }
  const replay = /^\/obs-demo\/replays\/([\w-]{22})(?:\/(\d{1,3}))?$/.exec(url.pathname);
  if (replay && request.method === 'GET') return serveReplay(request, response, replay[1], replay[2]);
  const chat = /^\/obs-demo\/sessions\/([\w-]{22})\/chat(?:\/(blocked|identity|policy|ban|bans|\d{1,15})(?:\/([\w-]{1,22}))?)?$/.exec(url.pathname);
  if (chat) {
    if (chat[3] && chat[2] !== 'ban' && chat[2] !== 'bans') return reply(response, 404);
    return serveChat(request, response, chat[1], sessions.get(chat[1]), chat[2], url, chat[3]);
  }
  if (url.pathname === '/obs-demo/broadcasts' && request.method === 'GET') {
    return reply(response, 200, { broadcasts: [...sessions.values()].filter(({ listed, ended, expiresAt }) =>
      listed && !ended && expiresAt > Date.now()).map(({ id, title, mode, expiresAt }) => ({ id, title, mode, expiresAt })) });
  }
  if (url.pathname === '/obs-demo/sessions' && request.method === 'POST') {
    if (!accepts(organizerHash, bearer(request))) return reply(response, 401);
    const mode = url.searchParams.get('mode') ?? 'hls';
    if (mode !== 'hls' && mode !== 'realtime') return reply(response, 400);
    if (mode === 'realtime' && !webrtc) return reply(response, 503);
    const listed = url.searchParams.get('public') === '1';
    const chatEnabled = listed || url.searchParams.get('chat') === '1';
    const recorded = url.searchParams.get('replay') === '1';
    if (recorded && (!catalog || mode !== 'hls')) return reply(response, 409, { error: 'replay_unavailable' });
    const title = (url.searchParams.get('title') ?? '').trim() || 'Эфир OBS Studio';
    if (title.length > 100 || /[\u0000-\u001f\u007f]/u.test(title)) return reply(response, 400);
    if (sessions.size + pending >= limit) return reply(response, 429);
    const id = randomBytes(16).toString('base64url');
    const publish = randomBytes(24).toString('base64url');
    const manage = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    pending += 1;
    try {
      const added = await media('POST', 'config/paths/add', id, { source: 'publisher', overridePublisher: false, ...(recorded && { record: true }) });
      if (!added) throw new Error('Media control route is unavailable');
      if (recorded) {
        try { await catalog.remember({ id, title, listed, expiresAt }); }
        catch (error) { await media('DELETE', 'config/paths/delete', id).catch(() => {}); throw error; }
      }
      let chat;
      try { if (chatEnabled) chat = chatStore.create(id, expiresAt + (recorded ? 86_400_000 : 0)); }
      catch (error) { await removeMediaPath(id).catch(() => {}); throw error; }
      sessions.set(id, { id, mode, title, listed, recorded, expiresAt, publishHash: hash(publish), manageHash: hash(manage),
        ...(chat && { chat }) });
    } finally { pending -= 1; }
    const settings = mode === 'realtime'
      ? { obsServer: new URL(`/obs-demo/rtc/${id}/whip`, publicUrl).href, obsKey: publish }
      : { obsServer: ingest.href.replace(/\/$/, ''), obsKey: `${id}?token=${publish}`, hlsUrl: new URL(`/obs-demo/hls/${id}/index.m3u8`, publicUrl).href };
    return reply(response, 201, { id, mode, expiresAt, manageToken: manage, ...settings });
  }
  const action = /^\/obs-demo\/sessions\/([\w-]{22})$/.exec(url.pathname);
  const stream = /^\/obs-demo\/hls\/([\w-]{22})\/([\w.-]+)$/.exec(url.pathname);
  const id = action?.[1] ?? stream?.[1] ?? signalRoute?.[1];
  const session = id && sessions.get(id);
  if (!session || session.ended || session.expiresAt <= Date.now()) return reply(response, 404);
  if (signalRoute) return rtc(request, response, url, session, signalRoute[2], signalRoute[3]);
  if (action && request.method === 'DELETE') {
    if (!accepts(session.manageHash, bearer(request))) return reply(response, 401);
    await stop(session);
    return reply(response, 204);
  }
  if (action && request.method === 'GET') {
    const state = await media('GET', 'paths/get', id);
    const live = state?.available === true || state?.ready === true;
    const data = { live, mode: session.mode, expiresAt: session.expiresAt, title: session.title,
      chat: Boolean(session.chat), recorded: session.recorded };
    const viewer = url.searchParams.get('viewer');
    if (edges.length && /^[\w-]{8,64}$/.test(viewer ?? '')) {
      const excluded = new Set((url.searchParams.get('exclude') ?? '').split(',').filter((value) => /^\d{1,6}$/.test(value)).map(Number));
      const first = hash(`${id}/${viewer}`).readUInt32BE(0) % edges.length;
      const candidates = [];
      const probe = live && url.searchParams.get('select') === '1';
      for (let offset = 0; offset < edges.length && candidates.length < (probe ? 3 : 1); offset += 1) {
        const node = (first + offset) % edges.length;
        if (excluded.has(node)) continue;
        const playbackUrl = new URL(`/${pathName(id)}/${session.mode === 'realtime' ? 'whep' : 'index.m3u8'}`, edges[node][session.mode]).href;
        candidates.push({ node, playbackUrl });
      }
      Object.assign(data, candidates[0]);
      if (probe && candidates.length > 1) {
        data.routingPolicy = routingPolicy;
        data.candidates = routingPolicy === 'latency' ? candidates : await Promise.all(candidates.map(async (candidate) => {
          const load = await edgeLoad(candidate.node);
          return load === undefined ? candidate : { ...candidate, load };
        }));
      }
      data.noPlaybackNode = data.node === undefined;
    }
    if (accepts(session.manageHash, bearer(request))) {
      if (live) {
        const bytes = state.inboundBytes ?? state.bytesReceived ?? 0;
        const now = Date.now();
        const prior = session.sample;
        const elapsed = prior && now - prior.at;
        const kbps = elapsed >= 500 && bytes >= prior.bytes ? Math.round((bytes - prior.bytes) * 8 / elapsed) : null;
        if (!prior || elapsed >= 500) session.sample = { bytes, at: now };
        const tracks = (state.tracks2 ?? []).map(({ codec, codecProps }) => ({ codec,
          ...(Number.isFinite(codecProps?.width) && Number.isFinite(codecProps?.height) ? { width: codecProps.width, height: codecProps.height } : {}),
        }));
        data.metrics = { tracks, kbps };
      } else session.sample = undefined;
    }
    return reply(response, 200, data);
  }
  if (stream && session.mode === 'hls' && request.method === 'GET' && /\.(m3u8|m4s|mp4|ts)$/.test(stream[2])) {
    const target = new URL(`/${pathName(id)}/${stream[2]}`, hls);
    target.search = url.search;
    // MediaMTX can put the HLS session in playlist URLs when cookies are unavailable.
    if (stream[2] === 'index.m3u8') target.searchParams.set('cookieCheck', '1');
    const signal = AbortSignal.timeout(25000);
    const upstream = await fetch(target, { signal, redirect: 'error' });
    if (session.ended || session.expiresAt <= Date.now()) {
      await upstream.body?.cancel();
      return reply(response, 404);
    }
    const type = upstream.headers.get('content-type');
    if (type) response.setHeader('content-type', type);
    response.writeHead(upstream.status);
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
    return;
  }
  reply(response, 404);
}

let startup;
const startupDeadline = Date.now() + 15_000;
for (;;) {
  try {
    startup = await media('GET', 'config/paths/list');
    break;
  } catch (error) {
    if (Date.now() >= startupDeadline) throw new Error('MediaMTX control API did not become ready', { cause: error });
    await delay(250);
  }
}
if (!startup?.items) throw new Error('MediaMTX control API is unavailable');
chatStore.sweep();
const orphaned = startup.items.map(({ name }) => /^obs\/([\w-]{22})$/.exec(name)?.[1]).filter(Boolean);
await Promise.all(orphaned.map(removeMediaPath));

const timer = setInterval(() => {
  for (const session of sessions.values()) {
    if (session.ended || session.expiresAt <= Date.now()) void stop(session).catch(() => {});
  }
}, 1000);
timer.unref();
if (catalog) setInterval(() => void catalog.sweep().catch(() => {}), 3600000).unref();
setInterval(() => {
  try { chatStore.sweep(); }
  catch { console.warn('OBS chat cleanup failed'); }
}, 60_000).unref();
const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (request, response) => {
  void serve(request, response).catch((error) => {
    if (!response.headersSent) console.warn('OBS demo upstream request failed:', error.name, error.cause?.code ?? '');
    if (!response.headersSent) reply(response, 503, { error: 'media_unavailable' });
    else response.destroy();
  });
});
server.listen(port, env.AGIL_OBS_HOST || '127.0.0.1', () => console.log(`OBS demo broker listening on ${server.address().port}`));
