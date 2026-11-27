#!/usr/bin/env node
/**
 * Seed test data for AgilFrame (virtual users, countries, messages, transcripts,
 * files, recordings, roles, analysis) + a local SQLite "test DB".
 *
 *   AGIL_ADMIN_KEY=demo-... node scripts/seed.mjs [--url https://calls.example.com] [--rooms 12] [--users 80]
 *
 * The script talks to the deployed instance through its admin/public API, so it
 * is safe to run against staging/demo; it never touches the database directly.
 * It also writes seed/agil-test.db (SQLite) and seed/agil-test-data.json for
 * local analytics/tests.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import process from 'node:process';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const BASE = (process.env.BASE_URL || [...args].find((a) => a.startsWith('--url='))?.split('=')[1] || 'https://calls.example.com').replace(/\/$/, '');
const ADMIN_KEY = process.env.AGIL_ADMIN_KEY || process.env.ADMIN_KEY || '';
const TENANT = process.env.TENANT || 'demo';
const ROOM_COUNT = Number([...args].find((a) => a.startsWith('--rooms='))?.split('=')[1] || 12);
const USER_COUNT = Number([...args].find((a) => a.startsWith('--users='))?.split('=')[1] || 80);
const OUT = path.join(process.cwd(), 'seed');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!ADMIN_KEY) {
  console.error('AGIL_ADMIN_KEY is required');
  process.exit(1);
}

const api = async (pathname, { method = 'GET', body, headers = {}, admin = false, raw } = {}) => {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(raw ? {} : { 'content-type': 'application/json' }),
      ...(admin ? { 'x-api-key': ADMIN_KEY } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!response.ok && response.status !== 409) {
    throw new Error(`${method} ${pathname} → ${response.status}: ${typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed)}`);
  }
  return { status: response.status, body: parsed };
};

const COUNTRIES = [
  { code: 'RU', city: 'Москва', weight: 40 },
  { code: 'RU', city: 'Санкт-Петербург', weight: 20 },
  { code: 'KZ', city: 'Алматы', weight: 8 },
  { code: 'BY', city: 'Минск', weight: 6 },
  { code: 'AM', city: 'Ереван', weight: 5 },
  { code: 'GE', city: 'Тбилиси', weight: 4 },
  { code: 'DE', city: 'Берлин', weight: 5 },
  { code: 'US', city: 'Нью-Йорк', weight: 4 },
  { code: 'AE', city: 'Дубай', weight: 3 },
  { code: 'TR', city: 'Стамбул', weight: 3 },
  { code: 'RS', city: 'Белград', weight: 2 },
];
const FIRST = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дарья', 'Егор', 'Жанна', 'Игорь', 'Ксения', 'Леонид', 'Мария', 'Никита', 'Ольга', 'Павел', 'Рита', 'Сергей', 'Татьяна', 'Ульяна', 'Фёдор', 'Элина'];
const LAST = ['Иванов', 'Петрова', 'Смирнов', 'Кузнецова', 'Попов', 'Соколова', 'Лебедев', 'Козлова', 'Новиков', 'Морозова', 'Волков', 'Зайцева', 'Егоров', 'Павлова', 'Семёнов', 'Голубева', 'Виноградов', 'Богданова', 'Воробьёв', 'Фёдорова'];
const ROOM_NAMES = ['Планёрка продукта', 'Демо для клиента', 'Спринт-ревью', 'Интервью кандидата', 'Квартальный брифинг', 'Вебинар: безопасность', 'Созвон с подрядчиком', 'Ретро команды', 'Технический разбор', 'Онбординг', 'Маркетинг-синк', 'Партнёрская встреча'];
const CHATS = ['Добрый день!', 'Начинаем через 2 минуты', 'Вижу вас, слышу хорошо', 'Пришлите, пожалуйста, презентацию', 'Давайте обсудим бюджет', 'Конкурент предложил другие сроки', 'Записываем?', 'Кто отвечает за дедлайн?', 'Спасибо, всё понятно', 'Следующая встреча в среду'];
const CAPTIONS = ['Обсудили бюджет проекта на квартал', 'Решили перенести релиз на следующую неделю', 'Конкурент предлагает похожий функционал', 'Нужно подготовить отчёт до пятницы', 'Договорились о встрече с партнёрами'];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261113);
const pick = (list) => list[Math.floor(random() * list.length)];
const weightedCountry = () => {
  const total = COUNTRIES.reduce((sum, country) => sum + country.weight, 0);
  let roll = random() * total;
  for (const country of COUNTRIES) {
    roll -= country.weight;
    if (roll <= 0) return country;
  }
  return COUNTRIES[0];
};

function makeUsers(count) {
  const users = [];
  for (let index = 0; index < count; index += 1) {
    const first = FIRST[index % FIRST.length];
    const last = LAST[Math.floor(index / FIRST.length) % LAST.length];
    const country = weightedCountry();
    users.push({
      id: `seed-user-${String(index + 1).padStart(3, '0')}`,
      name: `${first} ${last}`,
      email: `user${String(index + 1).padStart(3, '0')}@example.test`,
      country: country.code,
      city: country.city,
      role: index % 17 === 0 ? 'host' : index % 5 === 0 ? 'moderator' : 'guest',
    });
  }
  return users;
}

async function wsSession(token, { country, captions = 2, chats = 2 } = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`, {
      headers: country ? { 'x-agil-country': country } : {},
    });
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve({ ok: false });
    }, 5000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello' }));
      for (let index = 0; index < chats; index += 1) {
        socket.send(JSON.stringify({ type: 'chat', id: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: pick(CHATS) }));
      }
      for (let index = 0; index < captions; index += 1) {
        socket.send(JSON.stringify({ type: 'caption', text: pick(CAPTIONS), isFinal: true, lang: 'ru' }));
      }
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        clearTimeout(timer);
        resolve({ ok: true });
      }, 500);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ ok: true });
    });
  });
}

async function ensureRoles() {
  const existing = await api('/v1/admin/roles', { admin: true });
  const roles = new Map((existing.body?.roles ?? []).map((role) => [role.id, role]));
  const definitions = [
    { id: 'streamer', name: 'Стример', description: 'Ведёт трансляцию (тестовая роль)', baseRole: 'host', features: ['chat', 'screenShare', 'fullscreen', 'knowledgeAgent'], canModerate: false, color: '#8576ff' },
    { id: 'operator', name: 'Оператор', description: 'Модерирует чат и участников (тестовая роль)', baseRole: 'moderator', features: ['chat', 'fileShare', 'screenShare', 'participantList', 'handRaise', 'reactions'], canModerate: true, color: '#22c55e' },
    { id: 'viewer', name: 'Наблюдатель', description: 'Только смотреть и слушать (тестовая роль)', baseRole: 'guest', features: ['chat', 'reactions'], canModerate: false, color: '#94a3b8' },
  ];
  for (const definition of definitions) {
    if (!roles.has(definition.id)) {
      await api('/v1/admin/roles', { method: 'POST', admin: true, body: definition });
    }
  }
  return definitions.map((role) => role.id);
}

async function main() {
  console.log(`AgilFrame seed → ${BASE} (tenant ${TENANT})`);
  mkdirSync(OUT, { recursive: true });
  const users = makeUsers(USER_COUNT);
  const roleIds = await ensureRoles();

  // Enable demo features needed to seed files/recordings/analysis, and a local
  // compliance rule so analysis produces findings.
  await api(`/v1/tenants/${TENANT}/config`, {
    method: 'PATCH',
    admin: true,
    body: {
      features: { fileShare: true, recording: true, captions: true, aiCompliance: true },
      session: {
        fileShare: { enabled: true, storeOnServer: true, maxFileSizeMb: 25, allowedMimeTypes: [] },
        recording: { enabled: true, storeOnServer: true, consentRequired: false, notifyParticipants: true, format: 'webm', includeChat: true },
      },
      fallback: { lowBandwidth: { enabled: true } },
      aiAgent: {
        enabled: true,
        mode: 'local',
        policyRules: [
          { id: 'competitor', name: 'Упоминание конкурентов', type: 'phrase', pattern: 'конкурент', severity: 'warn', action: 'flag', enabled: true },
          { id: 'budget', name: 'Обсуждение бюджета', type: 'phrase', pattern: 'бюджет', severity: 'info', action: 'flag', enabled: true },
        ],
      },
    },
  });

  const rooms = [];
  const messages = [];
  const transcript = [];
  const joined = [];

  for (let index = 0; index < ROOM_COUNT; index += 1) {
    const name = `${ROOM_NAMES[index % ROOM_NAMES.length]} · seed ${index + 1}`;
    const password = index % 4 === 0 ? 'seed-pass' : undefined;
    const mode = index % 6 === 0 ? 'direct' : 'group';
    const roomResponse = await api('/v1/admin/rooms', {
      method: 'POST',
      admin: true,
      body: {
        tenantId: TENANT,
        name,
        ...(password ? { password } : {}),
        mode,
        maxParticipants: mode === 'direct' ? 2 : 8 + (index % 20),
        context: mode === 'direct' ? { messenger: 'seed-chat', conversationId: `conv-${index}` } : { messenger: 'seed-chat', conversationId: `group-${index}` },
      },
    });
    const room = roomResponse.body?.room;
    if (!room) continue;
    rooms.push({ ...room, passwordProtected: Boolean(password), mode, name });

    const participants = mode === 'direct' ? 2 : 3 + (index % 5);
    for (let seat = 0; seat < participants; seat += 1) {
      const user = users[(index * 7 + seat * 3) % users.length];
      const joinBody = { name: user.name, ...(password ? { password } : {}) };
      let join;
      try {
        join = await api(`/v1/rooms/${room.id}/join`, { method: 'POST', headers: { 'x-agil-country': user.country }, body: joinBody });
      } catch (error) {
        console.warn(`  join failed for ${user.name}: ${error.message}`);
        continue;
      }
      const token = join.body?.token;
      if (!token) continue;
      if (seat === 0 && index % 3 === 0) {
        const roleId = roleIds[index % roleIds.length];
        try {
          const roleToken = await api('/v1/tokens', { method: 'POST', admin: true, body: { tenantId: TENANT, roomId: room.id, participant: { name: `${user.name} (${roleId})`, role: 'guest', roleId } } });
          if (roleToken.body?.token) {
            await wsSession(roleToken.body.token, { country: user.country, captions: 1, chats: 1 });
            joined.push({ roomId: room.id, userId: user.id, name: user.name, role: roleId, country: user.country });
          }
        } catch (error) {
          console.warn(`  role token failed: ${error.message}`);
        }
      }
      await wsSession(token, { country: user.country, captions: 2 + (seat % 2), chats: 1 + (seat % 3) });
      joined.push({ roomId: room.id, userId: user.id, name: user.name, role: user.role, country: user.country });
      messages.push({ roomId: room.id, userId: user.id, text: pick(CHATS), ts: Date.now() });
      transcript.push({ roomId: room.id, userId: user.id, text: pick(CAPTIONS), ts: Date.now() });
    }

    // Wrong-password attempt (audit events) for protected rooms.
    if (password) {
      try {
        await api(`/v1/rooms/${room.id}/join`, { method: 'POST', body: { name: 'Посторонний', password: 'wrong' } });
      } catch {
        /* expected 401 */
      }
    }

    // Files from an admin-issued host token (tests feature-gated upload).
    try {
      const hostTokenResponse = await api('/v1/tokens', {
        method: 'POST',
        admin: true,
        body: { tenantId: TENANT, roomId: room.id, participant: { name: 'Секретарь', role: 'host' }, permissions: ['fileShare', 'recording', 'chat'] },
      });
      const hostToken = hostTokenResponse.body?.token;
      if (hostToken) {
        const fileName = encodeURIComponent(`Протокол-${index + 1}.txt`);
        await api('/v1/files', {
          method: 'POST',
          headers: { authorization: `Bearer ${hostToken}`, 'x-file-name': fileName, 'content-type': 'text/plain' },
          raw: `Тестовый протокол встречи №${index + 1}\nУчастники: ${participants}\n`,
        });
      }
    } catch (error) {
      console.warn(`  file seed failed: ${error.message}`);
    }

    // Recording blob (few rooms only, to keep data small).
    if (index % 3 === 0) {
      try {
        const recorderTokenResponse = await api('/v1/tokens', {
          method: 'POST',
          admin: true,
          body: { tenantId: TENANT, roomId: room.id, participant: { name: 'Рекордер', role: 'host' }, permissions: ['recording', 'chat'] },
        });
        const recorderToken = recorderTokenResponse.body?.token;
        if (recorderToken) {
          await api('/v1/recordings', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${recorderToken}`,
              'content-type': 'video/webm',
              'x-recording-meta': JSON.stringify({ roomId: room.id, durationSec: 30 + index * 5, mimeType: 'video/webm' }),
            },
            raw: Buffer.from('AGIL-CALLS-SEED-RECORDING'),
          });
        }
      } catch (error) {
        console.warn(`  recording seed failed: ${error.message}`);
      }
    }

    // Local compliance analysis over seeded captions.
    try {
      await api(`/v1/admin/rooms/${room.id}/analysis/run`, { method: 'POST', admin: true, body: {} });
    } catch (error) {
      console.warn(`  analysis failed: ${error.message}`);
    }
  }

  // Write the local "test DB" (SQLite) + JSON snapshot.
  const db = new DatabaseSync(path.join(OUT, 'agil-test.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, email TEXT, country TEXT, city TEXT, role TEXT);
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, tenant TEXT, name TEXT, mode TEXT, media_mode TEXT, max_participants INTEGER, password_protected INTEGER, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS room_participants (room_id TEXT, user_id TEXT, name TEXT, role TEXT, country TEXT, joined_at INTEGER);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, user_id TEXT, text TEXT, ts INTEGER);
    CREATE TABLE IF NOT EXISTS transcript (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, user_id TEXT, text TEXT, ts INTEGER);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, severity TEXT, room_id TEXT, country TEXT, message TEXT, ts INTEGER);
  `);
  const insertUser = db.prepare('INSERT OR REPLACE INTO users VALUES (?,?,?,?,?,?)');
  for (const user of users) insertUser.run(user.id, user.name, user.email, user.country, user.city, user.role);
  const insertRoom = db.prepare('INSERT OR REPLACE INTO rooms VALUES (?,?,?,?,?,?,?,?)');
  for (const room of rooms) insertRoom.run(room.id, TENANT, room.name, room.mode ?? 'group', room.mediaMode ?? 'mesh', room.maxParticipants ?? 0, room.passwordProtected ? 1 : 0, room.createdAt ?? Date.now());
  const insertParticipant = db.prepare('INSERT INTO room_participants VALUES (?,?,?,?,?,?)');
  for (const item of joined) insertParticipant.run(item.roomId, item.userId, item.name, item.role, item.country, Date.now());
  const insertMessage = db.prepare('INSERT INTO messages (room_id,user_id,text,ts) VALUES (?,?,?,?)');
  for (const message of messages) insertMessage.run(message.roomId, message.userId, message.text, message.ts);
  const insertTranscript = db.prepare('INSERT INTO transcript (room_id,user_id,text,ts) VALUES (?,?,?,?)');
  for (const segment of transcript) insertTranscript.run(segment.roomId, segment.userId, segment.text, segment.ts);
  db.close();

  const snapshot = { generatedAt: new Date().toISOString(), base: BASE, tenant: TENANT, users, rooms, participants: joined, messages, transcript };
  writeFileSync(path.join(OUT, 'agil-test-data.json'), JSON.stringify(snapshot, null, 2));

  console.log(`\nГотово:`);
  console.log(`  комнат: ${rooms.length}`);
  console.log(`  виртуальных пользователей: ${users.length}`);
  console.log(`  подключений (WS): ${joined.length}`);
  console.log(`  сообщений: ${messages.length}, транскрипт-сегментов: ${transcript.length}`);
  console.log(`  SQLite: ${path.relative(process.cwd(), path.join(OUT, 'agil-test.db'))}`);
  console.log(`  JSON:   ${path.relative(process.cwd(), path.join(OUT, 'agil-test-data.json'))}`);
  console.log(`  Панель: ${BASE}/dashboard/ (тенант ${TENANT})`);
}

await main();
