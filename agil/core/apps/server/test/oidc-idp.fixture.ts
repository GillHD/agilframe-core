import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface MockIdpOptions {
  /** Override the `iss` claim. */
  issuer?: string;
  /** Override the `aud` claim of the id_token (wrong-audience tests). */
  audience?: string | string[];
  /** Optional `azp` claim (required for multi-audience tokens by OIDC). */
  azp?: string;
  /** Override the `nonce` claim (nonce-mismatch tests). */
  nonce?: string;
  /** Seconds added to `exp` (default +300; negative = expired). */
  expOffset?: number;
  /** Seconds added to `nbf` when set. */
  nbfOffset?: number;
  /** Seconds added to `iat` (default 0). */
  iatOffset?: number;
  /** Omit the `iat` claim. */
  omitIat?: boolean;
  /** JOSE header `typ` override (e.g. `at+jwt`). */
  typ?: string;
  /** Email claim value (default admin@example.test). */
  email?: string;
  /** Omit the email claim entirely. */
  omitEmail?: boolean;
  /** `email_verified` claim (default true). */
  emailVerified?: boolean;
  /** `verified` claim (default true). */
  verified?: boolean | string;
  /** Omit the verified claim. */
  omitVerified?: boolean;
  /** Group membership claim (string array). */
  groups?: string[];
  /** Tenant claim value (only sent when set). */
  tenant?: string;
  /** Corrupt the stored PKCE challenge after /authorize (PKCE-mismatch test). */
  breakPkce?: boolean;
  /** Answer the token endpoint with this HTTP status. */
  tokenStatus?: number;
  /** Omit id_token from a successful token response. */
  omitIdToken?: boolean;
  /**
   * `form_post` authorization response: `/authorize` answers with an
   * auto-submit HTML form instead of a 302 (OAuth 2.0 Form Post Response Mode).
   */
  formPost?: boolean;
  /* --------------------------- discovery options --------------------------- */
  /** Serve the discovery document with this issuer (mix-up tests). */
  discoveryIssuer?: string;
  /** Custom discovery document URL path (default `/.well-known/openid-configuration`). */
  discoveryPath?: string;
  /** Discovery HTTP status (unavailable tests). */
  discoveryStatus?: number;
  /** `token_endpoint_auth_methods_supported` in the discovery document. */
  discoveryAuthMethods?: string[];
  /** `response_modes_supported` in the discovery document. */
  discoveryResponseModes?: string[];
  /** Omit `end_session_endpoint` from the discovery document. */
  discoveryOmitEndSession?: boolean;
  /** Omit `jwks_uri` from the discovery document (invalid metadata). */
  discoveryOmitJwks?: boolean;
}

export interface MockLogoutRecord {
  clientId: string;
  postLogoutRedirectUri: string;
  state: string;
  idTokenHint: string | null;
}

export interface MockIdp {
  url: string;
  options: MockIdpOptions;
  authorizeCount: number;
  tokenCount: number;
  /** Token-endpoint request body of the last exchange (post/invalid requests). */
  lastTokenRequest: URLSearchParams | null;
  /** How the last token request authenticated: post body or HTTP Basic. */
  lastTokenClientAuth: 'client_secret_post' | 'client_secret_basic' | null;
  /** Client id from the Basic header (basic-auth tests). */
  lastBasicClientId: string | null;
  /** Decoded secret from the Basic header (basic-auth tests). */
  lastBasicClientSecret: string | null;
  /** Raw Authorization header of the last token request (leak checks). */
  lastTokenAuthorizationHeader: string | null;
  lastAuthorization: URLSearchParams | null;
  lastIdToken: string | null;
  /** Number of RP-initiated logout requests served. */
  logoutCount: number;
  lastLogout: MockLogoutRecord | null;
  /** Path of the RP-initiated logout endpoint. */
  endSessionPath: string;
  server: Server;
}

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keyPair.privateKey;
const jwk = {
  ...(keyPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
  kid: 'sso-key-1',
  alg: 'RS256',
  use: 'sig',
};

function signIdToken(
  payload: Record<string, unknown>,
  key = privateKey,
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'sso-key-1', ...headerOverrides };
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  return `${signingInput}.${cryptoSign('sha256', Buffer.from(signingInput), key).toString('base64url')}`;
}

function s256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function decodeBasic(headerValue: string): { clientId: string; clientSecret: string } | null {
  const match = /^Basic\s+(.+)$/i.exec(headerValue.trim());
  if (!match?.[1]) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index < 0) return null;
    // RFC 6749 §2.3.1: both parts are application/x-www-form-urlencoded.
    return {
      clientId: decodeURIComponent(decoded.slice(0, index).replace(/\+/g, ' ')),
      clientSecret: decodeURIComponent(decoded.slice(index + 1).replace(/\+/g, ' ')),
    };
  } catch {
    return null;
  }
}

interface AuthorizationRecord {
  clientId: string;
  redirectUri: string;
  nonce: string;
  challenge: string;
  code: string;
  options: MockIdpOptions;
}

export function startMockIdp({ clientId, issuer, clientSecrets, testAccounts }: {
  clientId: string; issuer: string; clientSecrets: ReadonlySet<string>;
  testAccounts?: ReadonlyMap<string, MockIdpOptions>;
}): Promise<MockIdp> {
  const codes = new Map<string, AuthorizationRecord>();
  const idp: MockIdp = {
    url: '',
    options: {},
    authorizeCount: 0,
    tokenCount: 0,
    lastTokenRequest: null,
    lastTokenClientAuth: null,
    lastBasicClientId: null,
    lastBasicClientSecret: null,
    lastTokenAuthorizationHeader: null,
    lastAuthorization: null,
    lastIdToken: null,
    logoutCount: 0,
    lastLogout: null,
    endSessionPath: '/logout',
    server: createServer(),
  };
  idp.server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const discoveryPath = idp.options.discoveryPath ?? '/.well-known/openid-configuration';
    if (url.pathname === '/jwks.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === discoveryPath) {
      if (idp.options.discoveryStatus) {
        res.statusCode = idp.options.discoveryStatus;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'server_error' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          issuer: idp.options.discoveryIssuer ?? issuer,
          authorization_endpoint: `${idp.url}/authorize`,
          token_endpoint: `${idp.url}/token`,
          ...(idp.options.discoveryOmitJwks ? {} : { jwks_uri: `${idp.url}/jwks.json` }),
          ...(idp.options.discoveryOmitEndSession ? {} : { end_session_endpoint: `${idp.url}${idp.endSessionPath}` }),
          token_endpoint_auth_methods_supported: idp.options.discoveryAuthMethods ?? [
            'client_secret_post',
            'client_secret_basic',
          ],
          response_modes_supported: idp.options.discoveryResponseModes ?? ['query', 'form_post'],
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      );
      return;
    }
    if (url.pathname === '/authorize') {
      const account = url.searchParams.get('test_account');
      const selectedAccount = account ? testAccounts?.get(account) : undefined;
      if (testAccounts && !selectedAccount) {
        res.statusCode = account ? 400 : 200;
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const links = [...testAccounts.keys()].map((name) => {
          const target = new URL(url);
          target.searchParams.set('test_account', name);
          const href = target.pathname + target.search.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
          const safeName = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
          return `<li><a href="${href}">${safeName}</a></li>`;
        });
        res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Тестовый вход</title><h1>Выберите тестовую учётную запись</h1><ul>${links.join('')}</ul></html>`);
        return;
      }
      idp.authorizeCount += 1;
      idp.lastAuthorization = url.searchParams;
      const code = randomBytes(16).toString('base64url');
      const record: AuthorizationRecord = {
        clientId: url.searchParams.get('client_id') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        nonce: url.searchParams.get('nonce') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        code,
        // Snapshot the options: later tests must not mutate an in-flight flow.
        options: { ...idp.options, ...selectedAccount },
      };
      codes.set(code, record);
      if (idp.options.breakPkce) record.challenge = s256(`wrong-${randomBytes(8).toString('hex')}`);
      const target = new URL(record.redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (idp.options.formPost || url.searchParams.get('response_mode') === 'form_post') {
        // Form Post Response Mode: the code/state travel in a cross-site POST.
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          `<!doctype html><html><body><form id="f" method="post" action="${target.origin}${target.pathname}">` +
            `<input type="hidden" name="code" value="${code}"/>` +
            `<input type="hidden" name="state" value="${url.searchParams.get('state') ?? ''}"/>` +
            `</form><script>document.getElementById('f').submit()</script></body></html>`,
        );
        return;
      }
      res.statusCode = 302;
      res.setHeader('location', target.toString());
      res.end();
      return;
    }
    if (url.pathname === idp.endSessionPath) {
      idp.logoutCount += 1;
      idp.lastLogout = {
        clientId: url.searchParams.get('client_id') ?? '',
        postLogoutRedirectUri: url.searchParams.get('post_logout_redirect_uri') ?? '',
        state: url.searchParams.get('state') ?? '',
        idTokenHint: url.searchParams.get('id_token_hint'),
      };
      const target = new URL(idp.lastLogout.postLogoutRedirectUri);
      target.searchParams.set('state', idp.lastLogout.state);
      res.statusCode = 302;
      res.setHeader('location', target.toString());
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      idp.tokenCount += 1;
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        idp.lastTokenRequest = form;
        const authorization = req.headers.authorization ?? '';
        idp.lastTokenAuthorizationHeader = authorization || null;
        const basic = authorization ? decodeBasic(authorization) : null;
        idp.lastTokenClientAuth = basic ? 'client_secret_basic' : 'client_secret_post';
        idp.lastBasicClientId = basic?.clientId ?? null;
        idp.lastBasicClientSecret = basic?.clientSecret ?? null;
        const respond = (status: number, body: unknown): void => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (idp.options.tokenStatus) {
          respond(idp.options.tokenStatus, { error: 'server_error' });
          return;
        }
        const record = codes.get(form.get('code') ?? '');
        const authenticated = basic
          ? basic.clientId === clientId && clientSecrets.has(basic.clientSecret)
          : form.get('client_id') === clientId && clientSecrets.has(form.get('client_secret') ?? '');
        const valid =
          form.get('grant_type') === 'authorization_code' &&
          authenticated &&
          form.get('redirect_uri') === record?.redirectUri &&
          s256(form.get('code_verifier') ?? '') === record?.challenge;
        if (!record || !valid) {
          respond(400, { error: 'invalid_grant', error_description: 'PKCE/client validation failed' });
          return;
        }
        codes.delete(record.code);
        const options = record.options;
        const now = Math.floor(Date.now() / 1000);
        const iat = now + (options.iatOffset ?? 0);
        const payload: Record<string, unknown> = {
          iss: options.issuer ?? issuer,
          aud: options.audience ?? record.clientId,
          ...(options.azp ? { azp: options.azp } : {}),
          ...(options.tenant ? { tenant: options.tenant } : {}),
          ...(options.groups !== undefined ? { groups: options.groups } : {}),
          ...(options.omitEmail ? {} : { email: options.email ?? 'admin@example.test', email_verified: options.emailVerified ?? true }),
          sub: 'admin-user-1',
          name: 'Иван Администратор',
          ...(options.omitVerified ? {} : { verified: options.verified ?? true }),
          nonce: options.nonce ?? record.nonce,
          ...(options.omitIat ? {} : { iat }),
          ...(options.nbfOffset !== undefined ? { nbf: now + options.nbfOffset } : {}),
          exp: now + (options.expOffset ?? 300),
        };
        const idToken = signIdToken(payload, privateKey, options.typ ? { typ: options.typ } : {});
        idp.lastIdToken = idToken;
        respond(200, {
          token_type: 'Bearer',
          expires_in: 300,
          access_token: 'opaque-access-token',
          ...(options.omitIdToken ? {} : { id_token: idToken }),
        });
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    idp.server.listen(0, '127.0.0.1', () => {
      const address = idp.server.address() as { port: number };
      idp.url = `http://127.0.0.1:${address.port}`;
      resolve(idp);
    });
  });
}
