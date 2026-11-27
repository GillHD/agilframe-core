/**
 * SCIM 2.0 provisioning tools (contract §32, docs/api.md).
 *
 * Auth: `Authorization: Bearer $AGIL_SCIM_TOKEN` (env only), tenant from the
 * `tenantId` argument via `x-tenant-id`, media type `application/scim+json`.
 * The token never appears in tool errors, results or logs.
 *
 * Read tools: scim_list_users, scim_get_user, scim_list_groups,
 * scim_service_provider_config. Write tools: create/update/delete for users and
 * groups (excluded in AGIL_MCP_MODE=read).
 */
import { z } from 'zod';
import { ApiError, ServerUnavailableError } from '../http-client.js';
import { defineTool, jsonOutcome, ToolError, type AnyToolSpec, type ToolContext } from '../tool-kit.js';

const tenantIdSchema = z.string().min(1).max(64).describe('Tenant id sent as x-tenant-id');
const scimIdSchema = z.string().min(1).max(128).describe('SCIM resource id');

const scimNameSchema = z.object({
  givenName: z.string().max(100).optional(),
  familyName: z.string().max(100).optional(),
  formatted: z.string().max(200).optional(),
});

const scimEmailSchema = z.object({
  value: z.string().min(3).max(320),
  primary: z.boolean().optional(),
  type: z.enum(['work', 'home', 'other']).optional(),
});

const scimRoleSchema = z.object({
  value: z.string().min(1).max(100).describe('SCIM role value, e.g. employee'),
  display: z.string().max(100).optional(),
  type: z.string().max(50).optional(),
  agilRole: z.enum(['host', 'moderator', 'guest']).optional().describe('AGIL role hint (does not grant admin rights)'),
});

const scimMemberSchema = z.object({
  value: z.string().min(1).max(128).describe('Group member id'),
  display: z.string().max(200).optional(),
  type: z.enum(['User', 'Group']).optional(),
});

const createUserSchema = z.object({
  tenantId: tenantIdSchema,
  userName: z.string().min(1).max(320).describe('Unique userName / login / email'),
  name: scimNameSchema.optional(),
  emails: z.array(scimEmailSchema).min(1).max(20).optional(),
  active: z.boolean().optional(),
  roles: z.array(scimRoleSchema).max(50).optional(),
  externalId: z.string().max(200).optional(),
});

const updateUserSchema = z.object({
  tenantId: tenantIdSchema,
  id: scimIdSchema,
  active: z.boolean().optional(),
  userName: z.string().min(1).max(320).optional(),
  name: scimNameSchema.optional(),
  emails: z.array(scimEmailSchema).min(1).max(20).optional(),
  roles: z.array(scimRoleSchema).max(50).optional(),
});

const createGroupSchema = z.object({
  tenantId: tenantIdSchema,
  displayName: z.string().min(1).max(200),
  members: z.array(scimMemberSchema).max(1000).optional(),
  externalId: z.string().max(200).optional(),
});

const updateGroupSchema = z.object({
  tenantId: tenantIdSchema,
  id: scimIdSchema,
  displayName: z.string().min(1).max(200).optional(),
  members: z.array(scimMemberSchema).max(1000).optional(),
});

const listSchema = z.object({
  tenantId: tenantIdSchema,
  filter: z.string().max(500).optional().describe('SCIM filter, e.g. userName eq "alice@example.com"'),
  startIndex: z.number().int().min(1).max(1000000).optional(),
  count: z.number().int().min(1).max(1000).optional(),
});

const getSchema = z.object({ tenantId: tenantIdSchema, id: scimIdSchema });
const deleteSchema = z.object({ tenantId: tenantIdSchema, id: scimIdSchema });
const configSchema = z.object({ tenantId: tenantIdSchema });

const USER_PATH = '/scim/v2/Users';
const GROUP_PATH = '/scim/v2/Groups';

function ensureScim(ctx: ToolContext): void {
  if (!ctx.env.scimToken) {
    throw new ToolError(
      'SCIM не настроен: переменная окружения AGIL_SCIM_TOKEN не задана.',
      'Попросите администратора выдать SCIM Bearer-токен и запустить MCP с AGIL_SCIM_TOKEN. Токен не передаётся аргументами и не логируется.',
    );
  }
}

function scimFailure(error: unknown, action: string): never {
  if (error instanceof ServerUnavailableError) {
    throw new ToolError(
      `${action}: SCIM-сервер недоступен (${error.reason}).`,
      'Проверьте AGIL_SERVER_URL и доступность сервера; SCIM endpoints — /scim/v2/*.',
    );
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      throw new ToolError(`${action}: SCIM отклонил токен (401).`, 'Проверьте AGIL_SCIM_TOKEN: он должен совпадать с токеном сервера. Токен не печатается.');
    }
    if (error.status === 403) {
      throw new ToolError(`${action}: SCIM запрещён (403).`, 'Проверьте права SCIM-токена и tenantId/x-tenant-id.');
    }
    if (error.status === 404) {
      throw new ToolError(`${action}: пользователь или группа не найдены (404).`, 'Проверьте id/tenantId; список — scim_list_users / scim_list_groups.');
    }
    if (error.status === 409) {
      throw new ToolError(`${action}: конфликт уникальности (409).`, 'userName/displayName уже существует; используйте другой идентификатор или PATCH существующего.');
    }
    if (error.status === 501) {
      throw new ToolError(`${action}: SCIM не включён на сервере (501).`, 'Сервер должен быть запущен с AGIL_SCIM_TOKEN, иначе SCIM отключён.');
    }
    throw new ToolError(`${action}: SCIM вернул ошибку ${error.status}.`, 'Проверьте корректность SCIM-payload и tenantId; подробности — в логах сервера без секретов.');
  }
  throw error;
}

async function callScim<T>(ctx: ToolContext, tenantId: string, path: string, options: Parameters<ToolContext['client']['scim']>[2] = {}): Promise<T> {
  ensureScim(ctx);
  try {
    return await ctx.client.scim<T>(tenantId, path, options);
  } catch (error) {
    scimFailure(error, options.method === 'GET' ? 'Получение SCIM' : 'Операция SCIM');
  }
}

function buildUserPatch(args: z.output<typeof updateUserSchema>): Record<string, unknown> {
  const operations: Array<Record<string, unknown>> = [];
  if (args.active !== undefined) operations.push({ op: 'replace', path: 'active', value: args.active });
  if (args.userName !== undefined) operations.push({ op: 'replace', path: 'userName', value: args.userName });
  if (args.name?.givenName !== undefined) operations.push({ op: 'replace', path: 'name.givenName', value: args.name.givenName });
  if (args.name?.familyName !== undefined) operations.push({ op: 'replace', path: 'name.familyName', value: args.name.familyName });
  if (args.name?.formatted !== undefined) operations.push({ op: 'replace', path: 'name.formatted', value: args.name.formatted });
  if (args.emails !== undefined) operations.push({ op: 'replace', path: 'emails', value: args.emails });
  if (args.roles !== undefined) operations.push({ op: 'replace', path: 'roles', value: args.roles });
  if (operations.length === 0) {
    throw new ToolError(
      'Нет изменений для SCIM PATCH.',
      'Передайте хотя бы одно из полей: active, userName, name, emails, roles.',
    );
  }
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: operations,
  };
}

function buildGroupPatch(args: z.output<typeof updateGroupSchema>): Record<string, unknown> {
  const operations: Array<Record<string, unknown>> = [];
  if (args.displayName !== undefined) operations.push({ op: 'replace', path: 'displayName', value: args.displayName });
  if (args.members !== undefined) operations.push({ op: 'replace', path: 'members', value: args.members });
  if (operations.length === 0) {
    throw new ToolError('Нет изменений для SCIM PATCH группы.', 'Передайте displayName и/или members.');
  }
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: operations,
  };
}

function userBody(args: z.output<typeof createUserSchema>): Record<string, unknown> {
  const body: Record<string, unknown> = { userName: args.userName };
  if (args.name !== undefined) body.name = args.name;
  if (args.emails !== undefined) body.emails = args.emails;
  if (args.active !== undefined) body.active = args.active;
  if (args.roles !== undefined) body.roles = args.roles;
  if (args.externalId !== undefined) body.externalId = args.externalId;
  return body;
}

function groupBody(args: z.output<typeof createGroupSchema>): Record<string, unknown> {
  const body: Record<string, unknown> = { displayName: args.displayName };
  if (args.members !== undefined) body.members = args.members;
  if (args.externalId !== undefined) body.externalId = args.externalId;
  return body;
}

export function scimToolSpecs(): AnyToolSpec[] {
  return [
    defineTool({
      name: 'scim_list_users',
      title: 'List SCIM users',
      description:
        'List provisioned users in a tenant via GET /scim/v2/Users (SCIM ListResponse). ' +
        'Supports an optional SCIM filter (userName/emails.value eq "…"), startIndex and count (1–1000). ' +
        'Read-only; auth uses AGIL_SCIM_TOKEN from the environment, tenant via x-tenant-id.',
      online: true,
      inputSchema: listSchema,
      handler: async (args, ctx) => {
        const query = {
          ...(args.filter ? { filter: args.filter } : {}),
          ...(args.startIndex !== undefined ? { startIndex: args.startIndex } : {}),
          ...(args.count !== undefined ? { count: args.count } : {}),
        };
        const payload = await callScim<Record<string, unknown>>(ctx, args.tenantId, USER_PATH, { method: 'GET', query });
        return jsonOutcome({ tenantId: args.tenantId, ...payload });
      },
    }),

    defineTool({
      name: 'scim_get_user',
      title: 'Get SCIM user',
      description: 'Read a user by id via GET /scim/v2/Users/:id (SCIM User resource). Read-only.',
      online: true,
      inputSchema: getSchema,
      handler: async (args, ctx) => {
        const payload = await callScim<Record<string, unknown>>(ctx, args.tenantId, `${USER_PATH}/${encodeURIComponent(args.id)}`, { method: 'GET' });
        return jsonOutcome(payload);
      },
    }),

    defineTool({
      name: 'scim_create_user',
      title: 'Create SCIM user',
      description:
        'Provision a user via POST /scim/v2/Users: userName (required), name, emails, active, roles (roles are data only and do not grant admin rights). ' +
        'Write tool; excluded in read-only mode. Errors are actionable Russian SCIM messages (401/409/501).',
      online: true,
      write: true,
      inputSchema: createUserSchema,
      handler: async (args, ctx) => {
        const payload = await callScim<Record<string, unknown>>(ctx, args.tenantId, USER_PATH, { method: 'POST', body: userBody(args) });
        return jsonOutcome({ created: true, tenantId: args.tenantId, user: payload });
      },
    }),

    defineTool({
      name: 'scim_update_user',
      title: 'Update SCIM user (PATCH)',
      description:
        'Patch a user via PATCH /scim/v2/Users/:id with SCIM PatchOp operations for active, userName, name (given/family/formatted), emails and roles. ' +
        'Write tool; at least one field is required; excluded in read-only mode.',
      online: true,
      write: true,
      inputSchema: updateUserSchema,
      handler: async (args, ctx) => {
        const payload = await callScim<Record<string, unknown>>(ctx, args.tenantId, `${USER_PATH}/${encodeURIComponent(args.id)}`, {
          method: 'PATCH',
          body: buildUserPatch(args),
        });
        return jsonOutcome({ updated: true, tenantId: args.tenantId, user: payload });
      },
    }),

    defineTool({
      name: 'scim_delete_user',
      title: 'Delete SCIM user',
      description:
        'Delete a user via DELETE /scim/v2/Users/:id (hard delete; active:false is soft deactivation through scim_update_user). ' +
        'Write tool; excluded in read-only mode.',
      online: true,
      write: true,
      inputSchema: deleteSchema,
      handler: async (args, ctx) => {
        await callScim<unknown>(ctx, args.tenantId, `${USER_PATH}/${encodeURIComponent(args.id)}`, { method: 'DELETE' });
        return jsonOutcome({ deleted: true, tenantId: args.tenantId, id: args.id });
      },
    }),

    defineTool({
      name: 'scim_list_groups',
      title: 'List SCIM groups',
      description:
        'List groups via GET /scim/v2/Groups (SCIM ListResponse); optional filter (displayName eq "…"), startIndex, count. Read-only.',
      online: true,
      inputSchema: listSchema,
      handler: async (args, ctx) => {
        const query = {
          ...(args.filter ? { filter: args.filter } : {}),
          ...(args.startIndex !== undefined ? { startIndex: args.startIndex } : {}),
          ...(args.count !== undefined ? { count: args.count } : {}),
        };
        const payload = await callScim<Record<string, unknown>>(ctx, args.tenantId, GROUP_PATH, { method: 'GET', query });
        return jsonOutcome({ tenantId: args.tenantId, ...payload });
      },
    }),

    defineTool({
      name: 'scim_create_group',
      title: 'Create SCIM group',
      description: 'Create a group via POST /scim/v2/Groups: displayName (required), members (user ids), externalId. Write tool.',
      online: true,
      write: true,
      inputSchema: createGroupSchema,
      handler: async (args, ctx) => {
        const payload = await callScim<Record<string, unknown>>(ctx, args.tenantId, GROUP_PATH, { method: 'POST', body: groupBody(args) });
        return jsonOutcome({ created: true, tenantId: args.tenantId, group: payload });
      },
    }),

    defineTool({
      name: 'scim_update_group',
      title: 'Update SCIM group (PATCH)',
      description: 'Patch a group via PATCH /scim/v2/Groups/:id for displayName and/or members. Write tool; at least one field is required.',
      online: true,
      write: true,
      inputSchema: updateGroupSchema,
      handler: async (args, ctx) => {
        const payload = await callScim<Record<string, unknown>>(ctx, args.tenantId, `${GROUP_PATH}/${encodeURIComponent(args.id)}`, {
          method: 'PATCH',
          body: buildGroupPatch(args),
        });
        return jsonOutcome({ updated: true, tenantId: args.tenantId, group: payload });
      },
    }),

    defineTool({
      name: 'scim_delete_group',
      title: 'Delete SCIM group',
      description: 'Delete a group via DELETE /scim/v2/Groups/:id. Write tool; excluded in read-only mode.',
      online: true,
      write: true,
      inputSchema: deleteSchema,
      handler: async (args, ctx) => {
        await callScim<unknown>(ctx, args.tenantId, `${GROUP_PATH}/${encodeURIComponent(args.id)}`, { method: 'DELETE' });
        return jsonOutcome({ deleted: true, tenantId: args.tenantId, id: args.id });
      },
    }),

    defineTool({
      name: 'scim_service_provider_config',
      title: 'SCIM ServiceProviderConfig',
      description:
        'Read GET /scim/v2/ServiceProviderConfig: supported SCIM features (patch/filter), maxResults 1000. Read-only; useful before provisioning.',
      online: true,
      inputSchema: configSchema,
      handler: async (args, ctx) => {
        const payload = await callScim<Record<string, unknown>>(ctx, args.tenantId, '/scim/v2/ServiceProviderConfig', { method: 'GET' });
        return jsonOutcome({ tenantId: args.tenantId, serviceProviderConfig: payload });
      },
    }),
  ];
}
