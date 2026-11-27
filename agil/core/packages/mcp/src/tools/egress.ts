/**
 * Egress / RTMP / HLS tools (backend contract: /v1/rooms/:id/egress/*,
 * /v1/admin/egress/status).
 *
 * Read: egress_status (worker), egress_list (room sessions).
 * Write: start recording / RTMP / HLS, stop. RTMP URLs and stream keys are
 * redacted from tool results and never logged.
 */
import { z } from 'zod';
import { ApiError, ServerUnavailableError } from '../http-client.js';
import { defineTool, jsonOutcome, ToolError, type AnyToolSpec, type ToolContext } from '../tool-kit.js';

const roomIdSchema = z.string().min(1).max(128).describe('Room id');
const rtmpUrlSchema = z
  .string()
  .min(8)
  .max(1000)
  .describe('RTMP ingest URL (rtmp:// or rtmps://); never echoed in results')
  .refine((value) => /^rtmps?:\/\//i.test(value), 'RTMP URL must start with rtmp:// or rtmps://');

const stopSchema = z.object({
  roomId: roomIdSchema,
  sessionId: z.string().min(1).max(128).optional().describe('Stop one session; omit to stop all egress sessions of the room'),
});

const SENSITIVE_KEY = /^(url|rtmpUrl|hlsUrl|playbackUrl|streamKey|stream_key|key|token|secret|password)$/i;
const URL_IN_TEXT = /(rtmps?:\/\/|https?:\/\/)[^\s"'<>]+/gi;

/** Recursively redacts URLs/stream keys from backend payloads before returning them to the model. */
function redactEgress(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactEgress(entry));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactEgress(entry);
    }
    return result;
  }
  if (typeof value === 'string') return value.replace(URL_IN_TEXT, '[redacted-url]');
  return value;
}

function egressFailure(error: unknown, action: string): never {
  if (error instanceof ServerUnavailableError) {
    throw new ToolError(
      `${action}: сервер egress недоступен (${error.reason}).`,
      'Проверьте AGIL_SERVER_URL и доступность сервера; egress endpoints — /v1/rooms/:id/egress/*.',
    );
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      throw new ToolError(`${action}: нет прав на egress (${error.status}).`, 'Нужен административный ключ тенанта; проверьте AGIL_API_KEY.');
    }
    if (error.status === 404) {
      throw new ToolError(`${action}: комната или egress-сессия не найдены (404).`, 'Проверьте roomId, вызовите egress_list.');
    }
    if (error.status === 409) {
      throw new ToolError(`${action}: egress уже запущен или остановлен (409).`, 'Сначала проверьте egress_list/egress_status.');
    }
    if (error.status === 501) {
      throw new ToolError(`${action}: egress-воркер не настроен на сервере (501).`, 'Задайте provider/egress-воркер в mediaProcessing; см. egress_status.');
    }
    if (error.status === 400) {
      throw new ToolError(`${action}: сервер отклонил параметры egress (400).`, 'Проверьте kind/rtmpUrl: RTMP — rtmp(s)://, HLS — поддержан сервером.');
    }
    throw new ToolError(`${action}: сервер вернул ошибку egress ${error.status}.`, 'Проверьте egress_status и доступность воркера.');
  }
  throw error;
}

function requireAdminAction(_action: string): void {
  // Auth is enforced by the server (x-api-key); the MCP never sends RTMP data to logs.
}

function normalizeList(payload: unknown, roomId: string): Record<string, unknown> {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : Array.isArray(raw.active) ? raw.active : [];
  return {
    roomId,
    configured: typeof raw.configured === 'boolean' ? raw.configured : undefined,
    workerConfigured: typeof raw.workerConfigured === 'boolean' ? raw.workerConfigured : undefined,
    sessions: redactEgress(sessions),
    ...(typeof raw.detail === 'string' ? { detail: String(redactEgress(raw.detail)) } : {}),
  };
}

async function startEgress(
  ctx: ToolContext,
  roomId: string,
  body: Record<string, unknown>,
  label: string,
): Promise<Record<string, unknown>> {
  requireAdminAction(label);
  try {
    const payload = await ctx.client.post<unknown>(`/v1/rooms/${encodeURIComponent(roomId)}/egress/start`, body);
    return { started: true, roomId, kind: body.kind, result: redactEgress(payload) };
  } catch (error) {
    egressFailure(error, label);
  }
}

export function egressToolSpecs(): AnyToolSpec[] {
  return [
    defineTool({
      name: 'egress_status',
      title: 'Egress worker status',
      description:
        'Read the server egress worker status via GET /v1/admin/egress/status: configured/workerConfigured/detail. Read-only. ' +
        'Use it before starting recording/RTMP/HLS to verify the worker is configured.',
      online: true,
      inputSchema: z.object({}),
      handler: async (_args, ctx) => {
        try {
          const payload = await ctx.client.get<unknown>('/v1/admin/egress/status');
          return jsonOutcome(redactEgress(payload));
        } catch (error) {
          egressFailure(error, 'Статус egress');
        }
      },
    }),

    defineTool({
      name: 'egress_list',
      title: 'List room egress sessions',
      description:
        'List egress sessions of a room via GET /v1/rooms/:roomId/egress/list (fallback: /egress): sessions with kind/status/startedAt; ' +
        'URLs and stream keys are redacted. Read-only.',
      online: true,
      inputSchema: z.object({ roomId: roomIdSchema }),
      handler: async (args, ctx) => {
        try {
          const payload = await ctx.client.get<unknown>(`/v1/rooms/${encodeURIComponent(args.roomId)}/egress/list`);
          return jsonOutcome(normalizeList(payload, args.roomId));
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            try {
              const payload = await ctx.client.get<unknown>(`/v1/rooms/${encodeURIComponent(args.roomId)}/egress`);
              return jsonOutcome(normalizeList(payload, args.roomId));
            } catch (fallbackError) {
              egressFailure(fallbackError, 'Список egress');
            }
          }
          egressFailure(error, 'Список egress');
        }
      },
    }),

    defineTool({
      name: 'egress_start_recording',
      title: 'Start room egress recording',
      description: 'Start room recording via POST /v1/rooms/:roomId/egress/start with {kind:"recording"}. Write tool; excluded in read-only mode.',
      online: true,
      write: true,
      inputSchema: z.object({ roomId: roomIdSchema }),
      handler: async (args, ctx) => {
        const result = await startEgress(ctx, args.roomId, { kind: 'recording' }, 'Старт egress-записи');
        return jsonOutcome(result);
      },
    }),

    defineTool({
      name: 'egress_start_rtmp',
      title: 'Start RTMP egress',
      description:
        'Start RTMP egress via POST /v1/rooms/:roomId/egress/start with {kind:"rtmp", rtmpUrl}. The RTMP URL/stream key is never echoed in results. ' +
        'Write tool; requires rtmp(s):// URL; excluded in read-only mode.',
      online: true,
      write: true,
      inputSchema: z.object({ roomId: roomIdSchema, rtmpUrl: rtmpUrlSchema }),
      handler: async (args, ctx) => {
        const result = await startEgress(ctx, args.roomId, { kind: 'rtmp', rtmpUrl: args.rtmpUrl }, 'Старт RTMP egress');
        return jsonOutcome(result);
      },
    }),

    defineTool({
      name: 'egress_start_hls',
      title: 'Start HLS egress',
      description: 'Start HLS egress via POST /v1/rooms/:roomId/egress/start with {kind:"hls"}. Write tool; excluded in read-only mode.',
      online: true,
      write: true,
      inputSchema: z.object({ roomId: roomIdSchema }),
      handler: async (args, ctx) => {
        const result = await startEgress(ctx, args.roomId, { kind: 'hls' }, 'Старт HLS egress');
        return jsonOutcome(result);
      },
    }),

    defineTool({
      name: 'egress_stop',
      title: 'Stop room egress',
      description:
        'Stop egress via POST /v1/rooms/:roomId/egress/stop with optional sessionId; omit sessionId to stop all room egress sessions. ' +
        'Write tool; excluded in read-only mode.',
      online: true,
      write: true,
      inputSchema: stopSchema,
      handler: async (args, ctx) => {
        try {
          const body = args.sessionId ? { sessionId: args.sessionId } : {};
          const payload = await ctx.client.post<unknown>(`/v1/rooms/${encodeURIComponent(args.roomId)}/egress/stop`, body);
          return jsonOutcome({
            stopped: true,
            roomId: args.roomId,
            ...(args.sessionId ? { sessionId: args.sessionId } : { all: true }),
            result: redactEgress(payload),
          });
        } catch (error) {
          egressFailure(error, 'Остановка egress');
        }
      },
    }),
  ];
}
