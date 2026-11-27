#!/usr/bin/env node
/**
 * Minimal RESP2 in-memory server used only by the HA tests
 * (`apps/server/test/ha-cluster.test.ts`, `ha-two-process.test.ts`) when a real
 * Redis is not available (`AGIL_TEST_REDIS_URL` unset).
 *
 * It implements exactly the subset the Core leader lease needs:
 * PING/AUTH/SELECT, SET (NX/XX/PX/EX), GET, DEL, EXISTS, PTTL, PEXPIRE,
 * HSET/HGET/HGETALL/HDEL, INCR, FLUSHALL and the lease/check-and-update scripts
 * from `src/leader.ts` (recognised by their command shape, not a Lua parser).
 *
 * This is NOT a Redis replacement: no persistence, replication, pub/sub,
 * clustering or general scripting. Prefer a real Redis (`AGIL_TEST_REDIS_URL`
 * or Docker) for the failover gate; the script labels the fallback clearly.
 *
 *   node agil/core/scripts/support/mini-redis.mjs --port 0 --json
 *   → {"port":63817}
 */
import { createServer } from 'node:net';
import process from 'node:process';

const ARGS = process.argv.slice(2);
function flag(name, fallback) {
  const equals = ARGS.find((arg) => arg.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = ARGS.indexOf(`--${name}`);
  if (index >= 0 && ARGS[index + 1] && !ARGS[index + 1].startsWith('--')) return ARGS[index + 1];
  return fallback;
}
const HOST = flag('host', '127.0.0.1');
const PORT = Number(flag('port', '0'));
const PASSWORD = flag('password', '');
const JSON_OUT = ARGS.includes('--json');

const strings = new Map(); // key -> string
const hashes = new Map(); // key -> Map<field, string>
const sets = new Map(); // key -> Set<string>
const expiry = new Map(); // key -> epoch ms
let authenticated = PASSWORD.length === 0;

function isExpired(key) {
  const at = expiry.get(key);
  if (at === undefined) return false;
  if (Date.now() < at) return false;
  strings.delete(key);
  hashes.delete(key);
  sets.delete(key);
  expiry.delete(key);
  return true;
}
function exists(key) {
  if (isExpired(key)) return false;
  return strings.has(key) || hashes.has(key) || sets.has(key);
}
function getString(key) {
  if (isExpired(key)) return null;
  return strings.has(key) ? strings.get(key) : null;
}
function setString(key, value, ttlMs) {
  strings.set(key, value);
  hashes.delete(key);
  sets.delete(key);
  if (ttlMs === null) expiry.delete(key);
  else expiry.set(key, Date.now() + Math.max(1, ttlMs));
}
function del(key) {
  isExpired(key);
  const existed = strings.has(key) || hashes.has(key) || sets.has(key);
  strings.delete(key);
  hashes.delete(key);
  sets.delete(key);
  expiry.delete(key);
  return existed ? 1 : 0;
}

/* ------------------------------- RESP I/O ------------------------------- */

const CRLF = '\r\n';
function bulk(value) {
  if (value === null || value === undefined) return `$-1${CRLF}`;
  const text = String(value);
  return `$${Buffer.byteLength(text)}${CRLF}${text}${CRLF}`;
}
function integer(value) {
  return `:${Number(value)}${CRLF}`;
}
function simple(value) {
  return `+${value}${CRLF}`;
}
function error(value) {
  return `-ERR ${value}${CRLF}`;
}
function array(values) {
  if (values === null) return `*-1${CRLF}`;
  return `*${values.length}${CRLF}${values.map((value) => (value === null ? bulk(null) : bulk(value))).join('')}`;
}

/** Incremental RESP array parser; returns {args} | null when incomplete. */
function parseCommand(buffer) {
  if (buffer.length === 0) return null;
  if (buffer[0] !== 0x2a /* '*' */) {
    const end = buffer.indexOf(CRLF);
    if (end < 0) return null;
    const line = buffer.subarray(0, end).toString('utf8').trim();
    if (!line) return { args: [], next: end + 2 };
    return { args: line.split(/\s+/), next: end + 2 };
  }
  let offset = 1;
  const countEnd = buffer.indexOf(CRLF, offset);
  if (countEnd < 0) return null;
  const count = Number(buffer.subarray(offset, countEnd).toString('utf8'));
  if (!Number.isInteger(count) || count < 0) return { args: [], next: countEnd + 2, bad: true };
  offset = countEnd + 2;
  const args = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer[offset] !== 0x24 /* '$' */) return null;
    const lengthEnd = buffer.indexOf(CRLF, offset + 1);
    if (lengthEnd < 0) return null;
    const length = Number(buffer.subarray(offset + 1, lengthEnd).toString('utf8'));
    if (!Number.isInteger(length) || length < 0) return { args: [], next: lengthEnd + 2, bad: true };
    const start = lengthEnd + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.subarray(start, start + length).toString('utf8'));
    offset = start + length + 2;
  }
  return { args, next: offset };
}

function runCommand(args) {
  if (args.length === 0) return error('empty command');
  const command = args[0].toUpperCase();
  const rest = args.slice(1);
  if (!authenticated && command !== 'AUTH' && command !== 'QUIT' && command !== 'PING') {
    return `-NOAUTH Authentication required.${CRLF}`;
  }
  switch (command) {
    case 'PING':
      return simple('PONG');
    case 'AUTH': {
      if (!PASSWORD) return simple('OK');
      const candidate = rest.length >= 2 ? rest[1] : rest[0];
      if (candidate === PASSWORD) {
        authenticated = true;
        return simple('OK');
      }
      return `-WRONGPASS invalid username-password pair${CRLF}`;
    }
    case 'SELECT':
      return simple('OK');
    case 'GET':
      return bulk(getString(rest[0]));
    case 'SET': {
      const key = rest[0];
      const value = rest[1];
      if (key === undefined || value === undefined) return error('wrong number of arguments for SET');
      let nx = false;
      let xx = false;
      let ttlMs = null;
      let keepTtl = false;
      for (let index = 2; index < rest.length; index += 1) {
        const option = rest[index].toUpperCase();
        if (option === 'NX') nx = true;
        else if (option === 'XX') xx = true;
        else if (option === 'PX') {
          ttlMs = Number(rest[(index += 1)]);
          if (!Number.isFinite(ttlMs) || ttlMs <= 0) return error('invalid PX value');
        } else if (option === 'EX') {
          ttlMs = Number(rest[(index += 1)]) * 1000;
          if (!Number.isFinite(ttlMs) || ttlMs <= 0) return error('invalid EX value');
        } else if (option === 'KEEPTTL') keepTtl = true;
        else return error(`unsupported SET option ${option}`);
      }
      const present = exists(key);
      if ((nx && present) || (xx && !present)) return bulk(null);
      if (keepTtl) {
        const previous = expiry.get(key);
        setString(key, value, null);
        if (previous !== undefined) expiry.set(key, previous);
      } else {
        setString(key, value, ttlMs);
      }
      return simple('OK');
    }
    case 'DEL': {
      let removed = 0;
      for (const key of rest) removed += del(key);
      return integer(removed);
    }
    case 'EXISTS': {
      let count = 0;
      for (const key of rest) if (exists(key)) count += 1;
      return integer(count);
    }
    case 'PTTL': {
      const key = rest[0];
      if (!exists(key)) return integer(-2);
      const at = expiry.get(key);
      return integer(at === undefined ? -1 : Math.max(0, at - Date.now()));
    }
    case 'PEXPIRE': {
      const key = rest[0];
      const ttl = Number(rest[1]);
      if (!exists(key)) return integer(0);
      if (!Number.isFinite(ttl)) return error('invalid PEXPIRE value');
      expiry.set(key, Date.now() + Math.max(1, ttl));
      return integer(1);
    }
    case 'EXPIRE': {
      const key = rest[0];
      if (!exists(key)) return integer(0);
      expiry.set(key, Date.now() + Math.max(1, Number(rest[1]) * 1000));
      return integer(1);
    }
    case 'SADD': {
      const [key, ...values] = rest;
      isExpired(key);
      const set = sets.get(key) ?? new Set();
      let added = 0;
      for (const value of values) {
        if (!set.has(value)) added += 1;
        set.add(value);
      }
      sets.set(key, set);
      return integer(added);
    }
    case 'SREM': {
      const [key, ...values] = rest;
      const set = exists(key) ? sets.get(key) : undefined;
      if (!set) return integer(0);
      let removed = 0;
      for (const value of values) if (set.delete(value)) removed += 1;
      if (set.size === 0) del(key);
      return integer(removed);
    }
    case 'SMEMBERS':
      return array(exists(rest[0]) ? [...(sets.get(rest[0]) ?? [])] : []);
    case 'HSET': {
      const key = rest[0];
      if (key === undefined || rest.length < 3) return error('wrong number of arguments for HSET');
      if (isExpired(key)) strings.delete(key);
      const hash = hashes.get(key) ?? new Map();
      let added = 0;
      for (let index = 1; index + 1 < rest.length; index += 2) {
        if (!hash.has(rest[index])) added += 1;
        hash.set(rest[index], rest[index + 1]);
      }
      hashes.set(key, hash);
      strings.delete(key);
      return integer(added);
    }
    case 'HGET': {
      const hash = exists(rest[0]) ? hashes.get(rest[0]) : undefined;
      return bulk(hash?.get(rest[1]) ?? null);
    }
    case 'HGETALL': {
      const hash = exists(rest[0]) ? hashes.get(rest[0]) : undefined;
      if (!hash) return array([]);
      const flat = [];
      for (const [field, value] of hash) flat.push(field, value);
      return array(flat);
    }
    case 'HDEL': {
      const hash = exists(rest[0]) ? hashes.get(rest[0]) : undefined;
      if (!hash) return integer(0);
      let removed = 0;
      for (const field of rest.slice(1)) if (hash.delete(field)) removed += 1;
      return integer(removed);
    }
    case 'INCR': {
      const key = rest[0];
      const current = Number(getString(key) ?? '0');
      if (!Number.isFinite(current)) return error('value is not an integer');
      const next = current + 1;
      const previousExpiry = expiry.get(key);
      setString(key, String(next), null);
      if (previousExpiry !== undefined) expiry.set(key, previousExpiry);
      return integer(next);
    }
    case 'EVAL': {
      const script = String(rest[0] ?? '').toLowerCase();
      const numkeys = Number(rest[1] ?? '0');
      if (!Number.isInteger(numkeys) || numkeys < 1) return error('EVAL needs at least one key');
      const keys = rest.slice(2, 2 + numkeys);
      const argv = rest.slice(2 + numkeys);
      const key = keys[0];
      const comparesGet = script.includes("'get'") || script.includes('"get"');
      if (!comparesGet) return error('mini-redis supports only compare-and-* scripts');
      if (numkeys === 2 && script.includes("'fenced'") && script.includes("'observed'") && script.includes("'updated'")) {
        if (getString(key) !== argv[0]) return array(['fenced']);
        const current = getString(keys[1]) ?? '';
        if (argv[1] === 'read' || current !== argv[2]) return array(['observed', current]);
        if (argv[3] === '') del(keys[1]);
        else setString(keys[1], argv[3], null);
        return array(['updated', argv[3]]);
      }
      if (getString(key) !== argv[0]) return integer(0);
      if (numkeys === 4 && script.includes("'sadd'")) {
        const ttl = Number(argv[2]);
        setString(keys[1], argv[1], ttl > 0 ? ttl : null);
        for (const [setKey, value] of [[keys[2], argv[3]], [keys[3], argv[4]]]) {
          const entries = sets.get(setKey) ?? new Set();
          entries.add(value);
          sets.set(setKey, entries);
        }
        return integer(1);
      }
      if (numkeys === 4 && script.includes("'srem'")) {
        if (argv[3] === 'prune') {
          if (exists(keys[1])) return integer(1);
        } else del(keys[1]);
        const roomIds = sets.get(keys[2]);
        roomIds?.delete(argv[1]);
        if (!roomIds?.size) {
          del(keys[2]);
          sets.get(keys[3])?.delete(argv[2]);
          if (!sets.get(keys[3])?.size) del(keys[3]);
        }
        return integer(1);
      }
      if (script.includes('pexpire')) {
        const ttl = Number(argv[1]);
        if (!Number.isFinite(ttl) || ttl <= 0) return error('invalid TTL');
        expiry.set(key, Date.now() + ttl);
        return integer(1);
      }
      if (script.includes('del')) {
        del(key);
        return integer(1);
      }
      return error('mini-redis does not understand this script');
    }
    case 'TIME': {
      const now = Date.now() / 1000;
      return array([String(Math.floor(now)), String(Math.round((now % 1) * 1_000_000))]);
    }
    case 'FLUSHALL':
      strings.clear();
      hashes.clear();
      sets.clear();
      expiry.clear();
      return simple('OK');
    case 'QUIT':
      return { close: true, reply: simple('OK') };
    default:
      return error(`unknown command '${command}'`);
  }
}

const server = createServer((socket) => {
  socket.setNoDelay(true);
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      const parsed = parseCommand(buffer);
      if (!parsed) return;
      buffer = buffer.subarray(parsed.next);
      if (parsed.bad) {
        socket.write(error('protocol error'));
        continue;
      }
      const result = runCommand(parsed.args);
      if (typeof result === 'string') {
        socket.write(result);
      } else if (result && typeof result === 'object' && 'close' in result) {
        socket.end(result.reply);
        return;
      }
    }
  });
  socket.on('error', () => {
    /* clients reconnect; a test stub must never crash the suite */
  });
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  if (JSON_OUT) process.stdout.write(`${JSON.stringify({ port, host: HOST })}\n`);
  else process.stdout.write(`mini-redis listening on ${HOST}:${port}\n`);
});

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
