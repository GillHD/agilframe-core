#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * AgilFrame MCP server — stdio entry point (default transport).
 *
 * HTTP mode is started by `src/http.ts` (or `AGIL_MCP_HTTP_ENABLED=1 node dist/index.js`).
 * Protocol notes:
 *  - stdout is reserved for JSON-RPC: every diagnostic goes to stderr.
 *  - the API key and the HTTP token are never logged.
 *  - tools are split into offline (pure protocol logic) and online (AGIL HTTP API);
 *    online failures are returned as `isError: true` with a fix hint.
 *  - `AGIL_MCP_MODE=read` exposes only read/design tools.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describeEnv, readEnv } from './env.js';
import { AgilHttpClient } from './http-client.js';
import { createResources } from './resources.js';
import { PROMPTS } from './prompts.js';
import { createMcpServer, log, SERVER_NAME, SERVER_VERSION } from './server.js';

export { SERVER_NAME, SERVER_VERSION, createMcpServer, WRITE_TOOL_NAMES } from './server.js';

/** Starts the stdio transport (or HTTP when AGIL_MCP_HTTP_ENABLED=1). */
export async function main(): Promise<void> {
  const { env, warnings } = readEnv();
  for (const warning of warnings) log(`warning: ${warning}`);
  log(`starting ${SERVER_NAME}@${SERVER_VERSION}: ${describeEnv(env)}`);

  const httpFlag = (process.env.AGIL_MCP_HTTP_ENABLED ?? '').trim().toLowerCase();
  if (httpFlag === '1' || httpFlag === 'true' || httpFlag === 'yes') {
    const { startHttpFromEnv } = await import('./http.js');
    const { running } = await startHttpFromEnv({ env, client: new AgilHttpClient(env) });
    log('AGIL_MCP_HTTP_ENABLED=1: HTTP transport started; stdio transport is disabled in this process');
    const shutdown = (signal: string): void => {
      log(`received ${signal}, shutting down HTTP MCP`);
      void running.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    return;
  }

  const client = new AgilHttpClient(env);
  const { server, tools } = createMcpServer({ client, env });
  const offlineCount = tools.filter((tool) => !tool.online).length;
  log(
    `registered ${tools.length} tools (${offlineCount} offline, mode=${env.mode}), ` +
      `${createResources().length} resources, ${PROMPTS.length} prompts`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('connected via stdio; waiting for JSON-RPC messages');

  const shutdown = (signal: string): void => {
    log(`received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[agil-mcp] fatal: ${message}`);
  process.exit(1);
});
