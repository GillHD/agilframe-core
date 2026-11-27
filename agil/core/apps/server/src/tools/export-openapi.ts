#!/usr/bin/env node
/**
 * Exports the OpenAPI 3.1 documents to docs/:
 *   - docs/openapi.json       — public endpoints only (safe to publish);
 *   - docs/openapi.admin.json — full spec including /v1/admin/*.
 *
 *   npm run openapi -w @agil/calls-server
 *
 * The same builders serve `/openapi.json` and `/openapi.admin.json`, so the
 * committed artifacts never diverge from the runtime API.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenApiSpec } from '../openapi.js';

const root = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const outDir = path.join(root, 'agil', 'core', 'docs');
mkdirSync(outDir, { recursive: true });

const publicOrigin = process.env.AGIL_PUBLIC_ORIGIN ?? 'http://localhost:8787';
const publicSpec = createOpenApiSpec({ publicOrigin, scope: 'public' });
const adminSpec = createOpenApiSpec({ publicOrigin, scope: 'full' });

const publicFile = path.join(outDir, 'openapi.json');
const adminFile = path.join(outDir, 'openapi.admin.json');
writeFileSync(publicFile, `${JSON.stringify(publicSpec, null, 2)}\n`, 'utf8');
writeFileSync(adminFile, `${JSON.stringify(adminSpec, null, 2)}\n`, 'utf8');

const count = (spec: ReturnType<typeof createOpenApiSpec>): { paths: number; schemas: number } => ({
  paths: Object.keys(spec.paths as Record<string, unknown>).length,
  schemas: Object.keys((spec.components as { schemas: Record<string, unknown> }).schemas).length,
});
const publicCounts = count(publicSpec);
const adminCounts = count(adminSpec);
process.stdout.write(
  `OpenAPI 3.1 written:\n` +
    `  ${publicFile}\n    paths: ${publicCounts.paths}, schemas: ${publicCounts.schemas} (public only)\n` +
    `  ${adminFile}\n    paths: ${adminCounts.paths}, schemas: ${adminCounts.schemas} (full, admin)\n` +
    `  version: ${(publicSpec.info as { version: string }).version}\n`,
);
