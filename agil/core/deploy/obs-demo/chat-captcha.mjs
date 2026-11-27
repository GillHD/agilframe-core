import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const chatCaptchaAction = 'obs_chat';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const PASS_MS = 10 * 60_000;
const TOKEN_MS = 5 * 60_000;
const MAX_TOKENS = 50_000;

export function createChatCaptcha({ siteKey, secret, hostnames, fetcher = fetch, clock = Date.now }) {
  if (!siteKey && !secret) return undefined;
  if (!siteKey || !secret || !hostnames?.size) throw new Error('OBS Turnstile needs site key, secret and allowed hostnames');
  const signingKey = randomBytes(32);
  const used = new Map();
  let inFlight = 0;
  const signature = (binding, expires) => createHmac('sha256', signingKey).update(JSON.stringify([binding, expires])).digest();

  return {
    settings: { siteKey, action: chatCaptchaAction },
    accepts(pass, binding) {
      if (typeof pass !== 'string' || !/^\d{1,16}\.[\w-]{43}$/.test(pass)) return false;
      const [expires, proof] = pass.split('.');
      const decoded = Buffer.from(proof, 'base64url');
      return decoded.length === 32 && Number(expires) > clock() && timingSafeEqual(decoded, signature(binding, expires));
    },
    async verify(token, binding) {
      if (typeof token !== 'string' || token.length > 2048 || !token.trim()) return { status: 'required' };
      const now = clock();
      for (const [digest, expires] of used) {
        if (expires > now) break;
        used.delete(digest);
      }
      const digest = createHash('sha256').update(token).digest('base64url');
      if (used.has(digest)) return { status: 'invalid' };
      if (inFlight >= 32 || used.size >= MAX_TOKENS) return { status: 'unavailable' };
      used.set(digest, now + TOKEN_MS);
      inFlight += 1;
      try {
        const response = await fetcher(SITEVERIFY, {
          method: 'POST', body: new URLSearchParams({ secret, response: token }),
          signal: AbortSignal.timeout(4000), redirect: 'error',
        });
        if (!response.ok) { await response.body?.cancel(); return { status: 'unavailable' }; }
        const result = await response.json();
        if (result['error-codes']?.includes('internal-error') || result['error-codes']?.includes('invalid-input-secret')) {
          return { status: 'unavailable' };
        }
        if (result.success !== true || result.action !== chatCaptchaAction || !hostnames.has(result.hostname)) return { status: 'invalid' };
        const expires = String(clock() + PASS_MS);
        return { status: 'verified', pass: `${expires}.${signature(binding, expires).toString('base64url')}` };
      } catch {
        return { status: 'unavailable' };
      } finally { inFlight -= 1; }
    },
  };
}
