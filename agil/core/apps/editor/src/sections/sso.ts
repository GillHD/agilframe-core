/**
 * Corporate SSO / OIDC section: identity federation (`integrations.identity`)
 * and the "verified identity required" policy (`security.requireVerifiedIdentity`).
 *
 * The editor only edits TenantConfig; the server verifies OIDC tokens against
 * the configured JWKS/issuer/audience and maps claims to the participant.
 */
import { identityConfigSchema } from '@agil/protocol';
import { el } from '../dom';
import { card, renderSchema, selectField, tableField, toggleField, type Sync } from '../fields';
import { tr } from '../i18n';
import type { SectionDefinition } from './types';

const IDENTITY_LABELS: Record<string, string> = {
  mode: 'Режим входа',
  issuer: 'Издатель токена (issuer)',
  audience: 'Получатель токена (audience)',
  jwksUrl: 'Адрес ключей подписи (JWKS)',
  userIdClaim: 'Claim с идентификатором пользователя',
  nameClaim: 'Claim с именем',
  roleClaim: 'Claim с ролью',
  permissionsClaim: 'Claim с правами (функциями)',
  verifiedClaim: 'Claim с подтверждением личности',
  authorizationEndpoint: 'Адрес авторизации (authorization endpoint)',
  tokenEndpoint: 'Адрес выдачи токена (token endpoint)',
  discovery: 'OIDC discovery из issuer',
  discoveryUrl: 'URL discovery-документа (необязательно)',
  clientId: 'Идентификатор клиента (client_id)',
  clientSecretEnv: 'Переменная окружения с секретом клиента',
  redirectUri: 'Адрес возврата (redirect URI)',
  scopes: 'Области доступа (scopes)',
  tokenEndpointAuthMethod: 'Метод аутентификации на token endpoint',
  responseMode: 'Режим ответа authorization',
  endSessionEndpoint: 'Адрес завершения сессии IdP (end_session)',
  postLogoutRedirectUri: 'Адрес возврата после выхода',
  emailClaim: 'Поле токена с адресом почты',
  emailVerifiedClaim: 'Поле токена с подтверждением почты',
  requireEmailVerified: 'Требовать подтверждённую почту',
  allowedEmails: 'Разрешённые адреса почты',
  allowedEmailDomains: 'Разрешённые домены почты',
  groupsClaim: 'Поле токена со списком групп',
  groupRoleMap: 'Соответствие групп и ролей',
  dashboardAdminGroups: 'Группы с доступом в панель',
  tenantClaim: 'Поле токена с ID организации',
  maxTokenAgeSec: 'Максимальный срок действия токена, с',
  clockSkewSec: 'Допустимое расхождение часов, с',
};

const IDENTITY_HINTS: Record<string, string> = {
  mode:
    'oidc — корпоративный SSO: сервер проверяет подпись токена по JWKS, issuer/audience и claim-маппинг. token — вход по токену, который выпускает ваша система (HS256), без OIDC-проверки.',
  issuer: 'Например https://sso.example.com/realms/corp — должен совпадать с iss в токене.',
  audience: 'Кому выпущен токен (aud): обычно client_id или ресурс AgilFrame.',
  jwksUrl: 'HTTPS-адрес JWKS вашего IdP. Сервер загружает ключи и проверяет подпись SSO-токена при входе.',
  userIdClaim: 'Поле токена с постоянным id пользователя (по умолчанию sub).',
  nameClaim: 'Поле с отображаемым именем (по умолчанию name).',
  roleClaim: 'Поле с ролью host/moderator/guest (по умолчанию role).',
  permissionsClaim: 'Поле со списком разрешённых функций (по умолчанию permissions).',
  verifiedClaim: 'Поле, которым IdP подтверждает личность (например email_verified).',
  authorizationEndpoint: 'Нужен для входа через браузер. Пусто + discovery — из метаданных IdP.',
  tokenEndpoint: 'Нужен для входа через браузер. Пусто + discovery — из метаданных IdP.',
  discovery: 'Сервер загрузит authorization/token/JWKS/end_session из /.well-known/openid-configuration по issuer.',
  discoveryUrl: 'Для нестандартного пути метаданных; непустое значение включает discovery.',
  clientId: 'Идентификатор приложения, выданный IdP.',
  clientSecretEnv: 'Только имя переменной окружения — сам секрет хранится в настройках сервера. Имя привязывается к тенанту: AGIL_OIDC_CLIENT_SECRET_<TENANT>_<NAME> или запись в AGIL_OIDC_TENANT_SECRETS.',
  redirectUri: 'Пусто — адрес по умолчанию: <адрес сервера>/v1/auth/oidc/callback.',
  scopes: 'Обычно openid, profile, email.',
  tokenEndpointAuthMethod: 'client_secret_post — секрет в теле запроса; client_secret_basic — HTTP Basic.',
  responseMode: 'query — параметры в URL; form_post — IdP POST-ит ответ на callback (нужен HTTPS).',
  endSessionEndpoint: 'Для RP-initiated logout. Пусто + discovery — из метаданных IdP.',
  postLogoutRedirectUri: 'Пусто — <адрес сервера>/v1/auth/oidc/logout/callback; должен быть зарегистрирован в IdP.',
  maxTokenAgeSec: 'Ограничивает разницу между exp и iat. При значении 0 действует только срок окончания exp.',
};

const IDENTITY_MODE_LABELS: Record<string, string> = {
  oidc: 'OIDC / SSO (oidc)',
  token: 'Токен компании (token)',
};

function ssoNote(ctx: Parameters<SectionDefinition['render']>[0], parent: HTMLElement): Sync {
  const note = el('div', 'media-note sso-note');
  note.dataset.testid = 'sso-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  parent.append(note);
  const sync: Sync = () => {
    const identity = ctx.config().integrations.identity;
    const required = ctx.config().security.requireVerifiedIdentity;
    const items: string[] = [];
    let tone: 'info' | 'warning' | 'danger' | 'success' = 'info';
    let title = 'Корпоративный вход';

    if (identity.mode === 'oidc') {
      const discovery = identity.discovery === true || Boolean(identity.discoveryUrl.trim());
      const missing = [
        !identity.issuer.trim() ? 'issuer' : '',
        !identity.audience.trim() ? 'audience' : '',
        !identity.jwksUrl.trim() && !discovery ? 'jwksUrl' : '',
      ].filter(Boolean);
      const missingBrowser = [
        !identity.clientId.trim() ? 'clientId' : '',
        !discovery && !identity.authorizationEndpoint.trim() ? 'authorizationEndpoint' : '',
        !discovery && !identity.tokenEndpoint.trim() ? 'tokenEndpoint' : '',
      ].filter(Boolean);
      tone = missing.length > 0 ? 'danger' : missingBrowser.length > 0 ? 'warning' : 'success';
      title = missing.length > 0 || missingBrowser.length > 0 ? 'OIDC настроен не полностью' : 'Основные поля OIDC заполнены';
      if (missing.length > 0) {
        items.push(tr('Заполните обязательные поля OIDC: {fields} — иначе сервер не сможет проверить SSO-токен.', { fields: missing.join(', ') }));
      } else {
        items.push('SSO-токен проверяется на сервере: подпись по JWKS, issuer и audience; claims маппятся в id, имя, роль и права.');
      }
      if (missingBrowser.length > 0) {
        items.push(tr('Для входа через браузер заполните поля: {fields}.', { fields: missingBrowser.join(', ') }));
      }
    } else {
      tone = required ? 'danger' : 'warning';
      title = required ? 'IdP не подключён' : 'Корпоративный вход не включён';
      items.push('Режим token: вход идёт по токену компании без OIDC-проверки, поэтому подтверждённой личности от IdP нет.');
    }

    if (required) {
      if (identity.mode !== 'oidc') {
        tone = 'danger';
        items.push('«Требовать проверенную личность» включено, но OIDC не настроен: вход без подтверждённого IdP-claim будет отклонён.');
      } else if (!identity.verifiedClaim.trim()) {
        tone = 'danger';
        title = 'OIDC настроен не полностью';
        items.push('Укажите поле токена, по которому сервер проверит подтверждение личности.');
      } else {
        items.push('Требование проверенной личности включено: гостевой вход без IdP-claim запрещён; SSO-токен обязан пройти серверную проверку.');
      }
    } else {
      items.push('«Требовать проверенную личность» выключено: допустим гостевой вход без IdP, если это разрешено комнатой.');
    }

    note.dataset.tone = tone;
    note.replaceChildren(
      el('strong', 'media-note-title', tr(title)),
      ...items.map((item) => el('p', 'media-note-item', tr(item))),
    );
  };
  sync();
  return sync;
}

export const ssoSection: SectionDefinition = {
  id: 'sso',
  title: 'Корпоративный вход',
  icon: 'key',
  description:
    'Провайдер корпоративного входа, поля токена, доступ в панель и проверка личности при входе в комнату.',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const identityCard = card('Провайдер входа (OIDC)', {
      hint: 'Компания настраивает IdP (Keycloak, Okta, Entra ID, ADFS). AgilFrame получает SSO-токен и проверяет его на сервере — браузер не принимает решение о личности.',
    });
    const fields = renderSchema(identityConfigSchema, 'integrations.identity', ctx, {
      labels: IDENTITY_LABELS,
      hints: IDENTITY_HINTS,
      custom: {
        mode: (fieldCtx, path, parent) =>
          selectField(fieldCtx, parent, path, IDENTITY_LABELS.mode ?? 'Режим входа', ['oidc', 'token'], {
            hint: IDENTITY_HINTS.mode,
            labels: IDENTITY_MODE_LABELS,
          }),
        groupRoleMap: (fieldCtx, path, parent) =>
          tableField(fieldCtx, parent, path, identityConfigSchema.shape.groupRoleMap.removeDefault().element,
            IDENTITY_LABELS.groupRoleMap!, {
              labels: { group: 'Группа в IdP', role: 'Роль в звонке' },
              defaults: { role: 'guest' },
            }),
      },
    });
    identityCard.body.append(fields.node);
    root.append(identityCard.root);
    syncs.push(...fields.syncs);

    const policyCard = card('Политика проверенной личности', {
      hint: 'Требование действует на входе в комнату: без подтверждённого IdP-claim участник не сможет присоединиться.',
    });
    syncs.push(
      toggleField(ctx, policyCard.body, 'security.requireVerifiedIdentity', 'Требовать проверенную личность (requireVerifiedIdentity)', {
        hint: 'Рекомендуется включать вместе с OIDC. Если IdP не настроен, обычный гостевой вход будет отклонён.',
        badge: 'beta',
      }),
    );
    root.append(policyCard.root);

    syncs.push(ssoNote(ctx, identityCard.body));
    return syncs;
  },
};
