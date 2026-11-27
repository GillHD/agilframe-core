/**
 * MCP prompts: reusable starting instructions that wire several tools together.
 *
 * Each prompt spells out the tool order and the guard rails (validate before
 * saving, audit contrast, never invent token names).
 *
 * The 7 dashboard-assistant role prompts come from the shared @agil/ai prompt
 * library, so any MCP client behaves like the dashboard mascot.
 */
import { ASSISTANT_PROMPTS } from '@agil/ai';
import type { DashboardAssistantRole } from '@agil/protocol';
export interface PromptArgumentDefinition {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptRenderResult {
  description: string;
  messages: PromptMessage[];
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgumentDefinition[];
  render: (args: Record<string, string | undefined>) => PromptRenderResult;
}

function text(value: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text: value } };
}

function orDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

const BASE_PROMPTS: PromptDefinition[] = [
  {
    name: 'agil-brand-setup',
    title: 'Set up the brand',
    description:
      'Customize AgilFrame for a company: generate a theme from a brand color, apply it to the tenant config, validate and save.',
    arguments: [
      { name: 'companyName', description: 'Company / product name', required: true },
      { name: 'brandColor', description: 'Brand hex color, e.g. #0b5fff', required: false },
      { name: 'preset', description: 'Base preset: light, dark, corporate, night or minimal', required: false },
      { name: 'supportUrl', description: 'Support / help-center URL', required: false },
    ],
    render: (args) => {
      const company = orDefault(args.companyName, 'the company');
      const brandColor = orDefault(args.brandColor, 'a color that matches their website');
      const preset = orDefault(args.preset, 'corporate');
      const supportUrl = args.supportUrl?.trim();
      return {
        description: `Brand AgilFrame for ${company}`,
        messages: [
          text(
            [
              `Brand the AgilFrame embeddable UI for "${company}".`,
              '',
              'Work strictly offline — do not call tools that need a server until step 6, and never invent color token names.',
              '',
              'Steps:',
              '1. Call `agil_list_theme_presets` and pick the closest base preset (requested: ' + preset + ').',
              `2. Call \`agil_generate_theme\` with brandColor "${brandColor}" and the chosen preset.`,
              '3. Review `contrastIssues`; if any are errors, adjust the color (darker/lighter) and regenerate, or fix the affected on-* tokens.',
              '4. Call `agil_apply_theme_to_config` with the current config (or `agil_get_config` if a server is available) and the generated theme.',
              '5. Call `agil_validate_config` and `agil_audit_accessibility`; show me the warnings you could not remove.',
              '6. Only when everything is valid: `agil_update_config` with dryRun=true, show the diff, then apply it.',
              '7. Finish with `agil_get_embed_snippet` for a ready-to-paste snippet.',
              '',
              'Also set branding: productName="' + company + '"' + (supportUrl ? `, supportUrl="${supportUrl}"` : '') + '.',
              'Return: the final theme JSON, a short contrast summary, the config diff and the embed snippet.',
            ].join('\n'),
          ),
        ],
      };
    },
  },
  {
    name: 'agil-embed-install',
    title: 'Install the embed',
    description: 'Generate and explain an integration snippet (SDK or iframe) for a website or SPA.',
    arguments: [
      { name: 'room', description: 'Room id/slug to embed', required: false },
      { name: 'framework', description: 'Host stack: html, react, vue, wordpress…', required: false },
      { name: 'serverUrl', description: 'AGIL server origin', required: false },
    ],
    render: (args) => {
      const room = orDefault(args.room, 'team-sync');
      const framework = orDefault(args.framework, 'plain HTML');
      const serverUrl = orDefault(args.serverUrl, 'the configured AGIL_SERVER_URL');
      return {
        description: `Embed AgilFrame room "${room}" into ${framework}`,
        messages: [
          text(
            [
              `Help me embed AgilFrame room "${room}" into a ${framework} page.`,
              '',
              'Steps:',
              `1. Call \`agil_get_embed_snippet\` with room="${room}" and serverUrl "${serverUrl}". Ask me for a token only if the room is not public — never generate or hard-code the tenant API key.`,
              '2. Present both variants: SDK mode (`AGILCalls.mount`) and iframe mode (`/embed.html?...`), and recommend one for my stack.',
              '3. Explain the postMessage contract (`agil:config`, `agil:theme`, `agil:scheme`, `agil:action`) and the events (`agil:ready`, `agil:event`, `agil:state`).',
              '4. Call `agil_get_docs` with topic="embedding" and summarize the security notes: short-lived join tokens, HTTPS, allowed origins.',
              `5. If my stack is a SPA, show a tiny component that mounts the widget into a ref and destroys it on unmount.`,
              '',
              'Return: the snippet, the recommended mode and the token-handling checklist.',
            ].join('\n'),
          ),
        ],
      };
    },
  },
  {
    name: 'agil-compliance-review',
    title: 'Compliance review',
    description:
      'Analyze a call transcript with local deterministic rules and notes, then summarize findings and recommended actions.',
    arguments: [
      { name: 'transcript', description: 'Transcript text or JSON segments', required: false },
      { name: 'rules', description: 'Policy rules or a description of forbidden topics', required: false },
      { name: 'roomId', description: 'Room id to fetch the transcript from (needs a server)', required: false },
    ],
    render: (args) => {
      const transcript = args.transcript?.trim();
      const rules = args.rules?.trim();
      const roomId = args.roomId?.trim();
      return {
        description: 'Compliance review of a call transcript',
        messages: [
          text(
            [
              'Run a compliance review of a call transcript.',
              '',
              'Steps:',
              roomId
                ? `1. Call \`agil_get_transcript\` for room "${roomId}" (requires a server). If the server is down, ask me to paste the transcript.`
                : '1. Use the transcript I provide. If it is plain text, split it into segments with speaker names and timecodes first (the tool requires {id, participantId, participantName, text, start, end, isFinal, ts}).',
              rules
                ? `2. Pass these policy rules to \`agil_analyze_compliance\` (or translate my description into phrase/regex/pii rules): ${rules}`
                : '2. Call `agil_analyze_compliance` with default rules.',
              '3. Call `agil_summarize_meeting` for notes with verbatim excerpts (summary, action items, decisions, risks).',
              '4. Group findings by severity, quote the exact excerpt and timecode for each, and state the recommended action per finding.',
              '5. Be explicit that local rules are deterministic heuristics, not a legal guarantee.',
              '',
              transcript ? 'Transcript:\n' + transcript : 'Ask me for the transcript if it is not in the conversation.',
            ].join('\n'),
          ),
        ],
      };
    },
  },
];

/** MCP prompt name for each dashboard-assistant role. */
export const ASSISTANT_ROLE_PROMPT_NAMES: Record<DashboardAssistantRole, string> = {
  assistant: 'dashboard-assistant',
  'config-guardian': 'config-guardian',
  'security-reviewer': 'security-reviewer',
  onboarding: 'onboarding',
  'api-helper': 'api-helper',
  'scaling-advisor': 'scaling-advisor',
  'roles-admin': 'roles-admin',
};

/**
 * Public workflow prompts delegate the selected role to Core.
 */
const assistantRolePrompts: PromptDefinition[] = ASSISTANT_PROMPTS.map((prompt) => ({
  name: ASSISTANT_ROLE_PROMPT_NAMES[prompt.role],
  title: prompt.title,
  description: prompt.description,
  arguments: [
    {
      name: 'request',
      description: 'Что нужно сделать или спросить (свободный текст)',
      required: false,
    },
  ],
  render: (args) => {
    const request = args.request?.trim();
    return {
      description: prompt.description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Передай запрос инструменту agil_dashboard_assistant с параметром role: "${prompt.role}".`,
              'Передай сообщение администратора как элемент messages с role: "user". Покажи полученный ответ.',
              request && request.length > 0
                ? `Запрос администратора: ${request}`
                : 'Запрос администратора: помоги настроить панель AgilFrame; сначала уточни, что именно нужно изменить.',
            ].join('\n'),
          },
        },
      ],
    };
  },
}));

export const PROMPTS: PromptDefinition[] = [...BASE_PROMPTS, ...assistantRolePrompts];

export function findPrompt(name: string, prompts: readonly PromptDefinition[] = PROMPTS): PromptDefinition | undefined {
  return prompts.find((prompt) => prompt.name === name);
}

export function promptNames(prompts: readonly PromptDefinition[] = PROMPTS): string {
  return prompts.map((prompt) => prompt.name).join(', ');
}
