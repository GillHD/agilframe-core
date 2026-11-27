/**
 * MCP resources: read-only documents an agent can attach as context.
 *
 * Contract §9 requires `agil://docs/theming`, `agil://docs/api`,
 * `agil://config/schema` and `agil://docs/security`, plus the embedding docs.
 */
import { configJsonSchema } from './config-doc.js';
import { DOCS, type DocTopic } from './docs.js';

export interface ResourceDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  read: () => string;
}

function docResource(topic: DocTopic, name: string, title: string): ResourceDefinition {
  return {
    uri: `agil://docs/${topic}`,
    name,
    title,
    description: `AgilFrame documentation: ${topic}.` ,
    mimeType: 'text/markdown',
    read: () => DOCS[topic],
  };
}

export function createResources(): ResourceDefinition[] {
  return [
    docResource('theming', 'docs-theming', 'Theming and design tokens'),
    docResource('api', 'docs-api', 'HTTP API reference'),
    docResource('security', 'docs-security', 'Security model'),
    docResource('embedding', 'docs-embedding', 'Embedding the call UI'),
    docResource('mcp', 'docs-mcp', 'MCP connection guide'),
    {
      uri: 'agil://config/schema',
      name: 'config-schema',
      title: 'TenantConfig JSON Schema',
      description: 'JSON Schema (draft-07) of the full TenantConfig, including theme, access policy and integrations.',
      mimeType: 'application/json',
      read: () => JSON.stringify(configJsonSchema(), null, 2),
    },
  ];
}

export function findResource(uri: string, resources: readonly ResourceDefinition[]): ResourceDefinition | undefined {
  return resources.find((resource) => resource.uri === uri);
}

export function resourceUris(resources: readonly ResourceDefinition[]): string {
  return resources.map((resource) => resource.uri).join(', ');
}
