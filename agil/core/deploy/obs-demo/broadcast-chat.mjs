import { closeSync, mkdirSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatPolicy } from './chat-moderation.mjs';

const MAX_SOURCES = 20_000;
const STRIKE_WINDOW_MS = 60_000;
const BLOCK_MS = 5 * 60_000;

function strike(source, now, reason) {
  if (source.blockedUntil > now) return;
  if (now - source.strikeStart >= STRIKE_WINDOW_MS || source.blockedUntil) {
    source.strikeStart = now;
    source.strikes = 0;
    source.blockedUntil = 0;
  }
  source.strikes += 1;
  if (source.strikes >= 8) {
    source.blockId = randomUUID();
    source.blockedAt = now;
    source.blockedUntil = now + BLOCK_MS;
    source.reason = reason;
  }
}

function validName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 40 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

function take(bucket, now, burst, perMs) {
  bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * perMs);
  bucket.at = now;
  if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000));
  bucket.tokens -= 1;
  return 0;
}

// A reverse proxy may set this header only when the actual TCP peer is allowlisted.
export function chatSource(request, trustedProxies) {
  const peer = request.socket.remoteAddress ?? '';
  const direct = peer.replace(/^::ffff:/i, '');
  const header = request.headers['x-agil-client-ip'];
  const address = (trustedProxies.has(direct) || trustedProxies.has(peer)) && typeof header === 'string' && isIP(header)
    ? header.replace(/^::ffff:/i, '') : direct;
  if (isIP(address) !== 6) return address;
  // URL canonicalizes equivalent IPv6 spellings; a source is charged by /64.
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [head, tail] = canonical.split('::');
  const prefix = head ? head.split(':') : [];
  if (tail !== undefined) {
    const suffix = tail ? tail.split(':') : [];
    prefix.push(...Array(8 - prefix.length - suffix.length).fill('0'), ...suffix);
  }
  return `${prefix.slice(0, 4).join(':')}::/64`;
}

export function openBroadcastChat({ filename, limit = 100_000, sourcePerMinute = 12, streamPerSecond = 100, clock = Date.now } = {}) {
  const databasePath = !filename || filename === ':memory:' ? ':memory:' : path.resolve(filename);
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    closeSync(openSync(databasePath, 'a', 0o600));
  }
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS chat_streams (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS chat_streams_expiry ON chat_streams (expires_at);
    CREATE TABLE IF NOT EXISTS chat_messages (
      stream_id TEXT NOT NULL REFERENCES chat_streams(id) ON DELETE CASCADE,
      id INTEGER NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, viewer_id TEXT,
      PRIMARY KEY (stream_id, id)
    ) WITHOUT ROWID;
  `);
  if (!db.prepare('PRAGMA table_info(chat_messages)').all().some(({ name }) => name === 'viewer_id')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN viewer_id TEXT');
  }
  const register = db.prepare('INSERT INTO chat_streams VALUES (?, ?)');
  const append = db.prepare('INSERT INTO chat_messages (stream_id, id, name, text, at, viewer_id) VALUES (?, ?, ?, ?, ?, ?)');
  const author = db.prepare('SELECT viewer_id, name FROM chat_messages WHERE stream_id = ? AND id = ?');
  const forgetAuthors = db.prepare('UPDATE chat_messages SET viewer_id = NULL WHERE stream_id = ? AND viewer_id IS NOT NULL');
  const prune = db.prepare('DELETE FROM chat_messages WHERE stream_id = ? AND id <= ?');
  const remove = db.prepare('DELETE FROM chat_messages WHERE stream_id = ? AND id = ?');
  const page = db.prepare('SELECT id, name, text, at FROM chat_messages WHERE stream_id = ? AND id < ? ORDER BY id DESC LIMIT 81');
  const expire = db.prepare('DELETE FROM chat_streams WHERE expires_at <= ?');
  const discard = db.prepare('DELETE FROM chat_streams WHERE id = ?');
  const exists = db.prepare('SELECT 1 FROM chat_streams WHERE id = ? AND expires_at > ?');

  function list(id, before = Number.MAX_SAFE_INTEGER) {
    const rows = page.all(id, before);
    const cursor = rows.length > 80 ? rows[79].id : null;
    return { messages: rows.slice(0, 80).reverse(), before: cursor };
  }

  return {
    list,
    exists: (id) => Boolean(exists.get(id, clock())),
    discard: (id) => discard.run(id),
    forgetAuthors: (id) => forgetAuthors.run(id),
    sweep: () => expire.run(clock()).changes,
    close: () => db.close(),
    create(id, expiresAt) {
      register.run(id, expiresAt);
      const sources = new Map();
      const networks = new Map();
      const bans = new Map();
      let policy = chatPolicy({ allowLinks: true, blockedPhrases: [] });
      const repeated = new Map();
      const stream = { tokens: streamPerSecond * 2, at: clock() };
      let lastCleanup = clock();
      let sequence = 0;
      let revision = 0;
      let recent;
      return {
        networkRetry(address) {
          const now = clock();
          if (networks.size >= MAX_SOURCES && !networks.has(address)) networks.delete(networks.keys().next().value);
          const bucket = networks.get(address) ?? { tokens: 120, at: now };
          networks.delete(address);
          networks.set(address, bucket);
          return take(bucket, now, 120, 60 / 1000);
        },
        policy: () => policy.settings,
        updatePolicy(input) {
          const next = chatPolicy(input);
          if (!next) return false;
          policy = next;
          return true;
        },
        ban(messageId, until) {
          const row = author.get(id, messageId);
          if (!row?.viewer_id) return false;
          if (!bans.has(row.viewer_id) && bans.size >= MAX_SOURCES) return false;
          bans.set(row.viewer_id, { banId: row.viewer_id, name: row.name, address: sources.get(row.viewer_id)?.address ?? null,
            blockedAt: clock(), blockedUntil: until, reason: 'manual_ban' });
          return true;
        },
        unban: (viewerId) => bans.delete(viewerId),
        list(before) {
          if (before !== undefined) return list(id, before);
          recent ??= { ...list(id), etag: `"${id}-${revision}"` };
          return recent;
        },
        remove(messageId) {
          if (!remove.run(id, messageId).changes) return false;
          revision += 1;
          recent = undefined;
          return true;
        },
        blocked(offset) {
          const now = clock();
          const blocks = [...sources].filter(([viewer, entry]) => entry.blockedUntil > now && !bans.has(viewer))
            .map(([, { blockId, address, lastName, blockedAt, blockedUntil, reason }]) => ({
              blockId, address, name: lastName ?? null, blockedAt, blockedUntil, reason,
            }));
          blocks.push(...[...bans.values()].filter((entry) => entry.blockedUntil > now));
          blocks.sort((left, right) => right.blockedUntil - left.blockedUntil || (left.address ?? '').localeCompare(right.address ?? ''));
          return { blocks: blocks.slice(offset, offset + 100), total: blocks.length };
        },
        rejectCaptcha(source, submittedName) {
          const name = validName(submittedName);
          const now = clock();
          if (name && source.blockedUntil <= now) source.lastName = name;
          strike(source, now, 'captcha_invalid');
        },
        admit(sourceId, address = sourceId) {
          const now = clock();
          const ban = bans.get(sourceId);
          if (ban?.blockedUntil > now) return { banned: true };
          if (now - lastCleanup >= 60_000) {
            for (const [key, entry] of sources) {
              if (now - entry.at >= 60_000 && entry.blockedUntil <= now) sources.delete(key);
            }
            lastCleanup = now;
          }
          let source = sources.get(sourceId);
          if (!source) {
            if (sources.size >= MAX_SOURCES) return { retry: 60 };
            source = { viewerId: sourceId, address, tokens: Math.min(3, sourcePerMinute), at: now, lastText: '', lastAt: 0,
              strikeStart: now, strikes: 0, blockedUntil: 0 };
            sources.set(sourceId, source);
          }
          if (source.blockedUntil > now) return { retry: Math.ceil((source.blockedUntil - now) / 1000), blocked: true };
          source.address = address;
          const retry = take(source, now, Math.min(3, sourcePerMinute), sourcePerMinute / 60_000);
          if (!retry) return { source };
          strike(source, now, 'comment_rate_limited');
          return source.blockedUntil > now ? { retry: BLOCK_MS / 1000, blocked: true } : { retry };
        },
        post(input, source) {
          if (bans.get(source.viewerId)?.blockedUntil > clock()) return { status: 403, body: { error: 'viewer_banned' } };
          const name = validName(input?.name);
          const text = typeof input?.text === 'string' ? input.text.trim() : '';
          if (!name || !text || text.length > 300 || /[\u0000-\u001f\u007f]/u.test(text)) return { status: 400 };
          const rejection = policy.rejection(name) ?? policy.rejection(text);
          if (rejection) return { status: 422, body: { error: rejection } };
          source.lastName = name;
          const now = clock();
          const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
          if (source.lastText === normalized && now - source.lastAt < 30_000) {
            strike(source, now, 'duplicate_comment');
            if (source.blockedUntil > now) return { status: 429, retry: BLOCK_MS / 1000, body: { error: 'source_blocked' } };
            return { status: 429, retry: Math.ceil((30_000 - now + source.lastAt) / 1000), body: { error: 'duplicate_comment' } };
          }
          const prior = normalized.length >= 12 ? repeated.get(normalized) : undefined;
          const sameWindow = prior && now - prior.at < 15_000;
          if (sameWindow && prior.count >= 6) {
            return { status: 429, retry: Math.ceil((15_000 - now + prior.at) / 1000), body: { error: 'repeated_comment' } };
          }
          const retry = take(stream, now, streamPerSecond * 2, streamPerSecond / 1000);
          if (retry) return { status: 429, retry, body: { error: 'chat_busy' } };
          const body = { id: sequence + 1, name, text, at: now };
          db.exec('BEGIN');
          try {
            append.run(id, body.id, name, text, now, source.viewerId);
            if (body.id > limit) prune.run(id, body.id - limit);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          sequence = body.id;
          revision += 1;
          recent = undefined;
          source.lastText = normalized;
          source.lastAt = now;
          if (normalized.length >= 12) {
            if (sameWindow) prior.count += 1;
            else {
              repeated.delete(normalized);
              if (repeated.size >= 8192) repeated.delete(repeated.keys().next().value);
              repeated.set(normalized, { count: 1, at: now });
            }
          }
          return { status: 201, body };
        },
      };
    },
  };
}
