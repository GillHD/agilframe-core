/**
 * SCIM 2.0 directory (Users + Groups) for corporate provisioning.
 *
 * Authentication: `Authorization: Bearer $AGIL_SCIM_TOKEN` (501 when the env is
 * missing, 401 for a wrong token) and the tenant from `x-tenant-id`. Data is
 * stored per tenant as an atomic JSON file under `<AGIL_DATA_DIR>/scim/`; no
 * passwords/secrets are ever stored. Roles are mapped only as SCIM data — the
 * server never auto-grants admin rights from SCIM.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { header } from './auth.js';
import type { Env } from './env.js';
import { safeAudit, type RequestContext, type Router } from './http.js';

export const SCIM_CONTENT_TYPE = 'application/scim+json';
const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';

export interface ScimName {
  givenName?: string;
  familyName?: string;
  formatted?: string;
}
export interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}
export interface ScimRole {
  value: string;
  display?: string;
  type?: string;
  /** Optional AGIL role extension; never auto-applied as admin privileges. */
  agilRole?: 'host' | 'moderator' | 'guest';
}
export interface ScimMember {
  value: string;
  display?: string;
  type?: string;
}
export interface ScimMeta {
  resourceType: 'User' | 'Group';
  created: string;
  lastModified: string;
  location: string;
}
export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: ScimName;
  displayName?: string;
  emails?: ScimEmail[];
  active: boolean;
  roles?: ScimRole[];
  groups?: ScimMember[];
  meta: ScimMeta;
}
export interface ScimGroup {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members: ScimMember[];
  meta: ScimMeta;
}

interface ScimFile {
  users: ScimUser[];
  groups: ScimGroup[];
}

function scimFilePath(env: Env, tenantId: string): string {
  return path.join(path.resolve(env.dataDir), 'scim', `${tenantId}.json`);
}

class ScimStore {
  private readonly cache = new Map<string, ScimFile>();

  constructor(private readonly env: Env) {}

  private load(tenantId: string): ScimFile {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;
    const file = scimFilePath(this.env, tenantId);
    let data: ScimFile = { users: [], groups: [] };
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ScimFile>;
        data = {
          users: Array.isArray(parsed.users) ? parsed.users : [],
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        };
      }
    } catch {
      data = { users: [], groups: [] };
    }
    this.cache.set(tenantId, data);
    return data;
  }

  private persist(tenantId: string): void {
    const data = this.load(tenantId);
    const file = scimFilePath(this.env, tenantId);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  }

  users(tenantId: string): ScimUser[] {
    return this.load(tenantId).users;
  }

  groups(tenantId: string): ScimGroup[] {
    return this.load(tenantId).groups;
  }

  createUser(tenantId: string, user: ScimUser): ScimUser {
    const data = this.load(tenantId);
    data.users.push(user);
    this.persist(tenantId);
    return user;
  }

  updateUser(tenantId: string, user: ScimUser): ScimUser {
    const data = this.load(tenantId);
    data.users = data.users.map((entry) => (entry.id === user.id ? user : entry));
    this.persist(tenantId);
    return user;
  }

  deleteUser(tenantId: string, id: string): boolean {
    const data = this.load(tenantId);
    const before = data.users.length;
    data.users = data.users.filter((user) => user.id !== id);
    if (data.users.length !== before) this.persist(tenantId);
    return data.users.length !== before;
  }

  createGroup(tenantId: string, group: ScimGroup): ScimGroup {
    const data = this.load(tenantId);
    data.groups.push(group);
    this.persist(tenantId);
    return group;
  }

  updateGroup(tenantId: string, group: ScimGroup): ScimGroup {
    const data = this.load(tenantId);
    data.groups = data.groups.map((entry) => (entry.id === group.id ? group : entry));
    this.persist(tenantId);
    return group;
  }

  deleteGroup(tenantId: string, id: string): boolean {
    const data = this.load(tenantId);
    const before = data.groups.length;
    data.groups = data.groups.filter((group) => group.id !== id);
    if (data.groups.length !== before) this.persist(tenantId);
    return data.groups.length !== before;
  }
}

const stores = new Map<string, ScimStore>();

function scimStore(env: Env): ScimStore {
  const key = path.resolve(env.dataDir);
  const existing = stores.get(key);
  if (existing) return existing;
  const store = new ScimStore(env);
  stores.set(key, store);
  return store;
}

function sendScim(ctx: RequestContext, status: number, body: unknown, extra: Record<string, string> = {}): void {
  ctx.send(status, body, { 'content-type': `${SCIM_CONTENT_TYPE}; charset=utf-8`, ...extra });
}

function sendScimError(ctx: RequestContext, status: number, detail: string, scimType?: string): void {
  sendScim(ctx, status, {
    schemas: [SCIM_ERROR_SCHEMA],
    ...(scimType ? { scimType } : {}),
    detail,
    status: String(status),
  });
}

/** Validates the SCIM bearer token + tenant header; returns null after answering. */
function authorizeScim(ctx: RequestContext): { tenantId: string } | null {
  const env = ctx.env;
  if (!env.scimToken) {
    sendScimError(ctx, 501, 'SCIM not configured (AGIL_SCIM_TOKEN is not set)');
    return null;
  }
  const authorization = header(ctx.headers, 'authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const provided = match?.[1] ?? '';
  const expected = env.scimToken;
  const ok =
    provided.length > 0 &&
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  if (!ok) {
    sendScimError(ctx, 401, 'Invalid SCIM token');
    return null;
  }
  const rawTenant = (header(ctx.headers, 'x-tenant-id') ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(rawTenant)) {
    sendScimError(ctx, 400, 'x-tenant-id header is required (latin letters, digits, . _ -)');
    return null;
  }
  return { tenantId: rawTenant };
}

function scimAudit(ctx: RequestContext, kind: string, tenantId: string, id: string, userName?: string): void {
  safeAudit(ctx.logger, ctx.services.audit, {
    type: 'admin.action',
    severity: 'info',
    tenantId,
    ip: ctx.ip,
    message: `SCIM ${kind}`,
    details: { kind, id, ...(userName ? { userName } : {}) },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function userLocation(id: string): string {
  return `/scim/v2/Users/${id}`;
}

function groupLocation(id: string): string {
  return `/scim/v2/Groups/${id}`;
}

function normalizeUserName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function userView(user: ScimUser): ScimUser {
  return { ...user, schemas: [USER_SCHEMA] };
}

function groupView(group: ScimGroup): ScimGroup {
  return { ...group, schemas: [GROUP_SCHEMA] };
}

function listResponse(resources: unknown[], total: number, startIndex: number, itemsPerPage: number): unknown {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage,
    Resources: resources,
  };
}

function parseListQuery(ctx: RequestContext): { startIndex: number; count: number; filter: string | null } | null {
  const startRaw = ctx.query.get('startIndex');
  const countRaw = ctx.query.get('count');
  const startIndex = startRaw === null ? 1 : Number(startRaw);
  const count = countRaw === null ? 100 : Number(countRaw);
  if (!Number.isInteger(startIndex) || startIndex < 1) {
    sendScimError(ctx, 400, 'startIndex must be a positive integer');
    return null;
  }
  if (!Number.isInteger(count) || count < 0 || count > 1000) {
    sendScimError(ctx, 400, 'count must be an integer between 0 and 1000');
    return null;
  }
  return { startIndex, count, filter: ctx.query.get('filter') };
}

interface ParsedFilter {
  attribute: string;
  value: string;
}

function parseFilter(filter: string | null, allowed: readonly string[]): ParsedFilter | null | 'invalid' {
  if (!filter || !filter.trim()) return null;
  const match = /^\s*([A-Za-z][A-Za-z0-9._]*)\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
  if (!match?.[1] || !allowed.includes(match[1].toLowerCase())) return 'invalid';
  return { attribute: match[1].toLowerCase(), value: match[2] ?? '' };
}

function filterUsers(users: ScimUser[], filter: ParsedFilter | null): ScimUser[] {
  if (!filter) return users;
  const needle = filter.value.toLowerCase();
  return users.filter((user) => {
    if (filter.attribute === 'username') return user.userName.toLowerCase() === needle;
    if (filter.attribute === 'displayname') return (user.displayName ?? user.name?.formatted ?? '').toLowerCase() === needle;
    if (filter.attribute === 'emails.value') return (user.emails ?? []).some((email) => email.value.toLowerCase() === needle);
    return false;
  });
}

function filterGroups(groups: ScimGroup[], filter: ParsedFilter | null): ScimGroup[] {
  if (!filter) return groups;
  if (filter.attribute !== 'displayname') return [];
  return groups.filter((group) => group.displayName.toLowerCase() === filter.value.toLowerCase());
}

function validateUserBody(body: Record<string, unknown>): string | null {
  if (!normalizeUserName(body.userName)) return 'userName is required';
  if (body.emails !== undefined && !Array.isArray(body.emails)) return 'emails must be an array';
  if (body.roles !== undefined && !Array.isArray(body.roles)) return 'roles must be an array';
  return null;
}

function validateGroupBody(body: Record<string, unknown>): string | null {
  if (typeof body.displayName !== 'string' || !body.displayName.trim()) return 'displayName is required';
  if (body.members !== undefined && !Array.isArray(body.members)) return 'members must be an array';
  return null;
}

function buildUser(body: Record<string, unknown>, id: string, created: string): ScimUser {
  return {
    schemas: [USER_SCHEMA],
    id,
    ...(typeof body.externalId === 'string' ? { externalId: body.externalId.slice(0, 200) } : {}),
    userName: normalizeUserName(body.userName),
    ...(body.name && typeof body.name === 'object' ? { name: body.name as ScimName } : {}),
    ...(typeof body.displayName === 'string' ? { displayName: body.displayName.slice(0, 200) } : {}),
    ...(Array.isArray(body.emails)
      ? {
          emails: body.emails
            .filter((email): email is Record<string, unknown> => Boolean(email) && typeof email === 'object')
            .map((email) => ({
              value: String(email.value ?? '').slice(0, 200),
              ...(typeof email.type === 'string' ? { type: email.type } : {}),
              ...(typeof email.primary === 'boolean' ? { primary: email.primary } : {}),
            }))
            .filter((email) => email.value),
        }
      : {}),
    active: body.active === undefined ? true : Boolean(body.active),
    ...(Array.isArray(body.roles) ? { roles: body.roles as ScimRole[] } : {}),
    groups: [],
    meta: { resourceType: 'User', created, lastModified: created, location: userLocation(id) },
  };
}

function buildGroup(body: Record<string, unknown>, id: string, created: string): ScimGroup {
  return {
    schemas: [GROUP_SCHEMA],
    id,
    ...(typeof body.externalId === 'string' ? { externalId: body.externalId.slice(0, 200) } : {}),
    displayName: String(body.displayName).trim().slice(0, 200),
    members: Array.isArray(body.members)
      ? body.members
          .filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === 'object' && typeof member.value === 'string')
          .map((member) => ({
            value: String(member.value),
            ...(typeof member.display === 'string' ? { display: member.display } : {}),
            ...(typeof member.type === 'string' ? { type: member.type } : {}),
          }))
      : [],
    meta: { resourceType: 'Group', created, lastModified: created, location: groupLocation(id) },
  };
}

/** Handles a single PATCH operation for users/groups (add/replace/remove). */
function applyPatch(target: Record<string, unknown>, operations: unknown): string | null {
  if (!Array.isArray(operations)) return 'Operations must be an array';
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object') return 'Invalid patch operation';
    const op = String((raw as Record<string, unknown>).op ?? '').toLowerCase();
    const pathRaw = (raw as Record<string, unknown>).path;
    if (!['add', 'replace', 'remove'].includes(op)) return `Unsupported patch op: ${op}`;
    if (typeof pathRaw !== 'string' || !pathRaw.trim()) return 'Patch path is required';
    const pathValue = pathRaw.trim().toLowerCase();
    const value = (raw as Record<string, unknown>).value;
    if (pathValue === 'active') {
      if (op === 'remove') target.active = false;
      else target.active = Boolean(value);
      continue;
    }
    if (pathValue === 'username') {
      if (op === 'remove' || typeof value !== 'string' || !value.trim()) return 'userName cannot be removed';
      target.userName = value.trim();
      continue;
    }
    if (pathValue === 'displayname') {
      if (op === 'remove' || typeof value !== 'string' || !value.trim()) return 'displayName cannot be removed';
      target.displayName = value.trim();
      continue;
    }
    if (pathValue === 'name.givenname') {
      const name = (target.name && typeof target.name === 'object' ? target.name : {}) as Record<string, unknown>;
      if (op === 'remove') delete name.givenName;
      else name.givenName = String(value ?? '');
      target.name = name;
      continue;
    }
    if (pathValue === 'name.familyname') {
      const name = (target.name && typeof target.name === 'object' ? target.name : {}) as Record<string, unknown>;
      if (op === 'remove') delete name.familyName;
      else name.familyName = String(value ?? '');
      target.name = name;
      continue;
    }
    if (pathValue === 'emails') {
      if (op === 'remove') target.emails = [];
      else if (Array.isArray(value)) target.emails = value;
      else return 'emails value must be an array';
      continue;
    }
    if (pathValue === 'roles') {
      if (op === 'remove') target.roles = [];
      else if (Array.isArray(value)) target.roles = value;
      else return 'roles value must be an array';
      continue;
    }
    if (pathValue === 'members') {
      if (op === 'remove') target.members = [];
      else if (Array.isArray(value)) target.members = value;
      else return 'members value must be an array';
      continue;
    }
    if (pathValue === 'externalid') {
      if (op === 'remove') delete target.externalId;
      else target.externalId = String(value ?? '');
      continue;
    }
    return `Unsupported patch path: ${pathRaw}`;
  }
  return null;
}

async function readBody(ctx: RequestContext): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await ctx.json();
  } catch {
    sendScimError(ctx, 400, 'Malformed SCIM JSON body', 'invalidSyntax');
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendScimError(ctx, 400, 'SCIM body must be a JSON object', 'invalidSyntax');
    return null;
  }
  return body as Record<string, unknown>;
}

async function usersList(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const query = parseListQuery(ctx);
  if (!query) return;
  const parsedFilter = parseFilter(query.filter, ['username', 'displayname', 'emails.value']);
  if (parsedFilter === 'invalid') {
    sendScimError(ctx, 400, 'Unsupported filter; use userName/displayName/emails.value eq "value"', 'invalidFilter');
    return;
  }
  const all = filterUsers(scimStore(ctx.env).users(auth.tenantId), parsedFilter);
  const page = all.slice(query.startIndex - 1, query.startIndex - 1 + query.count);
  sendScim(ctx, 200, listResponse(page.map(userView), all.length, query.startIndex, page.length));
}

async function usersCreate(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const body = await readBody(ctx);
  if (!body) return;
  const issue = validateUserBody(body);
  if (issue) {
    sendScimError(ctx, 400, issue, 'invalidValue');
    return;
  }
  const userName = normalizeUserName(body.userName);
  const users = scimStore(ctx.env).users(auth.tenantId);
  if (users.some((user) => user.userName.toLowerCase() === userName.toLowerCase())) {
    sendScimError(ctx, 409, `User '${userName}' already exists`, 'uniqueness');
    return;
  }
  const created = nowIso();
  const user = buildUser(body, randomUUID(), created);
  scimStore(ctx.env).createUser(auth.tenantId, user);
  scimAudit(ctx, 'scim.user.created', auth.tenantId, user.id, user.userName);
  ctx.res.setHeader('location', user.meta.location);
  sendScim(ctx, 201, userView(user));
}

async function usersGet(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const id = String(ctx.params.id ?? '');
  const user = scimStore(ctx.env).users(auth.tenantId).find((entry) => entry.id === id);
  if (!user) {
    sendScimError(ctx, 404, 'User not found');
    return;
  }
  sendScim(ctx, 200, userView(user));
}

async function usersPut(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const id = String(ctx.params.id ?? '');
  const body = await readBody(ctx);
  if (!body) return;
  const issue = validateUserBody(body);
  if (issue) {
    sendScimError(ctx, 400, issue, 'invalidValue');
    return;
  }
  const store = scimStore(ctx.env);
  const existing = store.users(auth.tenantId).find((entry) => entry.id === id);
  if (!existing) {
    sendScimError(ctx, 404, 'User not found');
    return;
  }
  const userName = normalizeUserName(body.userName);
  if (store.users(auth.tenantId).some((user) => user.id !== id && user.userName.toLowerCase() === userName.toLowerCase())) {
    sendScimError(ctx, 409, `User '${userName}' already exists`, 'uniqueness');
    return;
  }
  const updated = buildUser(body, id, existing.meta.created);
  updated.groups = existing.groups ?? [];
  store.updateUser(auth.tenantId, updated);
  scimAudit(ctx, 'scim.user.updated', auth.tenantId, id, updated.userName);
  sendScim(ctx, 200, userView(updated));
}

async function usersPatch(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const id = String(ctx.params.id ?? '');
  const body = await readBody(ctx);
  if (!body) return;
  const store = scimStore(ctx.env);
  const existing = store.users(auth.tenantId).find((entry) => entry.id === id);
  if (!existing) {
    sendScimError(ctx, 404, 'User not found');
    return;
  }
  const draft = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;
  const issue = applyPatch(draft, body.Operations);
  if (issue) {
    sendScimError(ctx, 400, issue, 'invalidValue');
    return;
  }
  const updated = buildUser(draft, id, existing.meta.created);
  updated.groups = existing.groups ?? [];
  if (store.users(auth.tenantId).some((user) => user.id !== id && user.userName.toLowerCase() === updated.userName.toLowerCase())) {
    sendScimError(ctx, 409, `User '${updated.userName}' already exists`, 'uniqueness');
    return;
  }
  store.updateUser(auth.tenantId, updated);
  scimAudit(ctx, 'scim.user.updated', auth.tenantId, id, updated.userName);
  sendScim(ctx, 200, userView(updated));
}

async function usersDelete(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const id = String(ctx.params.id ?? '');
  const removed = scimStore(ctx.env).deleteUser(auth.tenantId, id);
  if (!removed) {
    sendScimError(ctx, 404, 'User not found');
    return;
  }
  scimAudit(ctx, 'scim.user.deleted', auth.tenantId, id);
  ctx.res.statusCode = 204;
  ctx.res.setHeader('content-type', SCIM_CONTENT_TYPE);
  ctx.res.end();
}

async function groupsList(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const query = parseListQuery(ctx);
  if (!query) return;
  const parsedFilter = parseFilter(query.filter, ['displayname']);
  if (parsedFilter === 'invalid') {
    sendScimError(ctx, 400, 'Unsupported filter; use displayName eq "value"', 'invalidFilter');
    return;
  }
  const all = filterGroups(scimStore(ctx.env).groups(auth.tenantId), parsedFilter);
  const page = all.slice(query.startIndex - 1, query.startIndex - 1 + query.count);
  sendScim(ctx, 200, listResponse(page.map(groupView), all.length, query.startIndex, page.length));
}

async function groupsCreate(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const body = await readBody(ctx);
  if (!body) return;
  const issue = validateGroupBody(body);
  if (issue) {
    sendScimError(ctx, 400, issue, 'invalidValue');
    return;
  }
  const displayName = String(body.displayName).trim();
  if (scimStore(ctx.env).groups(auth.tenantId).some((group) => group.displayName.toLowerCase() === displayName.toLowerCase())) {
    sendScimError(ctx, 409, `Group '${displayName}' already exists`, 'uniqueness');
    return;
  }
  const group = buildGroup(body, randomUUID(), nowIso());
  scimStore(ctx.env).createGroup(auth.tenantId, group);
  scimAudit(ctx, 'scim.group.created', auth.tenantId, group.id, group.displayName);
  ctx.res.setHeader('location', group.meta.location);
  sendScim(ctx, 201, groupView(group));
}

async function groupsGet(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const group = scimStore(ctx.env).groups(auth.tenantId).find((entry) => entry.id === String(ctx.params.id ?? ''));
  if (!group) {
    sendScimError(ctx, 404, 'Group not found');
    return;
  }
  sendScim(ctx, 200, groupView(group));
}

async function groupsPut(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const id = String(ctx.params.id ?? '');
  const body = await readBody(ctx);
  if (!body) return;
  const issue = validateGroupBody(body);
  if (issue) {
    sendScimError(ctx, 400, issue, 'invalidValue');
    return;
  }
  const store = scimStore(ctx.env);
  const existing = store.groups(auth.tenantId).find((entry) => entry.id === id);
  if (!existing) {
    sendScimError(ctx, 404, 'Group not found');
    return;
  }
  const displayName = String(body.displayName).trim();
  if (store.groups(auth.tenantId).some((group) => group.id !== id && group.displayName.toLowerCase() === displayName.toLowerCase())) {
    sendScimError(ctx, 409, `Group '${displayName}' already exists`, 'uniqueness');
    return;
  }
  const updated = buildGroup(body, id, existing.meta.created);
  store.updateGroup(auth.tenantId, updated);
  scimAudit(ctx, 'scim.group.updated', auth.tenantId, id, updated.displayName);
  sendScim(ctx, 200, groupView(updated));
}

async function groupsPatch(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const id = String(ctx.params.id ?? '');
  const body = await readBody(ctx);
  if (!body) return;
  const store = scimStore(ctx.env);
  const existing = store.groups(auth.tenantId).find((entry) => entry.id === id);
  if (!existing) {
    sendScimError(ctx, 404, 'Group not found');
    return;
  }
  const draft = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;
  const issue = applyPatch(draft, body.Operations);
  if (issue) {
    sendScimError(ctx, 400, issue, 'invalidValue');
    return;
  }
  const updated = buildGroup(draft, id, existing.meta.created);
  store.updateGroup(auth.tenantId, updated);
  scimAudit(ctx, 'scim.group.updated', auth.tenantId, id, updated.displayName);
  sendScim(ctx, 200, groupView(updated));
}

async function groupsDelete(ctx: RequestContext): Promise<void> {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  const id = String(ctx.params.id ?? '');
  if (!scimStore(ctx.env).deleteGroup(auth.tenantId, id)) {
    sendScimError(ctx, 404, 'Group not found');
    return;
  }
  scimAudit(ctx, 'scim.group.deleted', auth.tenantId, id);
  ctx.res.statusCode = 204;
  ctx.res.setHeader('content-type', SCIM_CONTENT_TYPE);
  ctx.res.end();
}

function serviceProviderConfig(ctx: RequestContext): void {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  sendScim(ctx, 200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: '/docs/api.md',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 1000 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer',
        description: 'AGIL_SCIM_TOKEN',
        primary: true,
      },
    ],
    meta: {
      resourceType: 'ServiceProviderConfig',
      location: '/scim/v2/ServiceProviderConfig',
    },
  });
}

function schemasHandler(ctx: RequestContext): void {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  sendScim(ctx, 200, listResponse([
    {
      id: USER_SCHEMA,
      name: 'User',
      description: 'SCIM 2.0 User',
      attributes: [
        { name: 'userName', type: 'string', required: true, uniqueness: 'server' },
        { name: 'name', type: 'complex', subAttributes: [{ name: 'givenName', type: 'string' }, { name: 'familyName', type: 'string' }] },
        { name: 'emails', type: 'complex', multiValued: true, subAttributes: [{ name: 'value', type: 'string' }, { name: 'type', type: 'string' }] },
        { name: 'active', type: 'boolean' },
        { name: 'roles', type: 'complex', multiValued: true },
        { name: 'groups', type: 'complex', multiValued: true, mutability: 'readOnly' },
      ],
    },
    {
      id: GROUP_SCHEMA,
      name: 'Group',
      description: 'SCIM 2.0 Group',
      attributes: [
        { name: 'displayName', type: 'string', required: true, uniqueness: 'server' },
        { name: 'members', type: 'complex', multiValued: true, subAttributes: [{ name: 'value', type: 'string' }, { name: 'display', type: 'string' }] },
      ],
    },
  ], 2, 1, 2));
}

function resourceTypesHandler(ctx: RequestContext): void {
  const auth = authorizeScim(ctx);
  if (!auth) return;
  sendScim(ctx, 200, listResponse([
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: USER_SCHEMA,
      meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/User' },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: GROUP_SCHEMA,
      meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/Group' },
    },
  ], 2, 1, 2));
}

/** Registers the SCIM 2.0 endpoints (outside /v1; bearer token + x-tenant-id). */
export function registerScimRoutes(router: Router): void {
  router.get('/scim/v2/Users', usersList);
  router.post('/scim/v2/Users', usersCreate);
  router.get('/scim/v2/Users/:id', usersGet);
  router.put('/scim/v2/Users/:id', usersPut);
  router.patch('/scim/v2/Users/:id', usersPatch);
  router.delete('/scim/v2/Users/:id', usersDelete);
  router.get('/scim/v2/Groups', groupsList);
  router.post('/scim/v2/Groups', groupsCreate);
  router.get('/scim/v2/Groups/:id', groupsGet);
  router.put('/scim/v2/Groups/:id', groupsPut);
  router.patch('/scim/v2/Groups/:id', groupsPatch);
  router.delete('/scim/v2/Groups/:id', groupsDelete);
  router.get('/scim/v2/ServiceProviderConfig', serviceProviderConfig);
  router.get('/scim/v2/Schemas', schemasHandler);
  router.get('/scim/v2/ResourceTypes', resourceTypesHandler);
  void SCIM_PATCH_SCHEMA;
  void USER_SCHEMA;
  void GROUP_SCHEMA;
  void SCIM_LIST_SCHEMA;
  void SCIM_ERROR_SCHEMA;
  void SCIM_CONTENT_TYPE;
}
