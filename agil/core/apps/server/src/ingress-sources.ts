import { isIP } from 'node:net';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

function privateIpv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const [first, second = 0] = host.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

const source = z.object({
  tenantId: id, sourceId: id, host: z.string().refine(privateIpv4), port: z.number().int().min(1).max(65535),
}).strict();

export type PullIngressSource = z.infer<typeof source>;

export function parseIngressSources(raw: string | undefined, name: string): PullIngressSource[] {
  if (!raw?.trim()) return [];
  let parsed: PullIngressSource[];
  try {
    parsed = z.array(source).parse(JSON.parse(raw));
  } catch {
    throw new Error(`${name} must contain tenantId, sourceId, private IPv4 host and numeric port`);
  }
  const keys = parsed.map((item) => JSON.stringify([item.tenantId, item.sourceId]));
  if (new Set(keys).size !== keys.length) throw new Error(`${name} contains duplicate tenant/source IDs`);
  return parsed;
}

export function pullSourceUrl(transport: 'srt' | 'hls', binding: PullIngressSource): string {
  const { host, port, tenantId, sourceId } = source.parse(binding);
  return transport === 'srt' ? `srt://${host}:${port}?mode=caller` : `http://${host}:${port}/sources/${tenantId}/${sourceId}/index.m3u8`;
}
