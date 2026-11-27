/**
 * Small toolkit shared by all MCP tools:
 *  - a typed `defineTool` helper whose handlers get validated zod input;
 *  - conversion of zod schemas into MCP JSON Schema (`inputSchema`);
 *  - uniform, LLM-friendly error/result formatting (never leaks API keys).
 */
import { z } from 'zod';
import type { McpEnv } from './env.js';
import type { AgilHttpClient } from './http-client.js';

export interface ToolContext {
  client: AgilHttpClient;
  env: McpEnv;
}

/** What a tool returns to the model. `text` is the tool content (JSON or markdown). */
export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

/** A user-facing, actionable tool failure (validation, bad input, impossible request). */
export class ToolError extends Error {
  readonly kind = 'tool_error';

  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(hint ? `${message} ${hint}` : message);
    this.name = 'ToolError';
  }
}

export interface ToolSpecDefinition<S extends z.ZodTypeAny> {
  name: string;
  /** Short human-readable tool title shown by MCP clients. */
  title: string;
  /** English, LLM-oriented description: what it does, when to use it, what it returns. */
  description: string;
  inputSchema: S;
  /** True when the tool needs a live AGIL HTTP server (for docs/instructions). */
  online?: boolean;
  /** True for mutating tools; excluded from AGIL_MCP_MODE=read. */
  write?: boolean;
  handler: (args: z.output<S>, ctx: ToolContext) => Promise<ToolOutcome> | ToolOutcome;
}

/**
 * Type-erased tool spec. Handlers were type-checked against their own zod schema
 * inside `defineTool`, so the erased `unknown` argument is safe here.
 */
export interface AnyToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  online: boolean;
  write: boolean;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolOutcome> | ToolOutcome;
}

export function defineTool<S extends z.ZodTypeAny>(spec: ToolSpecDefinition<S>): AnyToolSpec {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    online: spec.online ?? false,
    write: spec.write ?? false,
    handler: (args, ctx) => spec.handler(args as z.output<S>, ctx),
  };
}

export interface RegisteredTool {
  name: string;
  title: string;
  description: string;
  /** True when the tool needs a live AGIL server. */
  online: boolean;
  /** True for mutating tools (see AGIL_MCP_MODE). */
  write: boolean;
  /** JSON Schema object advertised through `tools/list`. */
  inputSchema: Record<string, unknown>;
  run: (rawArgs: unknown) => Promise<ToolOutcome>;
}

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = z.toJSONSchema(schema, { target: 'draft-07', io: 'input' });
  delete converted.$schema;
  if (converted.type !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  return converted;
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `- ${path}: ${issue.message}`;
  });
}

function formatInputError(toolName: string, error: z.ZodError): string {
  const lines = formatZodIssues(error);
  const hint =
    toolName.includes('config') || toolName.includes('theme')
      ? 'Hint: pass JSON objects (a full TenantConfig or a deep-partial patch). ' +
        'Call agil_get_config_schema to inspect every field, type and default.'
      : 'Hint: check the tool input schema returned by tools/list.';
  return `Invalid arguments for "${toolName}":\n${lines.join('\n')}\n${hint}`;
}

/** Maps any thrown error to a safe `isError: true` tool result. */
export function formatToolError(error: unknown): string {
  if (error instanceof ToolError) return `Error: ${error.message}`;
  const maybe = error as { message?: unknown };
  const message = typeof maybe?.message === 'string' ? maybe.message : String(error);
  return `Error: ${message}`;
}

/** Builds the registered tool list from specs, binding the shared context. */
export function registerTools(specs: readonly AnyToolSpec[], ctx: ToolContext): RegisteredTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    online: spec.online,
    write: spec.write,
    inputSchema: toJsonSchema(spec.inputSchema),
    async run(rawArgs: unknown): Promise<ToolOutcome> {
      const parsed = spec.inputSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return { isError: true, text: formatInputError(spec.name, parsed.error) };
      }
      try {
        return await spec.handler(parsed.data, ctx);
      } catch (error) {
        return { isError: true, text: formatToolError(error) };
      }
    },
  }));
}

/** JSON tool result (kept as pure JSON so clients/tests can parse it). */
export function jsonOutcome(value: unknown): ToolOutcome {
  return { text: JSON.stringify(value, null, 2) };
}

/** True when a parsed JSON value is a plain object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep path getter used by docs/config helpers (`theme.colors.primary`). */
export function getPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}
