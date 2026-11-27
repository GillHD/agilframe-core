import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { roleSchema } from '@agil/protocol';
import { z } from 'zod';
import { assertRateLimit, buildRoomLinks, issueToken, requireApiKeyTenant } from './auth.js';
import { evaluateRoomCreateQuota, planParticipantCap, tenantUsageCounts } from './billing.js';
import { HttpError, requestOrigin, type RequestContext, type Router } from './http.js';
import type { LeaderElector } from './leader.js';
import { roomMediaMode } from './scale.js';
import { capRoomParticipantsForSfu } from './sfu.js';

const channelId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const title = z.string().trim().min(1).max(120);
const participantId = z.string().min(1).max(64).refine((id) => id === id.trim());
const member = z.object({ participantId, role: roleSchema, name: title.optional() }).strict();
const members = z.array(member).max(50_000).refine(
  (list) => new Set(list.map((entry) => entry.participantId)).size === list.length,
  'Participant identifiers must be unique within the channel',
);
const createSchema = z.object({ id: channelId, name: title, members }).strict();
const patchSchema = z.object({ name: title.optional(), members: members.optional() }).strict()
  .refine((value) => value.name !== undefined || value.members !== undefined, 'Specify a channel name or roster');
const grantSchema = z.object({ participantId, name: title.optional() }).strict();
const storedChannel = createSchema.extend({ revision: z.string().uuid(), createdAt: z.number(), updatedAt: z.number() });
const storedTenant = z.object({ tenantId: z.string(), channels: z.array(storedChannel) });

type Channel = z.infer<typeof storedChannel>;
type SharedStore = Pick<LeaderElector, 'readSharedValue' | 'leaderValue'>;
type Registry = { channels: Channel[]; save: (channels: Channel[]) => Promise<void> };

class VoiceChannelStore {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string, private readonly shared?: SharedStore) {}

  async list(tenantId: string): Promise<Channel[]> {
    const key = this.key(tenantId);
    const raw = this.shared ? await this.shared.readSharedValue(key) : this.readLocal(key);
    return this.parse(tenantId, raw);
  }

  // Serialize registry changes, room creation and grant issuance for one tenant on the leader.
  transact<T>(tenantId: string, operation: (registry: Registry) => Promise<T> | T): Promise<T> {
    const previous = this.pending.get(tenantId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const key = this.key(tenantId);
      const raw = this.shared ? (await this.shared.leaderValue(key)).value : this.readLocal(key);
      return operation({
        channels: this.parse(tenantId, raw),
        save: async (channels) => {
          const next = JSON.stringify({ tenantId, channels });
          if (this.shared) {
            if (!(await this.shared.leaderValue(key, { expected: raw, next })).changed) {
              throw new HttpError(409, 'voice_channel_conflict', 'Voice channels changed concurrently');
            }
          } else {
            this.writeLocal(key, next);
          }
        },
      });
    });
    this.pending.set(tenantId, run);
    void run.finally(() => {
      if (this.pending.get(tenantId) === run) this.pending.delete(tenantId);
    }).catch(() => undefined);
    return run;
  }

  private key(tenantId: string): string {
    return 'voice-channels-v1-' + createHash('sha256').update(tenantId).digest('hex');
  }

  private parse(tenantId: string, raw: string | null): Channel[] {
    if (raw === null) return [];
    try {
      const snapshot = storedTenant.parse(JSON.parse(raw));
      if (snapshot.tenantId === tenantId) return snapshot.channels;
    } catch { /* report a closed storage error without returning stored data */ }
    throw new HttpError(503, 'voice_channel_storage_unavailable', 'Could not read voice channels');
  }

  private readLocal(key: string): string | null {
    try {
      return readFileSync(path.join(this.directory, key + '.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new HttpError(503, 'voice_channel_storage_unavailable', 'Could not read voice channels');
    }
  }

  private writeLocal(key: string, content: string): void {
    const target = path.join(this.directory, key + '.json');
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, target);
    } catch {
      throw new HttpError(503, 'voice_channel_storage_unavailable', 'Could not save voice channels');
    } finally {
      try { rmSync(temp, { force: true }); } catch { /* the committed registry is authoritative */ }
    }
  }
}

function tenantFor(ctx: RequestContext): string {
  const tenantId = requireApiKeyTenant(ctx);
  assertRateLimit(ctx.services.limiters.admin.check('admin:' + tenantId), ctx, 'Too many admin requests');
  ctx.res.setHeader('cache-control', 'no-store');
  return tenantId;
}

function findChannel(channels: Channel[], id: string): Channel {
  const channel = channels.find((candidate) => candidate.id === id);
  if (!channel) throw new HttpError(404, 'not_found', 'Voice channel not found');
  return channel;
}

function sameRoster(left: Channel['members'], right: Channel['members']): boolean {
  if (left.length !== right.length) return false;
  const byId = new Map(left.map((member) => [member.participantId, member]));
  return right.every((member) => {
    const previous = byId.get(member.participantId);
    return previous?.role === member.role && previous.name === member.name;
  });
}

function runtimeRooms(ctx: RequestContext, tenantId: string, id: string) {
  return ctx.rooms.list(tenantId).filter((room) => room.voiceChannel?.id === id);
}

function closeChannelRooms(ctx: RequestContext, tenantId: string, id: string): void {
  for (const room of runtimeRooms(ctx, tenantId, id)) ctx.rooms.close(room.id, 'admin_closed');
}

function auditChannel(ctx: RequestContext, tenantId: string, id: string, action: string): void {
  try {
    ctx.services.audit.append({
      type: 'admin.action', severity: 'info', tenantId, ip: ctx.ip,
      message: 'Voice channel ' + action,
      details: { kind: 'voice_channel.' + action, channelId: id },
    });
  } catch { /* the registry operation has already committed */ }
}

function runtimeRoom(ctx: RequestContext, tenantId: string, channel: Channel) {
  const existing = runtimeRooms(ctx, tenantId, channel.id).find((room) => room.voiceChannel?.revision === channel.revision);
  if (existing && ctx.rooms.get(existing.id) === existing) return existing;
  const config = ctx.tenants.getConfig(tenantId);
  const counts = tenantUsageCounts(ctx.rooms, tenantId);
  const quota = evaluateRoomCreateQuota({
    billing: config.billing,
    usage: ctx.services.billing.getUsage(tenantId),
    liveMinutes: ctx.services.billing.liveMinutes(tenantId),
    activeRooms: counts.activeRooms,
  });
  if (!quota.allowed) throw new HttpError(429, 'quota_exceeded', quota.blocked?.message ?? 'Billing quota exceeded');
  const selected = roomMediaMode(config.scale, 'group');
  const mediaMode = selected === 'broadcast' ? 'sfu' : selected;
  return ctx.rooms.create({
    tenantId, name: channel.name, mode: 'group', mediaMode,
    ttlSec: ctx.env.roomTtlSec || 300,
    maxParticipants: capRoomParticipantsForSfu(ctx.env, config, mediaMode, planParticipantCap(config.billing, config.limits.maxParticipants)),
    configOverrides: { features: { breakoutRooms: false } },
    allowedParticipantIds: channel.members.map((entry) => entry.participantId),
    voiceChannel: { id: channel.id, revision: channel.revision },
  });
}

export function registerVoiceChannelRoutes(router: Router, directory: string, shared?: SharedStore): void {
  const store = new VoiceChannelStore(directory, shared);
  const base = '/v1/admin/voice-channels';

  router.get(base, async (ctx) => {
    const tenantId = tenantFor(ctx);
    ctx.send(200, { channels: await store.list(tenantId) });
  });

  router.get(base + '/:channelId', async (ctx) => {
    const tenantId = tenantFor(ctx);
    ctx.send(200, { channel: findChannel(await store.list(tenantId), ctx.params.channelId as string) });
  });

  router.post(base, async (ctx) => {
    const tenantId = tenantFor(ctx);
    const input = await ctx.jsonSchema(createSchema);
    const channel = await store.transact(tenantId, async ({ channels, save }) => {
      ctx.cluster.assertLeader('voice channel creation');
      if (channels.some((entry) => entry.id === input.id)) throw new HttpError(409, 'voice_channel_exists', 'Voice channel already exists');
      const created = { ...input, revision: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
      await save([...channels, created]);
      auditChannel(ctx, tenantId, created.id, 'created');
      return created;
    });
    ctx.send(201, { channel });
  });

  router.patch(base + '/:channelId', async (ctx) => {
    const tenantId = tenantFor(ctx);
    const input = await ctx.jsonSchema(patchSchema);
    const channel = await store.transact(tenantId, async ({ channels, save }) => {
      ctx.cluster.assertLeader('voice channel update');
      const previous = findChannel(channels, ctx.params.channelId as string);
      const rosterChanged = input.members !== undefined && !sameRoster(input.members, previous.members);
      const updated = { ...previous, ...input, revision: rosterChanged ? randomUUID() : previous.revision, updatedAt: Date.now() };
      await save(channels.map((entry) => entry === previous ? updated : entry));
      if (rosterChanged) closeChannelRooms(ctx, tenantId, updated.id);
      else for (const room of runtimeRooms(ctx, tenantId, updated.id)) room.name = updated.name;
      auditChannel(ctx, tenantId, updated.id, 'updated');
      return updated;
    });
    ctx.send(200, { channel });
  });

  router.delete(base + '/:channelId', async (ctx) => {
    const tenantId = tenantFor(ctx);
    await store.transact(tenantId, async ({ channels, save }) => {
      ctx.cluster.assertLeader('voice channel deletion');
      const channel = findChannel(channels, ctx.params.channelId as string);
      await save(channels.filter((entry) => entry !== channel));
      closeChannelRooms(ctx, tenantId, channel.id);
      auditChannel(ctx, tenantId, channel.id, 'deleted');
    });
    ctx.send(200, { deleted: true });
  });

  router.post(base + '/:channelId/join', async (ctx) => {
    const tenantId = tenantFor(ctx);
    const input = await ctx.jsonSchema(grantSchema);
    const grant = await store.transact(tenantId, ({ channels }) => {
      ctx.cluster.assertLeader('voice channel grant');
      const channel = findChannel(channels, ctx.params.channelId as string);
      const member = channel.members.find((entry) => entry.participantId === input.participantId);
      if (!member) throw new HttpError(403, 'forbidden', 'Participant is not assigned to this voice channel');
      const room = runtimeRoom(ctx, tenantId, channel);
      const { token, expiresAt } = issueToken(ctx.env, {
        tenantId, roomId: room.id, participantId: member.participantId,
        role: member.role, name: member.name ?? input.name ?? member.participantId,
        ttlSec: Math.min(ctx.env.tokenTtlSec, 300),
      });
      const links = buildRoomLinks(ctx.env, { tenantId, roomId: room.id, token }, requestOrigin(ctx, tenantId));
      return { channelId: channel.id, roomId: room.id, token, expiresAt, joinUrl: links.joinUrl };
    });
    ctx.send(200, grant);
  });
}
