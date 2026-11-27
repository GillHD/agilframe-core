/**
 * Roles documentation and validation (docs/api-guide.md §3, docs/contract.md §18):
 * three built-in roles (host/moderator/guest) plus company-defined custom roles
 * from `security.accessPolicy.customRoles`, resolved per participant via `roleId`.
 */
import type { CustomRole, FeatureKey } from '@agil/protocol';

export const BUILTIN_ROLE_IDS = ['host', 'moderator', 'guest'] as const;
/** Ids that cannot be used for a custom role (conflict with built-ins / reserved). */
export const RESERVED_ROLE_IDS: ReadonlySet<string> = new Set([
  ...BUILTIN_ROLE_IDS,
  'anonymous',
  'system',
  'admin',
]);

export const MAX_CUSTOM_ROLES = 30;

export const ROLE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export interface RoleValidationInput {
  role: CustomRole;
  existingRoles?: readonly { id: string }[];
  /** True for update (own id is not a duplicate). */
  updating?: boolean;
  /** Built-in role ids (cannot be redefined as custom). */
  reserved?: ReadonlySet<string>;
}

/** Semantic warnings/errors for creating or updating a custom role. */
export function roleWarnings(input: RoleValidationInput): { errors: string[]; warnings: string[] } {
  const { role } = input;
  const reserved = input.reserved ?? RESERVED_ROLE_IDS;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!ROLE_ID_RE.test(role.id)) {
    errors.push(`role.id "${role.id}" must match ${ROLE_ID_RE.source} (lowercase latin, digits, _ and -).`);
  }
  if (reserved.has(role.id)) {
    errors.push(
      `role.id "${role.id}" is reserved (built-in roles host/moderator/guest and system ids). Built-in role defaults are edited via agil_set_access_policy.`,
    );
  }
  const existing = input.existingRoles ?? [];
  if (existing.some((entry) => entry.id === role.id && (!input.updating || entry.id !== role.id))) {
    errors.push(`role.id "${role.id}" already exists.`);
  }
  if (role.features.length === 0) {
    warnings.push('This role has no features: participants with it will see nothing.');
  }
  if (role.baseRole === 'guest' && role.features.includes('recording')) {
    warnings.push(
      'baseRole="guest" with the recording feature: the role can record even though guests normally cannot; make sure this is intended (consent!).',
    );
  }
  if (role.baseRole === 'guest' && role.canModerate) {
    warnings.push('baseRole="guest" with canModerate=true: custom moderation rights on a guest transport role.');
  }
  if (role.color && !/^#?[0-9a-f]{3,8}$/i.test(role.color)) {
    warnings.push(`role.color "${role.color}" is not a hex color (#rrggbb).`);
  }
  if (existing.length >= MAX_CUSTOM_ROLES && !input.updating) {
    errors.push(`Custom role limit reached (${MAX_CUSTOM_ROLES}); remove an unused role first.`);
  }
  return { errors, warnings };
}

/** Normalizes a role from API/config data (fills optional fields). */
export function normalizeRole(raw: Record<string, unknown>, fallbackId = ''): CustomRole {
  const features = Array.isArray(raw.features)
    ? raw.features.filter((feature): feature is FeatureKey => typeof feature === 'string')
    : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallbackId || 'role',
    description: typeof raw.description === 'string' ? raw.description : '',
    baseRole: raw.baseRole === 'host' || raw.baseRole === 'moderator' ? raw.baseRole : 'guest',
    features,
    canModerate: raw.canModerate === true,
    color: typeof raw.color === 'string' ? raw.color : '',
  };
}

/** Offline markdown guide for the roles model. */
export function explainRolesMarkdown(): string {
  return [
    '# Roles and permissions',
    '',
    'Three **built-in roles** — `host`, `moderator`, `guest` — plus up to 30 **custom roles** per tenant ' +
      '(`security.accessPolicy.customRoles`). Full user guide: `agil/core/docs/api-guide.md` §3; contract: `agil/core/docs/contract.md` §18.',
    '',
    '## How effective permissions are resolved',
    '',
    'Order in `resolveAccess` (first match wins, then filtering):',
    '',
    '1. **Token permissions** (`POST /v1/tokens` `permissions`) — replaces everything; the issuer decides.',
    '2. **Per-user override** (`userOverrides[userId]`) — replaces the role list for that user.',
    '3. **Custom role** (`roleId` on the token) — its `features` replace the built-in defaults.',
    '4. **Strict mode** (`accessPolicy.mode:"strict"`) — only explicit grants apply.',
    '5. **Role defaults** (`roleDefaults[role]`) — built-in host/moderator/guest lists.',
    '',
    'Then `deniedFeatures` are removed and the result is intersected with enabled `features.*`.',
    'A custom role is only a permission list: the transport `baseRole` is still used for moderation/audit records ' +
      '(`canModerate` is advisory; server-side enforcement checks the effective features).',
    '',
    '## Built-in vs custom',
    '',
    '| | Built-in | Custom |',
    '|---|---|---|',
    '| How many | exactly 3 | up to 30 (`customRoles`) |',
    '| Edit rights | `PUT /v1/admin/access-policy` → `roleDefaults` | `POST/PUT/DELETE /v1/admin/roles` |',
    '| Delete | never | yes (`builtin:false`) |',
    '| Used by | token without `roleId` | token with `roleId` |',
    '| Fallback | — | role deleted → token falls back to `baseRole` |',
    '',
    '## Examples',
    '',
    '```jsonc',
    '// Оператор поддержки: модерация, без записи',
    '{ "id": "operator", "name": "Оператор", "description": "Поддержка в звонке", "baseRole": "moderator",',
    '  "features": ["chat","fileShare","participantList","deviceSettings","screenShare"], "canModerate": true, "color": "#2563eb" }',
    '',
    '// Стример: ведёт трансляцию, без записи',
    '{ "id": "streamer", "name": "Стример", "description": "Ведёт трансляцию", "baseRole": "host",',
    '  "features": ["chat","screenShare","fullscreen","knowledgeAgent"], "canModerate": false, "color": "#8576ff" }',
    '',
    '// Наблюдатель: только смотрит и слушает',
    '{ "id": "viewer", "name": "Наблюдатель", "description": "Только просмотр", "baseRole": "guest",',
    '  "features": ["chat"], "canModerate": false, "color": "#64748b" }',
    '```',
    '',
    'Issue a token for a custom role:',
    '',
    '```bash',
    'curl -X POST $AGIL_SERVER_URL/v1/tokens -H "x-api-key: $AGIL_API_KEY" -H "content-type: application/json" \\',
    '  -d \'{"tenantId":"demo","roomId":"room-1","participant":{"name":"Игорь","role":"host","roleId":"streamer"}}\'',
    '```',
    'The token response includes `permissions`, `roleId` and `roleName`; the widget hides/disables features outside the list.',
    '',
    '## Admin API',
    '',
    '| Method | Path | Meaning |',
    '|---|---|---|',
    '| GET | `/v1/admin/roles` | built-ins (`builtin:true`) + custom roles with `assigned` counters |',
    '| POST | `/v1/admin/roles` | create a custom role (`RoleWriteRequest`) |',
    '| PUT | `/v1/admin/roles/:roleId` | update a custom role (built-ins → use access-policy) |',
    '| DELETE | `/v1/admin/roles/:roleId` | delete a custom role (tokens fall back to `baseRole`) |',
    '',
    '## MCP tools',
    '',
    '- `agil_list_roles` — built-ins + custom roles (with assigned counters).',
    '- `agil_create_role` / `agil_update_role` / `agil_delete_role` — validated writes with `dryRun`, duplicate/reserved-id checks and warnings.',
    '- `agil_explain_roles` — this guide (offline).',
    '- `agil_create_token` accepts `roleId`; `agil_get_access_policy` returns `customRoles`.',
    '',
    '## Security notes',
    '',
    '- Custom role features are always intersected with tenant `features.*` and `deniedFeatures` — a role cannot grant a disabled capability.',
    '- Recording still requires the `recording` feature and a consent flow; baseRole=guest + recording is flagged as a warning.',
    '- Deleting a role does not invalidate live tokens: they fall back to their `baseRole` until expiry.',
  ].join('\n');
}
