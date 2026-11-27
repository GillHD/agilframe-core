import { z } from 'zod';
import type { Env } from './env.js';
import { signLiveKitToken } from './sfu.js';
import { pullSourceUrl, type PullIngressSource } from './ingress-sources.js';

type IngressEnv = Pick<Env, 'sfuControlUrl' | 'sfuEnabled' | 'sfuApiKey' | 'sfuApiSecret'>;

export interface IngressTarget {
  roomName: string;
  participantIdentity: string;
}

export interface IngressHandle extends IngressTarget {
  id: string;
}

export interface RtmpIngressCredentials {
  handle: IngressHandle;
  url: string;
  streamKey: string;
}

export type IngressStatus = 'waiting' | 'buffering' | 'publishing' | 'failed' | 'finished' | 'unknown';
type IngressInput = 'RTMP_INPUT' | 'URL_INPUT';

const ingressSchema = z.object({
  ingress_id: z.string().min(1).max(256),
  room_name: z.string().min(1),
  participant_identity: z.string().min(1),
  input_type: z.union([z.string(), z.number()]).optional(),
  state: z.object({ status: z.union([z.string(), z.number()]).optional() }).optional(),
});
const createdIngressSchema = ingressSchema.extend({
  url: z.string().min(1).max(2048),
  stream_key: z.string().regex(/^[A-Za-z0-9._~-]{1,512}$/),
});
const listIngressSchema = z.object({
  items: z.array(ingressSchema).nullish(),
  next_page_token: z.object({ token: z.string().max(2048).optional() }).nullish(),
}).strict();
const missingIngress = Symbol('missingIngress');
type IngressInfo = z.infer<typeof ingressSchema>;

function isTarget(info: IngressInfo, target: IngressTarget, input: IngressInput): boolean {
  const type = info.input_type ?? 0;
  return (type === input || type === (input === 'RTMP_INPUT' ? 0 : 2))
    && info.room_name === target.roomName && info.participant_identity === target.participantIdentity;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function rtmpControlEndpoint(env: IngressEnv): URL | null {
  const { sfuEnabled, sfuControlUrl, sfuApiKey, sfuApiSecret } = env;
  const endpoint = parseUrl(sfuControlUrl);
  if (!sfuEnabled || !sfuApiKey || !sfuApiSecret || !endpoint || !['http:', 'https:'].includes(endpoint.protocol)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  return endpoint;
}

export function ingressControlConfigured(env: IngressEnv): boolean {
  return rtmpControlEndpoint(env) !== null;
}

function isRtmpPublishUrl(raw: string): boolean {
  const url = parseUrl(raw);
  return Boolean(url?.hostname && ['rtmp:', 'rtmps:'].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash);
}

function providerStatus(status: string | number | undefined): IngressStatus {
  switch (status) {
    case undefined:
    case 0:
    case 'ENDPOINT_INACTIVE': return 'waiting';
    case 1:
    case 'ENDPOINT_BUFFERING': return 'buffering';
    case 2:
    case 'ENDPOINT_PUBLISHING': return 'publishing';
    case 3:
    case 'ENDPOINT_ERROR': return 'failed';
    case 4:
    case 'ENDPOINT_COMPLETE': return 'finished';
    default: return 'unknown';
  }
}

/** Operator-side driver. The caller owns authorization, durable handle storage and lifecycle locking. */
class LiveKitIngressClient {
  constructor(private readonly env: IngressEnv, private readonly input: IngressInput) {}

  async status(handle: IngressHandle): Promise<IngressStatus | null> {
    const info = await this.find(handle);
    return info ? providerStatus(info.state?.status) : null;
  }

  /** Reconciles an uncertain CreateIngress and returns only ownership fields from the provider list. */
  async findOwned(target: IngressTarget): Promise<IngressHandle | null> {
    if (!target.roomName || !target.participantIdentity) throw new Error('LiveKit Ingress target is incomplete');
    const ids = new Set<string>();
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.list({
        room_name: target.roomName,
        ...(pageToken ? { page_token: { token: pageToken } } : {}),
      });
      for (const item of page?.items ?? []) {
        if (isTarget(item, target, this.input)) ids.add(item.ingress_id);
      }
      if (ids.size > 1) throw new Error('LiveKit returned multiple RTMP receivers for the stored identity');
      pageToken = page?.next_page_token?.token;
      if (pageToken && (tokens.has(pageToken) || tokens.size >= 12)) {
        throw new Error('LiveKit Ingress listing did not finish');
      }
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    const [id] = ids;
    return id ? { id, roomName: target.roomName, participantIdentity: target.participantIdentity } : null;
  }

  async revoke(handle: IngressHandle): Promise<void> {
    if (!await this.find(handle)) return;
    await this.call('DeleteIngress', { ingress_id: handle.id });
  }

  private async find(handle: IngressHandle): Promise<IngressInfo | null> {
    const result = await this.list({ ingress_id: handle.id });
    if (result?.next_page_token?.token) throw new Error('LiveKit returned multiple pages for one Ingress ID');
    const items = result?.items ?? [];
    if (items.length === 0) return null;
    const item = items[0];
    if (items.length !== 1 || !item || item.ingress_id !== handle.id || !isTarget(item, handle, this.input)) {
      throw new Error('LiveKit Ingress does not match its stored room and participant');
    }
    return item;
  }

  private async list(body: object): Promise<z.infer<typeof listIngressSchema> | null> {
    const result = await this.call('ListIngress', body);
    if (result === missingIngress) return null;
    const response = listIngressSchema.safeParse(result);
    if (!response.success) throw new Error('LiveKit returned an invalid Ingress list');
    return response.data;
  }

  protected async call(method: 'CreateIngress' | 'ListIngress' | 'DeleteIngress', body: object): Promise<unknown> {
    const { sfuApiKey, sfuApiSecret } = this.env;
    const endpoint = rtmpControlEndpoint(this.env);
    if (!endpoint) {
      throw new Error('LiveKit Ingress requires an operator-configured SFU control URL and credentials');
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/twirp/livekit.Ingress/${method}`;
    const now = Math.floor(Date.now() / 1000);
    const grant = signLiveKitToken(sfuApiSecret, {
      iss: sfuApiKey, sub: 'agil-ingress-controller', nbf: now - 5, exp: now + 30,
      video: { ingressAdmin: true },
    });
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${grant}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
    } catch {
      throw new Error(`LiveKit ${method} is unavailable`);
    }
    if (!response.ok) {
      if (response.status === 404 && method !== 'CreateIngress') {
        const error = await response.json().catch(() => null) as { code?: unknown } | null;
        if (error?.code === 'not_found') return missingIngress;
      } else {
        await response.body?.cancel();
      }
      throw new Error(`LiveKit ${method} returned HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`LiveKit ${method} returned invalid JSON`);
    }
  }
}

export class RtmpIngressClient extends LiveKitIngressClient {
  constructor(env: IngressEnv) { super(env, 'RTMP_INPUT'); }

  async create(target: IngressTarget): Promise<RtmpIngressCredentials> {
    const response = createdIngressSchema.safeParse(await this.call('CreateIngress', {
      input_type: 'RTMP_INPUT',
      name: 'AGIL RTMP source',
      room_name: target.roomName,
      participant_identity: target.participantIdentity,
      participant_name: 'RTMP source',
    }));
    if (!response.success || !isTarget(response.data, target, 'RTMP_INPUT') || !isRtmpPublishUrl(response.data.url)) {
      throw new Error('LiveKit returned an invalid RTMP Ingress');
    }
    return {
      handle: { id: response.data.ingress_id, ...target },
      url: response.data.url,
      streamKey: response.data.stream_key,
    };
  }
}

export class PullIngressClient extends LiveKitIngressClient {
  constructor(env: IngressEnv, private readonly transport: 'srt' | 'hls') { super(env, 'URL_INPUT'); }

  async create(target: IngressTarget, binding: PullIngressSource): Promise<{ handle: IngressHandle }> {
    const label = this.transport.toUpperCase();
    const response = ingressSchema.safeParse(await this.call('CreateIngress', {
      input_type: 'URL_INPUT',
      url: pullSourceUrl(this.transport, binding),
      name: `AGIL ${label} source`,
      room_name: target.roomName,
      participant_identity: target.participantIdentity,
      participant_name: `${label} source`,
      video: { preset: 'H264_540P_25FPS_1_LAYER' },
    }));
    if (!response.success || !isTarget(response.data, target, 'URL_INPUT')) {
      throw new Error(`LiveKit returned an invalid ${label} Ingress`);
    }
    return { handle: { id: response.data.ingress_id, ...target } };
  }
}
