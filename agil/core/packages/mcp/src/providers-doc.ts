/**
 * Documentation for replaceable capability providers (contract §23,
 * `agil/core/docs/extensibility.md`): builtin by default, swappable per tenant.
 */
export const PROVIDER_SLOTS = [
  'chat',
  'files',
  'stt',
  'notifications',
  'recording',
  'backgrounds',
] as const;

export type ProviderSlotName = (typeof PROVIDER_SLOTS)[number];

export interface ProviderSlotDoc {
  slot: ProviderSlotName;
  title: string;
  builtin: string;
  externalExamples: string;
  notes: string[];
}

export const PROVIDER_SLOT_DOCS: Record<ProviderSlotName, ProviderSlotDoc> = {
  chat: {
    slot: 'chat',
    title: 'Chat',
    builtin: 'Room chat over WebSocket with history and attachments (our UI + signaling).',
    externalExamples: 'Corporate messenger (Mattermost, Teams, in-house chat).',
    notes: [
      '`providers.chat` is message routing/storage; `session.chat.ui` is what the widget renders (builtin | external | hidden).',
      'External transport + builtin UI: our panel stays, messages are stored/forwarded by the company.',
      'External UI: set `session.chat.ui="external"` (use agil_set_chat_mode); the host receives chat events and sends replies via sendChat()/postMessage/POST /v1/admin/rooms/:id/chat.',
    ],
  },
  files: {
    slot: 'files',
    title: 'Files',
    builtin: 'Local storage `.data/files` with signed HMAC URLs.',
    externalExamples: 'S3/MinIO, ECM/DMS, corporate cloud.',
    notes: [
      'External provider must implement put/get/list and return a signed URL.',
      '`fallback:"builtin"` keeps uploads working if the company storage is down.',
    ],
  },
  stt: {
    slot: 'stt',
    title: 'Speech-to-text',
    builtin: 'Browser Web Speech, or the server Whisper-compatible STT configured by AGIL_STT_*.',
    externalExamples: 'Deepgram, Yandex SpeechKit, a self-hosted model.',
    notes: [
      'POST /v1/stt/transcribe is proxied to the external vendor; the widget does not change.',
      '`fallback:"builtin"` degrades to Web Speech when the vendor fails.',
    ],
  },
  notifications: {
    slot: 'notifications',
    title: 'Notifications',
    builtin: 'Built-in UI toasts/events only (nothing leaves the server).',
    externalExamples: 'Email, Telegram, Teams webhook, corporate bot.',
    notes: [
      'External notifications receive join/leave/recording/analysis events through the signed provider envelope.',
      'Builtin = no outbound notifications at all.',
    ],
  },
  recording: {
    slot: 'recording',
    title: 'Recording',
    builtin: 'Client MediaRecorder + local storage (recordings are attached to the transcript).',
    externalExamples: 'S3/object storage, media-server egress.',
    notes: [
      'MVP routes recording storage through the files provider; a dedicated media egress is roadmap.',
      '`fallback:"builtin"` keeps local recordings if the external storage is unreachable.',
    ],
  },
  backgrounds: {
    slot: 'backgrounds',
    title: 'Virtual backgrounds',
    builtin: 'List from `session.virtualBackgrounds` (gradients/URLs).',
    externalExamples: 'Company asset library, CDN.',
    notes: [
      'With mode=external the widget fetches `GET /v1/tenants/:tenantId/backgrounds` (provider `list` action).',
      'Disabled hides the backgrounds UI.',
    ],
  },
};

const SLOT_CONTRACT = `\`\`\`jsonc
// TenantConfig.providers.<slot> — builtin by default
{
  "mode": "builtin" | "external" | "disabled",
  "providerName": "corp-messenger",      // shown in UI/audit
  "endpoint": "https://example.com/agil/chat",
  "apiKeyEnv": "AGIL_CHAT_PROVIDER_KEY", // env-var NAME, never the secret
  "timeoutMs": 5000,
  "fallback": "builtin" | "fail",        // external failure → builtin or 502
  "options": { }                         // provider-specific parameters
}
\`\`\`

External endpoints receive a signed JSON envelope
\`{capability, action, requestId, tenantId, roomId?, payload}\` with headers
\`x-agil-signature\` (hex HMAC-SHA256 of the body), \`x-agil-capability\`,
\`x-agil-request-id\`, \`x-agil-tenant\`; the answer must be \`{ok, data}\`.`;

/** Markdown explanation for `agil_explain_providers`, optionally for one slot. */
export function explainProvidersMarkdown(slot?: ProviderSlotName): string {
  const lines: string[] = [];
  lines.push('# Replaceable capability providers (contract §23)');
  lines.push('');
  lines.push(
    'Everything works **builtin** out of the box — no external dependency is required. ' +
      'A company can point a capability at its own system via `TenantConfig.providers` (6 slots) ' +
      'without forking. Full guide: `agil/core/docs/extensibility.md`, `GET /openapi.json`, `GET /docs`.',
  );
  lines.push('');

  if (slot) {
    const doc = PROVIDER_SLOT_DOCS[slot];
    lines.push(`## ${doc.title} (\`providers.${doc.slot}\`)`);
    lines.push('');
    lines.push(`- **Builtin (default):** ${doc.builtin}`);
    lines.push(`- **External examples:** ${doc.externalExamples}`);
    for (const note of doc.notes) lines.push(`- ${note}`);
    lines.push('');
    lines.push(SLOT_CONTRACT);
    lines.push('');
    lines.push('## How to switch');
    lines.push('');
    lines.push(
      `Call \`agil_set_providers({ providers: { ${slot}: { mode: "external", providerName: "corp", endpoint: "https://example.com/agil/${slot}", apiKeyEnv: "AGIL_${slot.toUpperCase()}_PROVIDER_KEY", fallback: "builtin" } } })\` ` +
        '(add `dryRun: true` first to review the diff and warnings). `agil_test_provider({ slot: "' +
        slot +
        '" })` performs a signed test call. Revert with `mode: "builtin"`.',
    );
    return lines.join('\n');
  }

  lines.push('## The six slots');
  lines.push('');
  lines.push('| Slot | Builtin (default) | Replace with (external) |');
  lines.push('|---|---|---|');
  for (const name of PROVIDER_SLOTS) {
    const doc = PROVIDER_SLOT_DOCS[name];
    lines.push(`| \`${doc.slot}\` | ${doc.builtin} | ${doc.externalExamples} |`);
  }
  lines.push('');
  lines.push('## Slot contract');
  lines.push('');
  lines.push(SLOT_CONTRACT);
  lines.push('');
  lines.push('## Semantics');
  lines.push('');
  lines.push(
    '- `mode:"builtin"` — default, self-contained; nothing leaves the server (except optional AI/knowledge/integrity).',
  );
  lines.push('- `mode:"external"` — traffic goes to the company endpoint; only HTTPS in production; secrets only via `apiKeyEnv`.');
  lines.push(
    '- `mode:"disabled"` — capability is switched off for the tenant (the UI hides it).',
  );
  lines.push(
    '- `fallback:"builtin"` — if the external provider fails/times out, the transparent builtin path is used; `"fail"` — the request fails with 502 (use only when the company must own the data path).',
  );
  lines.push(
    '- Chat is special: `providers.chat` routes messages/storage, `session.chat.ui` decides what the widget renders (builtin | external | hidden).',
  );
  lines.push('');
  lines.push('## Tools');
  lines.push('');
  lines.push('- `agil_get_providers` — status of every slot (mode, providerName, configured, available, fallback).');
  lines.push('- `agil_set_providers` — merge a partial providers config; `dryRun:true` shows the diff and warnings.');
  lines.push('- `agil_test_provider` — signed test call for one slot (`{ok, latencyMs, detail}`).');
  lines.push('- `agil_explain_providers` — this explanation (offline).');
  lines.push('');
  lines.push('## Examples');
  lines.push('');
  lines.push(
    '**Replace chat with the corporate messenger:**\n' +
      '```\nagil_set_providers({ providers: { chat: { mode: "external", providerName: "corp-messenger", endpoint: "https://example.com/agil/chat", apiKeyEnv: "AGIL_CHAT_PROVIDER_KEY", fallback: "builtin" } } })\n' +
      'agil_set_chat_mode({ sessionChat: { ui: "external", externalProviderName: "corp-messenger", allowHostInjection: true } })\n```',
  );
  lines.push('');
  lines.push(
    '**Move STT to a vendor with builtin fallback:**\n' +
      '```\nagil_set_providers({ providers: { stt: { mode: "external", providerName: "deepgram", endpoint: "https://example.com/agil/stt", apiKeyEnv: "AGIL_STT_PROVIDER_KEY", fallback: "builtin" } } })\n```',
  );
  return lines.join('\n');
}
