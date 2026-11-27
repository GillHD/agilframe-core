/**
 * Per-room whiteboard and screen-share annotation state (optional).
 *
 * Everything lives in memory for the duration of the call; there is no
 * persistence. Memory guards (all server-enforced):
 *  - strokes per board/annotation layer are capped (`MAX_*_STROKES`), oldest
 *    evicted first;
 *  - points per stroke and total points per layer are capped;
 *  - one stroke's serialized point payload is capped in bytes.
 *
 * Permissions (clear/close, annotation clear) are enforced by the signaling
 * layer; this module only owns state + limits so it can be unit-tested with
 * plain objects.
 */
import {
  MAX_ANNOTATION_POINTS_PER_STROKE,
  MAX_ANNOTATION_STROKE_BYTES,
  MAX_ANNOTATION_STROKES,
  MAX_ANNOTATION_TOTAL_POINTS,
  MAX_WHITEBOARD_POINTS_PER_STROKE,
  MAX_WHITEBOARD_STROKE_BYTES,
  MAX_WHITEBOARD_STROKES,
  MAX_WHITEBOARD_TOTAL_POINTS,
  WHITEBOARD_DEFAULT_COLOR,
  WHITEBOARD_DEFAULT_WIDTH,
  normalizeWhiteboardPoint,
  strokePointsBytes,
  type AnnotationSnapshot,
  type AnnotationStroke,
  type WhiteboardAuthor,
  type WhiteboardPoint,
  type WhiteboardSnapshot,
  type WhiteboardStroke,
} from '@agil/protocol';

export type DrawingTool = 'pen' | 'eraser';

export interface StrokeInput {
  id?: string;
  tool: DrawingTool;
  color?: string;
  width?: number;
  points: WhiteboardPoint[];
}

export type AddStrokeReason = 'invalid_points' | 'too_many_points' | 'too_large' | 'no_presenter';

export interface AddStrokeResult<T> {
  ok: boolean;
  reason?: AddStrokeReason;
  stroke?: T;
  /** The same client id was already stored: the frame is a retry, nothing changed. */
  duplicate?: boolean;
  /** Old strokes were evicted to stay inside the limits. */
  trimmed?: boolean;
}

export interface SnapshotResult<T> {
  snapshot: T;
  changed: boolean;
}

function cleanPoints(raw: WhiteboardPoint[], maxPoints: number): WhiteboardPoint[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxPoints) return null;
  const points: WhiteboardPoint[] = [];
  for (const point of raw) {
    const normalized = normalizeWhiteboardPoint(point?.x, point?.y);
    if (!normalized) return null;
    const previous = points[points.length - 1];
    // Drop duplicate consecutive samples (touch devices often emit them).
    if (previous && previous.x === normalized.x && previous.y === normalized.y) continue;
    points.push(normalized);
  }
  return points.length > 0 ? points : null;
}

function clampWidth(width: number | undefined): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return WHITEBOARD_DEFAULT_WIDTH;
  return width;
}

/* ------------------------------------------------------------------ */
/* Whiteboard                                                          */
/* ------------------------------------------------------------------ */

export class RoomWhiteboard {
  private readonly roomId: string;
  private strokes: WhiteboardStroke[] = [];
  private readonly ids = new Set<string>();
  private seq = 0;
  private revision = 0;
  private openFlag = false;
  private lockedFlag = false;
  private updatedAtMs = 0;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  get open(): boolean {
    return this.openFlag;
  }

  /** Host/moderator closed the board: only they may reopen it. */
  get locked(): boolean {
    return this.lockedFlag;
  }

  get strokeCount(): number {
    return this.strokes.length;
  }

  get totalPoints(): number {
    let total = 0;
    for (const stroke of this.strokes) total += stroke.points.length;
    return total;
  }

  openBoard(): SnapshotResult<WhiteboardSnapshot> {
    const changed = !this.openFlag || this.lockedFlag;
    this.openFlag = true;
    this.lockedFlag = false;
    if (changed) this.bump();
    return { snapshot: this.snapshot(), changed };
  }

  closeBoard(): SnapshotResult<WhiteboardSnapshot> {
    const changed = this.openFlag || !this.lockedFlag;
    this.openFlag = false;
    this.lockedFlag = true;
    if (changed) this.bump();
    return { snapshot: this.snapshot(), changed };
  }

  addStroke(input: StrokeInput, author: WhiteboardAuthor, ts = Date.now()): AddStrokeResult<WhiteboardStroke> {
    if (input.id && this.ids.has(input.id)) {
      return { ok: true, duplicate: true, stroke: this.strokes.find((stroke) => stroke.id === input.id) };
    }
    if (input.points.length > MAX_WHITEBOARD_POINTS_PER_STROKE) return { ok: false, reason: 'too_many_points' };
    const points = cleanPoints(input.points, MAX_WHITEBOARD_POINTS_PER_STROKE);
    if (!points) return { ok: false, reason: 'invalid_points' };
    if (strokePointsBytes(points) > MAX_WHITEBOARD_STROKE_BYTES) return { ok: false, reason: 'too_large' };
    const stroke: WhiteboardStroke = {
      id: input.id && input.id.length > 0 ? input.id : `wb-${this.roomId}-${this.seq + 1}`,
      seq: this.seq + 1,
      tool: input.tool,
      color: input.color ?? WHITEBOARD_DEFAULT_COLOR,
      width: clampWidth(input.width),
      points,
      authorId: author.id,
      authorName: author.name,
      ts,
    };
    this.seq += 1;
    this.strokes.push(stroke);
    this.ids.add(stroke.id);
    const trimmed = this.trim();
    // Drawing on a closed board makes it live again (the stroke broadcast
    // implicitly tells clients the board is open).
    this.openFlag = true;
    this.bump();
    return { ok: true, stroke, trimmed };
  }

  /** Removes the caller's own last stroke (self-undo); returns what was removed. */
  undo(authorId: string): { removedIds: string[]; snapshot: WhiteboardSnapshot; changed: boolean } {
    let removedIds: string[] = [];
    for (let index = this.strokes.length - 1; index >= 0; index -= 1) {
      if (this.strokes[index]?.authorId !== authorId) continue;
      removedIds = [this.strokes[index]!.id];
      this.strokes.splice(index, 1);
      break;
    }
    if (removedIds.length > 0) {
      for (const id of removedIds) this.ids.delete(id);
      this.bump();
    }
    return { removedIds, snapshot: this.snapshot(), changed: removedIds.length > 0 };
  }

  clear(): { removed: number; snapshot: WhiteboardSnapshot; changed: boolean } {
    const removed = this.strokes.length;
    if (removed > 0) {
      this.strokes = [];
      this.ids.clear();
      this.bump();
    }
    return { removed, snapshot: this.snapshot(), changed: removed > 0 };
  }

  snapshot(now = Date.now()): WhiteboardSnapshot {
    return {
      roomId: this.roomId,
      open: this.openFlag,
      locked: this.lockedFlag,
      strokes: this.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })),
      revision: this.revision,
      updatedAt: this.updatedAtMs,
      ts: now,
    };
  }

  private bump(): void {
    this.revision += 1;
    this.updatedAtMs = Date.now();
  }

  /** Evicts the oldest strokes until both the stroke and the point caps hold. */
  private trim(): boolean {
    let trimmed = false;
    while (
      this.strokes.length > MAX_WHITEBOARD_STROKES ||
      (this.totalPoints > MAX_WHITEBOARD_TOTAL_POINTS && this.strokes.length > 1)
    ) {
      const evicted = this.strokes.shift();
      if (!evicted) break;
      this.ids.delete(evicted.id);
      trimmed = true;
    }
    return trimmed;
  }
}

/* ------------------------------------------------------------------ */
/* Screen-share annotations                                            */
/* ------------------------------------------------------------------ */

export class RoomAnnotations {
  private readonly roomId: string;
  private strokes: AnnotationStroke[] = [];
  private readonly ids = new Set<string>();
  private seq = 0;
  private revision = 0;
  private presenter: string | null = null;
  private updatedAtMs = 0;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  get presenterId(): string | null {
    return this.presenter;
  }

  get strokeCount(): number {
    return this.strokes.length;
  }

  get totalPoints(): number {
    let total = 0;
    for (const stroke of this.strokes) total += stroke.points.length;
    return total;
  }

  /**
   * Registers the current presenter. Annotations belong to one screen share:
   * when the presenter changes or stops sharing, the layer is wiped.
   */
  setPresenter(presenterId: string | null): { changed: boolean; cleared: boolean } {
    const next = presenterId && presenterId.length > 0 ? presenterId : null;
    if (next === this.presenter) return { changed: false, cleared: false };
    const cleared = this.strokes.length > 0;
    this.presenter = next;
    this.strokes = [];
    this.ids.clear();
    this.bump();
    return { changed: true, cleared };
  }

  addStroke(input: StrokeInput, author: WhiteboardAuthor, ts = Date.now()): AddStrokeResult<AnnotationStroke> {
    if (!this.presenter) return { ok: false, reason: 'no_presenter' };
    if (input.points.length > MAX_ANNOTATION_POINTS_PER_STROKE) return { ok: false, reason: 'too_many_points' };
    const points = cleanPoints(input.points, MAX_ANNOTATION_POINTS_PER_STROKE);
    if (!points) return { ok: false, reason: 'invalid_points' };
    if (strokePointsBytes(points) > MAX_ANNOTATION_STROKE_BYTES) return { ok: false, reason: 'too_large' };
    if (input.id && this.ids.has(input.id)) {
      return { ok: true, duplicate: true, stroke: this.strokes.find((stroke) => stroke.id === input.id) };
    }
    const stroke: AnnotationStroke = {
      id: input.id && input.id.length > 0 ? input.id : `an-${this.roomId}-${this.seq + 1}`,
      seq: this.seq + 1,
      tool: input.tool,
      color: input.color ?? WHITEBOARD_DEFAULT_COLOR,
      width: clampWidth(input.width),
      points,
      authorId: author.id,
      authorName: author.name,
      ts,
    };
    this.seq += 1;
    this.strokes.push(stroke);
    this.ids.add(stroke.id);
    const trimmed = this.trim();
    this.bump();
    return { ok: true, stroke, trimmed };
  }

  clear(): { removed: number; snapshot: AnnotationSnapshot; changed: boolean } {
    const removed = this.strokes.length;
    if (removed > 0) {
      this.strokes = [];
      this.ids.clear();
      this.bump();
    }
    return { removed, snapshot: this.snapshot(), changed: removed > 0 };
  }

  snapshot(now = Date.now()): AnnotationSnapshot {
    return {
      roomId: this.roomId,
      presenterId: this.presenter,
      strokes: this.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })),
      revision: this.revision,
      updatedAt: this.updatedAtMs,
      ts: now,
    };
  }

  private bump(): void {
    this.revision += 1;
    this.updatedAtMs = Date.now();
  }

  private trim(): boolean {
    let trimmed = false;
    while (
      this.strokes.length > MAX_ANNOTATION_STROKES ||
      (this.totalPoints > MAX_ANNOTATION_TOTAL_POINTS && this.strokes.length > 1)
    ) {
      const evicted = this.strokes.shift();
      if (!evicted) break;
      this.ids.delete(evicted.id);
      trimmed = true;
    }
    return trimmed;
  }
}
