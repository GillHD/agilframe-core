/**
 * Redaction of untrusted upstream text before it reaches a client response,
 * the audit trail, `lastError` or a log line.
 *
 * Policy: keep the *shape* of the failure (protocol, host, method, status) and
 * drop everything that authenticates — path, query, fragment, userinfo and
 * `name=value` pairs whose name looks like a credential. Applies to every URI
 * scheme, and untrusted text is percent-decoded before matching.
 */

/** Upper bound for a stored error line (audit/status/log stay one short line). */
export const MAX_ERROR_TEXT_LENGTH = 300;

/** Attribute/field names whose value is a credential; deliberately broad (a false negative leaks a key). */
const SECRET_NAME =
  /(?:secret|token|passw(?:or)?d|pass|pwd|credential|signature|sig|key|auth|session|stream[-_]?id)/i;

/** Sentence punctuation that may trail a URL in prose (peeled off and re-appended). */
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!?'")\]}>]+$/;

/**
 * A host that may be echoed: DNS name, IPv4 or `[IPv6]`, plus an optional
 * numeric port. Anything else in the authority (quotes/braces from surrounding
 * JSON, a lone `:password` fragment) is not a host and must not be printed.
 */
const HOST_WITH_OPTIONAL_PORT =
  /^(?:\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9_])?)(?::\d{1,5})?$/;

/**
 * Any absolute `scheme://…` URL, including non-http schemes (`redis`, `rtsp`…).
 * The body runs to whitespace (`\S+`); only the parsed host survives.
 */
const SCHEME_URL = /\b([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/(\S+)/g;

/** Splits prose punctuation off the end of `text` (keeps it for re-appending). */
function splitTrailingSentencePunctuation(text: string): [body: string, trailing: string] {
  const match = TRAILING_SENTENCE_PUNCTUATION.exec(text);
  if (!match) return [text, ''];
  return [text.slice(0, -match[0].length), match[0]];
}

/** Characters that can belong to a host and its port; anything else ends it. */
const NON_HOST_CHARACTER = /[^0-9A-Za-z._:[\]%_-]/;

/**
 * Extracts the host from a whole authority, dropping `userinfo@` and refusing
 * anything that is not a plausible host (so prose/JSON around the URL cannot be
 * echoed as if it were part of the host).
 */
function hostFromAuthority(authority: string): string | null {
  const at = authority.lastIndexOf('@');
  let candidate = (at >= 0 ? authority.slice(at + 1) : authority).trim();
  // Structural text glued to the host (`host","token":…` in a JSON echo, XML
  // markup) ends the host instead of becoming part of it.
  const end = candidate.search(NON_HOST_CHARACTER);
  if (end >= 0) candidate = candidate.slice(0, end);
  if (!candidate || !HOST_WITH_OPTIONAL_PORT.test(candidate)) return null;
  return candidate.toLowerCase();
}

/**
 * Keeps only `scheme://host[:port]/…` of an absolute URL: userinfo, path, query
 * and fragment are dropped, trailing prose punctuation is re-attached.
 */
export function redactUrlToHost(raw: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/(.*)$/s.exec(raw.trim());
  if (!match) return '…';
  const scheme = (match[1] as string).toLowerCase();
  const body = match[2] as string;
  // Locate the authority first. Only then may prose punctuation be peeled, so
  // the trim can never split a userinfo that itself contains `, ; )` etc.
  const authorityEnd = body.search(/[/?#]/);
  const [authority, authorityTail] = splitTrailingSentencePunctuation(
    authorityEnd < 0 ? body : body.slice(0, authorityEnd),
  );
  const rawSuffix = authorityEnd < 0 ? '' : body.slice(authorityEnd);
  // Path/query/fragment are dropped; only their trailing prose mark survives.
  const [, suffixTail] = splitTrailingSentencePunctuation(rawSuffix);
  let host = hostFromAuthority(authority);
  if (!host) {
    // A decoded `/`, `?` or `#` inside a password ends the standard authority
    // (`redis://:PA%2FSS@host` → `:PA/SS@host`). If an `@host` remains later in
    // the match, that is still the real host; everything before it is userinfo.
    const at = body.lastIndexOf('@');
    if (at >= 0) host = hostFromAuthority(body.slice(at + 1));
  }
  const suffix = authorityTail + suffixTail;
  if (!host) return `${scheme}://…${suffix}`;
  return `${scheme}://${host}/…${suffix}`;
}

/** Host-only representation of an RTMP URL (never exposes stream keys). */
export function redactRtmpUrl(raw: string): string {
  const redacted = redactUrlToHost(raw);
  return redacted === '…' || redacted.endsWith('://…') ? 'rtmp://invalid/…' : redacted;
}

/** Percent-encoded whitespace is parked on a private-use char while URLs are scrubbed. */
const WHITESPACE_SENTINEL = '\uE000';
const ENCODED_WHITESPACE = /%(?:09|0A|0B|0C|0D|20)/gi;

/**
 * Decodes percent-encoding before matching so an encoded URL/credential cannot
 * bypass the scrubber. Double-encoded text is covered; invalid escapes are
 * decoded byte-wise instead of throwing; encoded whitespace stays a sentinel
 * until after URL redaction (see `WHITESPACE_SENTINEL`).
 */
function decodePercentText(raw: string): string {
  let text = raw;
  for (let pass = 0; pass < 3; pass += 1) {
    text = text.replace(ENCODED_WHITESPACE, WHITESPACE_SENTINEL);
    if (!/%[0-9A-Fa-f]{2}/.test(text)) break;
    let decoded: string | null = null;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      decoded = null;
    }
    if (decoded === null) {
      // A stray/incomplete escape (`100%`, `%C3`): decode only complete ASCII
      // escapes, which covers `rtmp%3A%2F%2F` while leaving non-ASCII alone.
      decoded = text.replace(/%([0-9A-Fa-f]{2})/g, (sequence, hex: string) => {
        const code = Number.parseInt(hex, 16);
        return code < 0x80 ? String.fromCharCode(code) : sequence;
      });
    }
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

/**
 * Sanitizes an untrusted upstream error message.
 *
 * Handles, in order: percent-decoding; every absolute URL (`scheme://` of any
 * protocol — userinfo/path/query/fragment dropped, host kept); `Authorization`/
 * `Bearer`/`Basic` credentials; `name=value`/`name: value` pairs with a
 * credential-like name (including short generic `key`/`pass`/`sig`/`streamid`
 * values); JWTs and long high-entropy blobs (signatures, digests, API keys).
 */
export function sanitizeEgressErrorText(raw: unknown): string {
  if (typeof raw !== 'string') return 'Egress request failed';
  let text = decodePercentText(raw);
  // 1. Any absolute URL: keep protocol + host (+ port), drop userinfo and the
  //    rest. This is scheme-agnostic so `redis://`, `rtsp://`, `srt://`, … are
  //    covered, not only an http/rtmp allowlist.
  text = text.replace(SCHEME_URL, (_match, scheme: string, body: string) => redactUrlToHost(`${scheme}://${body}`));
  // Encoded whitespace is a normal space again for the remaining rules now that
  // it can no longer split a URL authority.
  text = text.split(WHITESPACE_SENTINEL).join(' ');
  // 2. Bearer/basic tokens first (so a non-JWT token is not left behind when
  //    the `Authorization:` header name is the only thing recognized), then the
  //    header value itself.
  text = text.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 …');
  text = text.replace(/\b(authorization\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1…');
  // 3. `name=value` / `name: value` where the name looks like a credential.
  text = text.replace(
    /\b([A-Za-z0-9_.-]{1,64})\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&"']{1,512})/g,
    (match, name: string) => (SECRET_NAME.test(name) ? `${name}=…` : match),
  );
  // 4. JWTs and long opaque blobs (signatures, digests, API keys, S3 keys).
  text = text.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, '…');
  text = text.replace(/\b[A-Fa-f0-9]{40,}\b/g, '…');
  text = text.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '…');
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return (collapsed || 'Egress request failed').slice(0, MAX_ERROR_TEXT_LENGTH);
}
