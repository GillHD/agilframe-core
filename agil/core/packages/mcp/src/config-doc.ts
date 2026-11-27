/**
 * Machine- and human-readable documentation of the tenant configuration.
 *
 * The markdown is generated from the *real* zod schemas plus `defaultConfig()`,
 * so it can never drift from the validation rules. It is exposed through:
 *  - tool `agil_get_config_schema` (markdown or JSON Schema);
 *  - MCP resource `agil://config/schema` (JSON Schema).
 */
import { defaultConfig, themePresetNames, tenantConfigSchema, type TenantConfig } from '@agil/protocol';
import { z } from 'zod';
import { isPlainObject } from './tool-kit.js';

export const CONFIG_SECTIONS = [
  'branding',
  'theme',
  'features',
  'audio',
  'video',
  'limits',
  'fallback',
  'security',
  'layout',
  'session',
  'room',
  'integrations',
  'providers',
  'scale',
  'billing',
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

export const SECTION_NOTES: Record<ConfigSection, string> = {
  branding:
    'Product and organization identity. `productName`/`logoUrl` are shown in the header; `logoHeightPx` is mirrored into the theme logo token.',
  theme:
    'Design tokens: 36 colors, typography, shape, spacing, background, logo and motion. Everything is rendered through CSS variables, so no widget change is needed. Use presets (`light`, `dark`, `corporate`, `night`, `minimal`) as a starting point.',
  features:
    'Feature switches. Every flag is also a UI switch in the widget; roadmap flags are accepted by the API ahead of time and ignored until implemented.',
  audio:
    'Audio capture/encoding: codec preference, DTX, ptime, Opus bitrate, jitter buffer target.',
  video:
    'Video encoding: codec preference, simulcast/SVC, resolution/fps/bitrate caps, degradation preference, keyframe interval, content hint.',
  limits: 'Room limits enforced by the server (participants, duration, video subscriptions).',
  fallback:
    'Low-bandwidth policy. `lowBandwidth.strategy` decides what degrades first; chat always continues over signaling.',
  security:
    'Join and room security: tokens, waiting room, lock, room password, lockout, geo policy, media integrity, session binding, audit log.',
  layout:
    'Widget layout: grid/spotlight/sidebar, self view, control and chat positions, tile aspect ratio, visible chrome.',
  session:
    'Participant defaults and media features: locale, blur/background, join preferences, recording, transcription, file share, screen share, and the corporate AI agent.',
  room: 'Default room metadata: name, welcome/waiting messages, join/leave sounds.',
  integrations:
    'Boundaries with the company systems: webhooks (signed event delivery), identity federation (token/OIDC), allowed embed origins, postMessage toggle. No company secrets are stored — only env-var names.',
  providers:
    'Replaceable capability providers (6 slots: chat, files, stt, notifications, recording, backgrounds). mode builtin|external|disabled, endpoint + apiKeyEnv (env-var name), timeoutMs, fallback builtin|fail, options. Builtin is the default and needs nothing external (see docs/extensibility.md).',
  scale:
    'Scale-out topology: mediaMode mesh|sfu|broadcast, participant limits (up to 50 000), multi-node signaling (nodeId/redisUrl/pubsubChannel/stickySessions/nodes), SFU (LiveKit/mediasoup), TURN pool (credentialEnv = env-var name), load balancer, webinar/broadcast, streaming egress and CDN. Defaults keep the single-node mesh behaviour (docs/scaling.md).',
  billing:
    'Billing plan and quota enforcement (P2 baseline, no payments/card data): enabled, plan free|team|business|enterprise, includedMinutes per UTC month, maxParticipants, maxRooms, overagePolicy allow|warn|block. Metering is always recorded; enforcement is opt-in (docs/billing.md).',
};

export interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
}

interface JsonSchemaRoot extends JsonSchemaNode {
  $schema?: string;
  definitions?: Record<string, JsonSchemaNode>;
}

/** Full JSON Schema (draft-07) for TenantConfig, inline (no $ref). */
export function configJsonSchema(): JsonSchemaRoot {
  const raw = z.toJSONSchema(tenantConfigSchema, { target: 'draft-07' }) as JsonSchemaRoot;
  return raw;
}

export function sectionJsonSchema(section: ConfigSection): JsonSchemaNode {
  const root = configJsonSchema();
  return root.properties?.[section] ?? { type: 'object', properties: {} };
}

function truncate(value: string, max = 140): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Zod-generated schemas include `default` in `meta`, but be robust to both. */
function schemaDefault(node: JsonSchemaNode): unknown {
  const meta = (node as JsonSchemaNode & { default?: unknown }).default;
  return meta;
}

function formatDefault(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    if (!value) return '`""`';
    const oneLine = value.replace(/\s+/g, ' ');
    return `\`${truncate(oneLine).replace(/`/g, '\\`')}\``;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `\`${String(value)}\``;
  if (value === null) return '`null`';
  const json = truncate(JSON.stringify(value));
  return `\`${json.replace(/`/g, '\\`')}\``;
}

function typeLabel(node: JsonSchemaNode): string {
  if (node.const !== undefined) return `constant \`${String(node.const)}\``;
  if (node.enum) return `one of: ${node.enum.map((item) => `\`${String(item)}\``).join(' | ')}`;
  if (node.anyOf) {
    const labels = node.anyOf.map((branch) => branch.type ?? 'value');
    return `one of: ${labels.join(' | ')}`;
  }
  if (node.type === 'array') {
    const item = node.items;
    if (!item) return 'array';
    if (item.type === 'object' && item.properties) {
      const keys = Object.keys(item.properties);
      const shown = keys.slice(0, 10).join(', ');
      return `array of objects (${shown}${keys.length > 10 ? ', …' : ''})`;
    }
    if (item.enum) return `array of ${item.enum.map((entry) => `\`${String(entry)}\``).join(' | ')}`;
    return `array of ${item.type ?? 'values'}`;
  }
  if (node.type === 'object') {
    const keys = Object.keys(node.properties ?? {});
    if (keys.length > 0) return `object (${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''})`;
    return 'object';
  }
  if (node.type === 'integer') return 'integer';
  if (node.type === 'number') return 'number';
  if (node.type === 'string') return 'string';
  if (node.type === 'boolean') return 'boolean';
  return node.type ?? 'value';
}

function rangeLabel(node: JsonSchemaNode): string | null {
  if (node.type === 'integer' || node.type === 'number') {
    if (node.minimum !== undefined && node.maximum !== undefined) {
      return `${node.minimum}..${node.maximum}`;
    }
    if (node.minimum !== undefined) return `>= ${node.minimum}`;
    if (node.maximum !== undefined) return `<= ${node.maximum}`;
    return null;
  }
  if (node.type === 'string') {
    if (node.minLength !== undefined && node.maxLength !== undefined) {
      return `${node.minLength}..${node.maxLength} chars`;
    }
    if (node.minLength !== undefined && node.minLength > 0) return `min ${node.minLength} chars`;
    if (node.maxLength !== undefined) return `max ${node.maxLength} chars`;
    return null;
  }
  return null;
}

function leafLine(path: string, node: JsonSchemaNode, defaultValue: unknown): string {
  const parts = [`- \`${path}\` — ${typeLabel(node)}`];
  const range = rangeLabel(node);
  if (range) parts.push(`(${range})`);
  if (node.description) parts.push(`— ${node.description}`);
  const def = formatDefault(defaultValue);
  if (def) parts.push(`default: ${def}`);
  return parts.join(' ');
}

/**
 * Renders one schema node. Objects are expanded as headings up to `maxHeadingDepth`
 * (`theme.colors` is depth 3), deeper structures become a single descriptive line.
 */
function renderNode(
  lines: string[],
  path: string,
  node: JsonSchemaNode,
  defaultValue: unknown,
  depth: number,
  maxHeadingDepth: number,
): void {
  const isObject = node.type === 'object' && node.properties && Object.keys(node.properties).length > 0;
  if (isObject && depth <= maxHeadingDepth) {
    const level = Math.min(2 + depth, 6);
    lines.push('', `${'#'.repeat(level)} ${path}`, '');
    const expectedDefault = isPlainObject(defaultValue) ? defaultValue : undefined;
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const childPath = `${path}.${key}`;
      const required = node.required?.includes(key) ?? false;
      const childDefault = expectedDefault?.[key];
      if (child.type === 'object' && child.properties && Object.keys(child.properties).length > 0) {
        renderNode(lines, childPath, child, childDefault, depth + 1, maxHeadingDepth);
        continue;
      }
      const line = leafLine(childPath, child, childDefault);
      lines.push(required ? line : `${line} _(optional)_`);
    }
    return;
  }
  const line = leafLine(path, node, defaultValue);
  lines.push(line);
}

/** Markdown documentation of the whole config or of one section. */
export function configMarkdown(section: ConfigSection | 'all' = 'all'): string {
  const defaults = defaultConfig({ tenantId: 'demo' });
  const root = configJsonSchema();
  const lines: string[] = [];
  lines.push('# AgilFrame TenantConfig');
  lines.push('');
  lines.push(
    '`TenantConfig` is the full tenant configuration. PATCH accepts a **deep-partial** of the same shape ' +
      '(for example `{ "theme": { "colors": { "primary": "#0b5fff" } } }`) — every object can be nested partially.',
  );
  lines.push('');
  lines.push(
    `Structure: ${CONFIG_SECTIONS.map((name) => `\`${name}\``).join(', ')}. ` +
      `Theme presets: ${themePresetNames.map((name) => `\`${name}\``).join(', ')}.`,
  );
  lines.push('');
  lines.push('## Sections');
  lines.push('');
  for (const name of CONFIG_SECTIONS) {
    lines.push(`- \`${name}\` — ${SECTION_NOTES[name]}`);
  }
  lines.push('');

  const sections: ConfigSection[] = section === 'all' ? [...CONFIG_SECTIONS] : [section];
  for (const name of sections) {
    const node = root.properties?.[name];
    if (!node) continue;
    const defaultsSection = (defaults as unknown as Record<string, unknown>)[name];
    renderNode(lines, name, node, defaultsSection, 1, 3);
    lines.push('');
  }
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- Every color token must be a hex value (`#rgb`, `#rrggbb` or `#rrggbbaa`); `theme.colors` has 36 tokens.',
  );
  lines.push(
    '- Prefer `agil_generate_theme` for a coherent palette from a brand color, then `agil_apply_theme_to_config` to merge it.',
  );
  lines.push('- Validate the result with `agil_validate_config` and review contrast issues before saving.');
  return lines.join('\n');
}

/** Default config for the demo tenant, used by docs and tests. */
export function demoDefaultConfig(): TenantConfig {
  return defaultConfig({ tenantId: 'demo' });
}
