import { createPublicKey, verify } from 'node:crypto';
import { open } from 'node:fs/promises';
import { assistantToolSchema } from '@agil/protocol';
import { z } from 'zod';
import type { Env } from './env.js';

const maxFileBytes = 16 * 1024;
const envelope = z.object({ payload: z.string().max(12000), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) });
const policySchema = z.strictObject({
  tenantId: z.string().min(1).max(128),
  endpoint: z.url().max(2048),
  version: z.string().regex(/^[A-Za-z0-9._-]{1,48}$/),
  environment: z.enum(['production', 'test']),
  expiresAt: z.iso.datetime(),
  allowedTools: z.array(assistantToolSchema).max(40),
  instructions: z.string().min(1).max(8000),
});
export type InCallSecurityPolicy = z.infer<typeof policySchema>;

/** Read the deployment-owned policy, checking both signature and endpoint binding. */
export async function readInCallSecurityPolicy(env: Env, tenantId: string, endpoint: string): Promise<InCallSecurityPolicy | undefined> {
  if (!env.inCallPolicyPath && !env.inCallPolicyPublicKey) return undefined;
  if (!env.inCallPolicyPath || !env.inCallPolicyPublicKey) throw new Error('Incomplete in-call policy configuration');

  const file = await open(env.inCallPolicyPath, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > maxFileBytes) throw new Error('Invalid policy file size');
    const buffer = Buffer.alloc(maxFileBytes + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > maxFileBytes) throw new Error('Invalid policy file size');
    const signed = envelope.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    const key = createPublicKey(env.inCallPolicyPublicKey.replaceAll('\\n', '\n'));
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(signed.payload), key, Buffer.from(signed.signature, 'base64'))) {
      throw new Error('Invalid policy signature');
    }
    const policy = policySchema.parse(JSON.parse(signed.payload));
    const target = new URL(policy.endpoint);
    if (policy.tenantId !== tenantId || target.href !== new URL(endpoint).href || target.username || target.password ||
        target.hash || Date.parse(policy.expiresAt) <= Date.now() ||
        (policy.environment === 'production' && target.protocol !== 'https:')) {
      throw new Error('Invalid or expired policy binding');
    }
    return policy;
  } finally {
    await file.close();
  }
}
