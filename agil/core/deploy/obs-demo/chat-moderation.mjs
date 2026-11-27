import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function createChatIdentities() {
  const key = randomBytes(32);
  const sign = (stream, viewer) => createHmac('sha256', key).update(`${stream}:${viewer}`).digest();
  return {
    issue(stream) {
      const viewer = randomBytes(16).toString('base64url');
      return `${viewer}.${sign(stream, viewer).toString('base64url')}`;
    },
    viewer(stream, token) {
      if (typeof token !== 'string' || !/^[\w-]{22}\.[\w-]{43}$/.test(token)) return undefined;
      const [viewer, proof] = token.split('.');
      const decoded = Buffer.from(proof, 'base64url');
      if (decoded.length !== 32 || !timingSafeEqual(decoded, sign(stream, viewer))) return undefined;
      return viewer;
    },
  };
}

const unsafe = /\b(?:javascript|vbscript|file)\s*:|\bdata\s*:\s*(?:text\/html|application\/(?:javascript|xhtml\+xml))|<\s*\/?\s*(?:script|iframe|object|embed)\b/iu;
const link = /(?:https?:\/\/|\bwww\.|(?:^|[\s(\[])(?:\/\/)?(?:[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,63}|(?:\d{1,3}\.){3}\d{1,3})(?=$|[\s/?:#)\],!]))/iu;
const comparison = (text) => text.normalize('NFKC').toLowerCase().replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();

export function chatPolicy(input) {
  if (typeof input?.allowLinks !== 'boolean' || !Array.isArray(input.blockedPhrases) || input.blockedPhrases.length > 50) return undefined;
  const phrases = [];
  for (const value of input.blockedPhrases) {
    if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
    const phrase = comparison(value);
    if (phrase.length < 3 || phrase.length > 100) return undefined;
    phrases.push(phrase);
  }
  const blockedPhrases = [...new Set(phrases)];
  const rules = blockedPhrases.map((phrase) => new RegExp(
    `(?<![\\p{L}\\p{N}_])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u',
  ));
  return {
    settings: { allowLinks: input.allowLinks, blockedPhrases },
    rejection(text) {
      const normalized = comparison(text);
      if (unsafe.test(normalized)) return 'unsafe_content';
      if (!input.allowLinks && link.test(normalized)) return 'links_disabled';
      if (rules.some((rule) => rule.test(normalized))) return 'blocked_content';
      return undefined;
    },
  };
}
