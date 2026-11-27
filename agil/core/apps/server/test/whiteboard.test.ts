/**
 * Whiteboard + screen-share annotations (P2): bounded per-room state, WS
 * broadcast/replay, host/moderator permissions, audit and annotation lifecycle.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ANNOTATION_POINTS_PER_STROKE,
  MAX_WHITEBOARD_POINTS_PER_STROKE,
  MAX_WHITEBOARD_STROKES,
  MAX_WHITEBOARD_TOTAL_POINTS,
  type WhiteboardAuthor,
} from '@agil/protocol';
import { RoomAnnotations, RoomWhiteboard } from '../src/whiteboard.js';
import { openWs, startTestServer, type TestServer } from './helpers.js';

const ADMIN = { 'x-api-key': 'dev-key' };
const HOST: WhiteboardAuthor = { id: 'p-host', name: 'Host', role: 'host' };
const GUEST: WhiteboardAuthor = { id: 'p-guest', name: 'Guest', role: 'guest' };
const MOD: WhiteboardAuthor = { id: 'p-mod', name: 'Mod', role: 'moderator' };

function line(points = 2, x = 0.1): Array<{ x: number; y: number }> {
  return Array.from({ length: points }, (_, index) => ({ x: Math.min(1, x + index / 1000), y: 0.5 }));
}

/* ------------------------------------------------------------------ */
/* Pure room state                                                     */
/* ------------------------------------------------------------------ */

test('whiteboard state: defaults, sequencing, idempotent ids, implicit open', () => {
  const board = new RoomWhiteboard('room-1');
  const first = board.addStroke({ tool: 'pen', points: line(3) }, GUEST, 1000);
  assert.equal(first.ok, true);
  assert.equal(first.stroke?.seq, 1);
  assert.equal(first.stroke?.authorName, 'Guest');
  assert.equal(first.stroke?.color, '#ef4444');
  assert.equal(first.stroke?.width, 0.012);
  assert.equal(board.open, true);
  assert.equal(board.strokeCount, 1);
  assert.equal(board.snapshot().revision, 1);

  const duplicate = board.addStroke({ id: first.stroke?.id, tool: 'pen', points: line(1) }, GUEST, 1001);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(board.strokeCount, 1, 'retry with the same id must not duplicate the stroke');

  const second = board.addStroke({ id: 'client-2', tool: 'eraser', points: line(2) }, HOST, 1002);
  assert.equal(second.stroke?.seq, 2);
  assert.equal(second.stroke?.tool, 'eraser');
  assert.equal(board.snapshot().revision, 2);
});

test('whiteboard state: caps strokes, points and per-stroke bytes', () => {
  const board = new RoomWhiteboard('room-limits');
  for (let index = 0; index < MAX_WHITEBOARD_STROKES + 30; index += 1) {
    const result = board.addStroke({ tool: 'pen', points: line(1, index / 1000) }, GUEST, index);
    assert.equal(result.ok, true);
  }
  assert.equal(board.strokeCount, MAX_WHITEBOARD_STROKES, 'oldest strokes are evicted');
  assert.ok(board.totalPoints <= MAX_WHITEBOARD_TOTAL_POINTS);

  const tooMany = board.addStroke({ tool: 'pen', points: line(MAX_WHITEBOARD_POINTS_PER_STROKE + 1) }, GUEST);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.reason, 'too_many_points');

  // High-precision coordinates push a max-length stroke over the byte budget.
  const dense = Array.from({ length: MAX_WHITEBOARD_POINTS_PER_STROKE }, (_, index) => ({
    x: Math.min(1, index / MAX_WHITEBOARD_POINTS_PER_STROKE),
    y: 0.123456789012345,
  }));
  const tooLarge = board.addStroke({ tool: 'pen', points: dense }, GUEST);
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.reason, 'too_large');

  const invalid = board.addStroke({ tool: 'pen', points: [{ x: Number.NaN, y: 0.2 }] }, GUEST);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid_points');

  // Total-point budget: fill with large-but-legal strokes, the oldest go away.
  const pointBoard = new RoomWhiteboard('room-points');
  for (let index = 0; index < 30; index += 1) {
    const result = pointBoard.addStroke(
      { tool: 'pen', points: Array.from({ length: 900 }, (_, point) => ({ x: point / 900, y: 0.4 })) },
      GUEST,
      index,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.ok(pointBoard.totalPoints <= MAX_WHITEBOARD_TOTAL_POINTS, `total=${pointBoard.totalPoints}`);
  assert.ok(pointBoard.strokeCount < 30, 'strokes are evicted to respect the point budget');
});

test('whiteboard state: undo only the caller, clear, close/lock and re-open', () => {
  const board = new RoomWhiteboard('room-perms');
  board.addStroke({ tool: 'pen', points: line(2) }, GUEST);
  board.addStroke({ tool: 'pen', points: line(2) }, HOST);
  board.addStroke({ tool: 'pen', points: line(2) }, GUEST);
  const undone = board.undo(GUEST.id);
  assert.deepEqual(undone.removedIds, ['wb-room-perms-3']);
  assert.equal(board.strokeCount, 2);
  assert.equal(board.undo('nobody').changed, false);

  const closed = board.closeBoard();
  assert.equal(closed.snapshot.open, false);
  assert.equal(closed.snapshot.locked, true);
  assert.equal(board.open, false);
  assert.equal(board.locked, true);
  const reopened = board.openBoard();
  assert.equal(reopened.snapshot.open, true);
  assert.equal(reopened.snapshot.locked, false);

  const cleared = board.clear();
  assert.equal(cleared.removed, 2);
  assert.equal(board.strokeCount, 0);
});

test('annotation state: attached to the presenter, wiped on presenter change', () => {
  const annotations = new RoomAnnotations('room-a');
  const noShare = annotations.addStroke({ tool: 'pen', points: line(2) }, GUEST);
  assert.equal(noShare.ok, false);
  assert.equal(noShare.reason, 'no_presenter');

  assert.equal(annotations.setPresenter(HOST.id).changed, true);
  const added = annotations.addStroke({ tool: 'pen', points: line(2), color: '#3b82f6' }, GUEST);
  assert.equal(added.ok, true);
  assert.equal(annotations.strokeCount, 1);
  assert.equal(annotations.snapshot().presenterId, HOST.id);

  const changed = annotations.setPresenter(MOD.id);
  assert.equal(changed.cleared, true);
  assert.equal(annotations.strokeCount, 0, 'a new presenter starts with a clean layer');

  annotations.addStroke({ tool: 'eraser', points: line(2) }, HOST);
  const stopped = annotations.setPresenter(null);
  assert.equal(stopped.cleared, true);
  assert.equal(annotations.snapshot().presenterId, null);
  assert.equal(annotations.strokeCount, 0);

  // Caps mirror the whiteboard.
  annotations.setPresenter(HOST.id);
  assert.equal(
    annotations.addStroke({ tool: 'pen', points: line(MAX_ANNOTATION_POINTS_PER_STROKE + 1) }, GUEST).reason,
    'too_many_points',
  );
});

/* ------------------------------------------------------------------ */
/* WebSocket end-to-end                                                */
/* ------------------------------------------------------------------ */

let ts: TestServer;
let roomId: string;
let hostToken: string;
let guestToken: string;
let modToken: string;

before(async () => {
  ts = await startTestServer();
  // Replace the tenant config with a full valid document: the feature flags are
  // deep-merged over the current defaults (a PATCH only carries a partial tree).
  const current = (await ts.api('GET', '/v1/tenants/demo/config')).body.config;
  const updated = await ts.api('PUT', '/v1/tenants/demo/config', {
    headers: ADMIN,
    body: { ...current, features: { ...current.features, whiteboard: true, annotations: true } },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const created = await ts.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Whiteboard room', maxParticipants: 10 } });
  roomId = created.body.room.id;
  const token = async (name: string, role: 'host' | 'moderator' | 'guest'): Promise<string> =>
    (
      await ts.api('POST', '/v1/tokens', {
        headers: ADMIN,
        body: { tenantId: 'demo', roomId, participant: { name, role } },
      })
    ).body.token;
  hostToken = await token('Host', 'host');
  guestToken = await token('Guest', 'guest');
  modToken = await token('Mod', 'moderator');
});

after(async () => {
  await ts.close();
});

test('ws whiteboard: open, broadcast, replay on join, guest cannot clear/close', async () => {
  const host = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(hostToken)}`);
  const guest = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guestToken)}`);
  await host.waitFor((message) => message.type === 'welcome');
  await guest.waitFor((message) => message.type === 'welcome');

  // Joining is enough to get a snapshot (bounded, no strokes yet).
  const mod = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(modToken)}`);
  const modWelcome = await mod.waitFor((message) => message.type === 'welcome');
  assert.deepEqual(modWelcome.whiteboard?.strokes, []);

  const opened = host.waitFor((message) => message.type === 'whiteboard.open');
  const syncedOnGuest = guest.waitFor((message) => message.type === 'whiteboard.sync' && message.reason === 'open');
  guest.send({ type: 'whiteboard.open' });
  const openEvent = await opened;
  assert.equal(openEvent.by.role, 'guest');
  const snapshot = (await syncedOnGuest).snapshot;
  assert.equal(snapshot.open, true);
  assert.equal(snapshot.locked, false);

  const strokeOnHost = host.waitFor((message) => message.type === 'whiteboard.stroke');
  guest.send({
    type: 'whiteboard.stroke',
    id: 'guest-stroke-1',
    tool: 'pen',
    color: '#3b82f6',
    width: 0.006,
    points: [
      { x: 0.1, y: 0.2 },
      { x: 0.2, y: 0.3 },
    ],
  });
  const strokeEvent = await strokeOnHost;
  assert.equal(strokeEvent.stroke.authorName, 'Guest');
  assert.equal(strokeEvent.stroke.points.length, 2);
  assert.equal(strokeEvent.stroke.color, '#3b82f6');
  // The author also gets the server-assigned stroke (optimistic draw dedupes by id).
  const ack = await guest.waitFor((message) => message.type === 'whiteboard.stroke' && message.stroke.id === 'guest-stroke-1');
  assert.equal(ack.stroke.seq, 1);

  // Retry with the same id: no duplicate stroke, snapshot ack instead.
  guest.send({ type: 'whiteboard.stroke', id: 'guest-stroke-1', tool: 'pen', points: [{ x: 0.9, y: 0.9 }] });
  const retrySnapshot = await guest.waitFor((message) => message.type === 'whiteboard.sync' && message.reason === 'request');
  assert.equal(retrySnapshot.snapshot.strokes.length, 1);

  // A late joiner replays the room snapshot from `welcome`.
  const late = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(modToken)}`);
  const lateWelcome = await late.waitFor((message) => message.type === 'welcome');
  assert.equal(lateWelcome.whiteboard?.strokes.length, 1);
  assert.equal(lateWelcome.whiteboard?.strokes[0]?.authorName, 'Guest');

  // Guests may undo only their own last stroke, never clear or close.
  guest.send({ type: 'whiteboard.stroke', tool: 'clear' });
  const deniedClear = await guest.waitFor(
    (message) => message.type === 'error' && message.message.includes('clear the whiteboard'),
  );
  assert.equal(deniedClear.code, 'unauthorized');

  guest.send({ type: 'whiteboard.close', reason: 'nope' });
  const deniedClose = await guest.waitFor(
    (message) => message.type === 'error' && message.message.includes('close the whiteboard'),
  );
  assert.equal(deniedClose.code, 'unauthorized');

  const undoSnapshot = host.waitFor((message) => message.type === 'whiteboard.sync' && message.reason === 'undo');
  guest.send({ type: 'whiteboard.stroke', tool: 'undo' });
  assert.equal((await undoSnapshot).snapshot.strokes.length, 0);

  // Host close locks the board for guests; a manager may reopen it.
  const closeEvent = host.waitFor((message) => message.type === 'whiteboard.close');
  const closeSnapshot = guest.waitFor((message) => message.type === 'whiteboard.sync' && message.reason === 'close');
  host.send({ type: 'whiteboard.close', reason: 'moving on' });
  assert.equal((await closeEvent).reason, 'moving on');
  const locked = (await closeSnapshot).snapshot;
  assert.equal(locked.open, false);
  assert.equal(locked.locked, true);

  guest.send({ type: 'whiteboard.open' });
  const lockedDenied = await guest.waitFor(
    (message) => message.type === 'error' && message.message.includes('closed by the host'),
  );
  assert.equal(lockedDenied.code, 'unauthorized');
  guest.messages.length = 0;
  guest.send({ type: 'whiteboard.stroke', tool: 'pen', points: [{ x: 0.5, y: 0.5 }] });
  const strokeDenied = await guest.waitFor(
    (message) => message.type === 'error' && message.message.includes('closed by the host'),
  );
  assert.equal(strokeDenied.code, 'unauthorized');

  // Buffer resets keep stale frames from resolving the next waitFor.
  guest.messages.length = 0;
  host.messages.length = 0;
  host.send({ type: 'whiteboard.open' });
  const reopened = await guest.waitFor((message) => message.type === 'whiteboard.sync' && message.reason === 'open');
  assert.equal(reopened.snapshot.open, true);
  assert.equal(reopened.snapshot.locked, false);
  // Host clear: broadcast snapshot with reason `clear`, then audit.
  const beforeClear = host.waitFor(
    (message) => message.type === 'whiteboard.stroke' && message.stroke.id === 'pre-clear-stroke',
  );
  guest.send({ type: 'whiteboard.stroke', id: 'pre-clear-stroke', tool: 'pen', points: [{ x: 0.4, y: 0.4 }] });
  await beforeClear;
  const cleared = guest.waitFor((message) => message.type === 'whiteboard.sync' && message.reason === 'clear');
  host.send({ type: 'whiteboard.stroke', tool: 'clear' });
  assert.equal((await cleared).snapshot.strokes.length, 0);
  const audit = await ts.api('GET', '/v1/admin/audit?limit=200', { headers: ADMIN });
  const types = audit.body.entries.map((entry: { type: string }) => entry.type);
  for (const expected of ['whiteboard.opened', 'whiteboard.cleared', 'whiteboard.closed']) {
    assert.ok(types.includes(expected), `missing audit ${expected}`);
  }
  // The audit `type` filter knows the new event types (not a 400).
  const filteredAudit = await ts.api('GET', '/v1/admin/audit?type=whiteboard.cleared&limit=10', { headers: ADMIN });
  assert.equal(filteredAudit.status, 200, JSON.stringify(filteredAudit.body));
  assert.ok(filteredAudit.body.entries.length >= 1);
  assert.ok(filteredAudit.body.entries.every((entry: { type: string }) => entry.type === 'whiteboard.cleared'));

  // Validation over the wire: points are required for pen, limits are enforced.
  guest.send({ type: 'whiteboard.stroke', tool: 'pen' });
  const badStroke = await guest.waitFor((message) => message.type === 'error' && message.message.includes('Invalid whiteboard stroke'));
  assert.equal(badStroke.code, 'bad_request');
  guest.send({
    type: 'whiteboard.stroke',
    tool: 'pen',
    points: Array.from({ length: MAX_WHITEBOARD_POINTS_PER_STROKE }, (_, index) => ({
      x: Math.min(1, index / MAX_WHITEBOARD_POINTS_PER_STROKE),
      y: 0.123456789012345,
    })),
  });
  const tooLarge = await guest.waitFor((message) => message.type === 'error' && message.message.includes('too_large'));
  assert.equal(tooLarge.code, 'bad_request');

  await host.close();
  await guest.close();
  await late.close();
  await mod.close();
});

test('ws annotations: presenter lifecycle, guest draw, presenter/moderator clear', async () => {
  const host = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(hostToken)}`);
  const guest = await openWs(`${ts.wsUrl}?token=${encodeURIComponent(guestToken)}`);
  const hostWelcome = await host.waitFor((message) => message.type === 'welcome');
  await guest.waitFor((message) => message.type === 'welcome');

  // Host starts sharing: the presenter is set and the layer resets.
  const clearedOnStart = guest.waitFor((message) => message.type === 'annotation.clear');
  host.send({ type: 'state', state: { screen: true } });
  const startedClear = await clearedOnStart;
  assert.equal(startedClear.reason, 'presenter_changed');
  assert.equal(startedClear.presenterId, hostWelcome.self.id);
  const annotationSync = await guest.waitFor((message) => message.type === 'annotation.sync');
  assert.equal(annotationSync.snapshot.presenterId, hostWelcome.self.id);

  const strokeOnHost = host.waitFor((message) => message.type === 'annotation.stroke');
  guest.send({
    type: 'annotation.stroke',
    id: 'anno-1',
    tool: 'pen',
    color: '#22c55e',
    points: [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.8 },
    ],
  });
  const annotation = await strokeOnHost;
  assert.equal(annotation.stroke.authorName, 'Guest');
  assert.equal(annotation.stroke.points.length, 2);

  // A guest cannot wipe the layer; the presenter and moderators can.
  guest.send({ type: 'annotation.clear' });
  const denied = await guest.waitFor(
    (message) => message.type === 'error' && message.message.includes('clear annotations'),
  );
  assert.equal(denied.code, 'unauthorized');

  const clearOnGuest = guest.waitFor((message) => message.type === 'annotation.clear' && message.by);
  host.send({ type: 'annotation.clear' });
  const clearEvent = await clearOnGuest;
  assert.equal(clearEvent.by.name, 'Host');

  // Stopping the share wipes the annotation layer.
  host.send({ type: 'annotation.stroke', tool: 'pen', points: [{ x: 0.3, y: 0.3 }] });
  await host.waitFor((message) => message.type === 'annotation.stroke' && message.stroke.points.length === 1);
  const endClear = guest.waitFor((message) => message.type === 'annotation.clear' && message.reason === 'share_ended');
  host.send({ type: 'state', state: { screen: false } });
  const ended = await endClear;
  assert.equal(ended.presenterId, null);
  guest.send({ type: 'annotation.stroke', tool: 'pen', points: [{ x: 0.4, y: 0.4 }] });
  const noShare = await guest.waitFor(
    (message) => message.type === 'error' && message.message.includes('No active screen share'),
  );
  assert.equal(noShare.code, 'bad_request');

  const audit = await ts.api('GET', '/v1/admin/audit?limit=200', { headers: ADMIN });
  assert.ok(audit.body.entries.some((entry: { type: string }) => entry.type === 'annotation.cleared'));

  await host.close();
  await guest.close();
});

test('ws whiteboard: disabled feature is rejected and omitted from welcome', async () => {
  const local = await startTestServer();
  try {
    const created = await local.api('POST', '/v1/admin/rooms', { headers: ADMIN, body: { name: 'Disabled board' } });
    const localRoom = created.body.room.id;
    const token = (
      await local.api('POST', '/v1/tokens', {
        headers: ADMIN,
        body: { tenantId: 'demo', roomId: localRoom, participant: { name: 'Guest' } },
      })
    ).body.token;
    const client = await openWs(`${local.wsUrl}?token=${encodeURIComponent(token)}`);
    const welcome = await client.waitFor((message) => message.type === 'welcome');
    assert.equal(welcome.whiteboard, undefined, 'feature off → no whiteboard snapshot');
    assert.equal(welcome.annotations, undefined, 'feature off → no annotations snapshot');
    client.send({ type: 'whiteboard.open' });
    const denied = await client.waitFor((message) => message.type === 'error' && message.message.includes('Whiteboard is disabled'));
    assert.equal(denied.code, 'unauthorized');
    client.send({ type: 'annotation.stroke', tool: 'pen', points: [{ x: 0.5, y: 0.5 }] });
    const annotationsDenied = await client.waitFor(
      (message) => message.type === 'error' && message.message.includes('Annotations are disabled'),
    );
    assert.equal(annotationsDenied.code, 'unauthorized');
    await client.close();
  } finally {
    await local.close();
  }
});
