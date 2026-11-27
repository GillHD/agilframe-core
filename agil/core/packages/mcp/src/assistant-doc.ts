/**
 * In-call assistant documentation (contract: docs/in-call-agent.md,
 * docs/llm-integrations.md): the 18 user-scoped tools, their permission
 * requirements, and the spotlight targets the agent may highlight.
 */
import { assistantTools, assistantToolRequirements, type AssistantTool } from '@agil/protocol';

export const SPOTLIGHT_TARGETS = [
  'mic',
  'camera',
  'screen',
  'chat',
  'files',
  'participants',
  'notes',
  'settings',
  'blur',
  'recording',
  'minimize',
  'fullscreen',
  'newtab',
  'invite',
] as const;

export type SpotlightTarget = (typeof SPOTLIGHT_TARGETS)[number];

export interface SpotlightTargetDoc {
  target: SpotlightTarget;
  title: string;
  where: string;
  tools: AssistantTool[];
  feature?: string;
  role?: string;
  tourTip: string;
}

export const SPOTLIGHT_TARGET_DOCS: Record<SpotlightTarget, SpotlightTargetDoc> = {
  mic: {
    target: 'mic',
    title: 'Microphone',
    where: 'First control in the bottom control bar (also "M" shortcut).',
    tools: ['toggle_mic'],
    tourTip: 'Ask "where is the microphone?" — the assistant dims the UI and points at the mic button.',
  },
  camera: {
    target: 'camera',
    title: 'Camera',
    where: 'Second control in the bottom control bar (also "V" shortcut).',
    tools: ['toggle_camera'],
    tourTip: 'Ask "how do I turn on the camera?" — spotlight the camera button.',
  },
  screen: {
    target: 'screen',
    title: 'Screen share',
    where: 'Control bar, "Share screen" button; requires the screenShare feature.',
    tools: ['toggle_screen_share'],
    feature: 'screenShare',
    tourTip: 'Ask "как показать экран?" — spotlight the share-screen control.',
  },
  chat: {
    target: 'chat',
    title: 'Chat',
    where: 'Message icon in the control bar / right-side chat panel; requires chat feature.',
    tools: ['open_chat', 'send_chat'],
    feature: 'chat',
    tourTip: 'Ask "где чат?" — spotlight the chat button and open the panel.',
  },
  files: {
    target: 'files',
    title: 'Files',
    where: 'Attachments panel inside chat; requires fileShare feature.',
    tools: ['open_files'],
    feature: 'fileShare',
    tourTip: 'Ask "как отправить файл?" — spotlight the attachment control.',
  },
  participants: {
    target: 'participants',
    title: 'Participants',
    where: 'People icon in the control bar; requires participantList feature.',
    tools: ['open_participants'],
    feature: 'participantList',
    tourTip: 'Ask "кто в звонке?" — spotlight the participants button.',
  },
  notes: {
    target: 'notes',
    title: 'Notes & transcript',
    where: 'Notes panel (meetingNotes feature); shows transcript, excerpts, decisions.',
    tools: ['open_notes'],
    feature: 'meetingNotes',
    tourTip: 'Ask "покажи заметки" — spotlight the notes tab.',
  },
  settings: {
    target: 'settings',
    title: 'Device settings',
    where: 'Gear icon in the control bar; devices, theme, language.',
    tools: ['open_settings'],
    feature: 'deviceSettings',
    tourTip: 'Ask "как поменять камеру?" — spotlight the gear button.',
  },
  blur: {
    target: 'blur',
    title: 'Background blur / replace',
    where: 'Background icon in the control bar; requires backgroundBlur/backgroundReplace.',
    tools: ['set_blur'],
    feature: 'backgroundBlur',
    tourTip: 'Ask "как включить размытие фона?" — a two-step tour: background button, then the blur mode.',
  },
  recording: {
    target: 'recording',
    title: 'Recording',
    where: 'Record button in the control bar; requires recording feature and host/moderator role; consent dialog.',
    tools: ['start_recording', 'stop_recording'],
    feature: 'recording',
    role: 'host|moderator',
    tourTip: 'Ask "включи запись" — the assistant starts it (if allowed) and spotlights the record button.',
  },
  minimize: {
    target: 'minimize',
    title: 'Minimize / restore',
    where: 'Minimize control in the call header; the call keeps running in a mini window.',
    tools: ['minimize', 'restore'],
    tourTip: 'Ask "сверни звонок" — action + spotlight of the minimize control.',
  },
  fullscreen: {
    target: 'fullscreen',
    title: 'Fullscreen',
    where: 'Fullscreen control in the control bar; requires fullscreen feature.',
    tools: ['request_fullscreen'],
    feature: 'fullscreen',
    tourTip: 'Ask "на весь экран" — spotlight the fullscreen button.',
  },
  newtab: {
    target: 'newtab',
    title: 'Open in a new tab',
    where: 'Next to fullscreen; opens the call in a separate browser tab.',
    tools: ['open_new_tab'],
    tourTip: 'Ask "открой в новой вкладке" — spotlight the new-tab control.',
  },
  invite: {
    target: 'invite',
    title: 'Invite link',
    where: 'Room menu "Copy invite link"; the assistant can copy it for you.',
    tools: ['copy_invite_link'],
    tourTip: 'Ask "пригласи Аню" — copies the invite link and spotlights the room menu.',
  },
};

interface AssistantToolDoc {
  description: string;
  spotlightTarget?: SpotlightTarget;
  localIntent: boolean;
}

const TOOL_DOCS: Record<AssistantTool, AssistantToolDoc> = {
  start_recording: { description: 'Start call recording (consent may be required).', spotlightTarget: 'recording', localIntent: true },
  stop_recording: { description: 'Stop the current recording.', spotlightTarget: 'recording', localIntent: true },
  toggle_mic: { description: 'Mute / unmute the microphone.', spotlightTarget: 'mic', localIntent: true },
  toggle_camera: { description: 'Turn the camera on / off.', spotlightTarget: 'camera', localIntent: true },
  toggle_screen_share: { description: 'Start / stop screen sharing.', spotlightTarget: 'screen', localIntent: true },
  raise_hand: { description: 'Raise / lower the hand.', localIntent: false },
  send_chat: { description: 'Send a chat message on behalf of the user.', spotlightTarget: 'chat', localIntent: false },
  open_chat: { description: 'Open the in-call chat panel.', spotlightTarget: 'chat', localIntent: true },
  open_files: { description: 'Open the file-sharing / attachments panel.', spotlightTarget: 'files', localIntent: true },
  open_participants: { description: 'Open the participants list.', spotlightTarget: 'participants', localIntent: true },
  open_notes: { description: 'Open notes / transcript panel.', spotlightTarget: 'notes', localIntent: true },
  open_settings: { description: 'Open device settings.', spotlightTarget: 'settings', localIntent: true },
  set_blur: { description: 'Enable background blur / replacement.', spotlightTarget: 'blur', localIntent: true },
  minimize: { description: 'Minimize the call into a mini window.', spotlightTarget: 'minimize', localIntent: true },
  restore: { description: 'Restore the minimized call.', spotlightTarget: 'minimize', localIntent: false },
  request_fullscreen: { description: 'Switch the call to fullscreen.', spotlightTarget: 'fullscreen', localIntent: true },
  open_new_tab: { description: 'Open the call in a new browser tab.', spotlightTarget: 'newtab', localIntent: true },
  copy_invite_link: { description: 'Copy the room invite link.', spotlightTarget: 'invite', localIntent: true },
};

export interface AssistantToolInfo {
  tool: AssistantTool;
  description: string;
  requiredFeature: string | null;
  requiredRoles: string[] | null;
  spotlightTarget: SpotlightTarget | null;
  localIntent: boolean;
}

export function assistantToolInfos(): AssistantToolInfo[] {
  return assistantTools.map((tool) => {
    const requirements = assistantToolRequirements(tool);
    const doc = TOOL_DOCS[tool];
    return {
      tool,
      description: doc.description,
      requiredFeature: requirements.feature ?? null,
      requiredRoles: requirements.roles && requirements.roles.length > 0 ? [...requirements.roles] : null,
      spotlightTarget: doc.spotlightTarget ?? null,
      localIntent: doc.localIntent,
    };
  });
}

/** Markdown guide for one spotlight target or all of them. */
export function explainSpotlightMarkdown(target?: SpotlightTarget): string {
  const lines: string[] = [];
  if (target) {
    const doc = SPOTLIGHT_TARGET_DOCS[target];
    lines.push(`# Spotlight: \`${doc.target}\` (${doc.title})`);
    lines.push('');
    lines.push(`**Where it is:** ${doc.where}`);
    lines.push(`**Assistant tool(s):** ${doc.tools.map((tool) => `\`${tool}\``).join(', ')}`);
    if (doc.feature) lines.push(`**Required feature:** \`${doc.feature}\``);
    if (doc.role) lines.push(`**Required role:** ${doc.role}`);
    lines.push('');
    lines.push('**How the assistant highlights it:** reply with `spotlight: [{target, text, step}]`; the widget dims the UI, finds the control by the logical name and draws a ring + tooltip. Multi-step tours use increasing `step` values (Далее/Назад/Понятно, Esc closes).');
    lines.push('');
    lines.push(`**Tip:** ${doc.tourTip}`);
    return lines.join('\n');
  }

  lines.push('# Spotlight targets (in-call assistant)');
  lines.push('');
  lines.push(
    'The assistant can answer "where is…" by dimming the call UI and highlighting one logical control. ' +
      'Allowed only when `session.inCallAgent.spotlight=true`. Targets map to widget controls; anything not in this list ' +
      'can be addressed by a CSS selector inside the widget (less stable).',
  );
  lines.push('');
  lines.push('| Target | Control | Tool(s) | Requires |');
  lines.push('|---|---|---|---|');
  for (const targetName of SPOTLIGHT_TARGETS) {
    const doc = SPOTLIGHT_TARGET_DOCS[targetName];
    const requires = [doc.feature ? `feature \`${doc.feature}\`` : '', doc.role ? `role ${doc.role}` : ''].filter(Boolean).join(' + ') || '—';
    lines.push(`| \`${doc.target}\` | ${doc.title} — ${doc.where} | ${doc.tools.map((tool) => `\`${tool}\``).join(', ')} | ${requires} |`);
  }
  lines.push('');
  lines.push('## Tour pattern');
  lines.push('');
  lines.push(
    '`{ text: "Вот кнопка записи", actions: [{tool:"start_recording"}], spotlight: [{target:"recording", text:"Нажмите сюда", step:0}] }` — ' +
      'actions are filtered by the user permissions on the server; spotlight is UX only and never changes state.',
  );
  lines.push('Multi-step (background): `spotlight: [{target:"settings", step:0}, {target:"blur", step:1}]`.');
  lines.push('');
  lines.push(
    'Accessibility: overlay is closed with Esc, focus moves to the tooltip, text is announced via aria-live, and the call is never blocked. ' +
      'Config: `session.inCallAgent.spotlight`, `allowedTools`; docs: `agil/core/docs/in-call-agent.md`.',
  );
  return lines.join('\n');
}

/** Markdown guide for a feature flag, including the spotlight-tour hint. */
export function explainFeatureMarkdown(feature: string): string {
  const normalized = feature.trim();
  const targetByFeature: Record<string, SpotlightTarget> = {
    recording: 'recording',
    chat: 'chat',
    fileShare: 'files',
    participantList: 'participants',
    meetingNotes: 'notes',
    deviceSettings: 'settings',
    backgroundBlur: 'blur',
    backgroundReplace: 'blur',
    screenShare: 'screen',
    fullscreen: 'fullscreen',
    waitingRoom: 'invite',
    inviteLink: 'invite',
    captions: 'settings',
    knowledgeAgent: 'chat',
    aiAssistant: 'chat',
    minimized: 'minimize',
  };
  const target = targetByFeature[normalized];
  const lines: string[] = [];
  lines.push(`# Feature \`${normalized}\` — spotlight hint`);
  lines.push('');
  lines.push(
    `Feature flags are enabled in \`features.${normalized}\` (TenantConfig), intersected with \`security.accessPolicy\` and the token permissions; ` +
      'see `agil_explain_access` for what a specific role/user gets.',
  );
  if (target) {
    const doc = SPOTLIGHT_TARGET_DOCS[target];
    lines.push('');
    lines.push(`**Spotlight:** when the in-call assistant needs to point at this capability it highlights \`${doc.target}\` (${doc.title}).`);
    lines.push(`**Where:** ${doc.where}`);
    lines.push(`**Assistant tools:** ${doc.tools.map((tool) => `\`${tool}\``).join(', ')}.`);
    lines.push(
      'A "how do I…" request produces a spotlight tour (dimmed UI + ring + tooltip, steps for multi-step flows); ' +
        '`session.inCallAgent.spotlight=false` turns highlighting off and leaves text-only answers.',
    );
  } else {
    lines.push('');
    lines.push(
      'No dedicated spotlight target: the assistant answers in text, or uses a CSS selector. ' +
        'Call `agil_explain_spotlight` for the list of logical targets.',
    );
  }
  lines.push('');
  lines.push('Related: `agil_get_assistant_tools`, `agil_explain_spotlight`, `agil/core/docs/in-call-agent.md`.');
  return lines.join('\n');
}
