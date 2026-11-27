/**
 * Unit tests for the pure offline logic behind the MCP tools.
 *
 * These import the source modules directly (via tsx) — no server, no stdio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, tenantConfigPatchSchema, themePresets } from '@agil/protocol';
import {
  analyzeCompliance,
  applyThemeToConfig,
  auditAccessibility,
  explainAccess,
  generateTheme,
  suggestLowBandwidthProfile,
  summarizeMeeting,
  validateConfig,
} from '../src/tools/offline.js';
import { buildEmbedSnippet, escapeHtml, safeJsonForScript } from '../src/embed.js';
import { diffConfigs } from '../src/diff.js';
import { configJsonSchema, configMarkdown } from '../src/config-doc.js';
import { endpointsFromOpenApi } from '../src/tools/online.js';
import { LOW_BANDWIDTH_PROFILES } from '../src/constants.js';
import { API_ENDPOINTS } from '../src/api-catalog.js';
import { inCallAgentPartialSchema, sessionChatPartialSchema, providersPatchSchema } from '../src/schemas.js';
import { explainProvidersMarkdown, PROVIDER_SLOTS } from '../src/providers-doc.js';
import { scaleWarnings, explainScalingMarkdown } from '../src/scaling-doc.js';
import { explainRolesMarkdown, roleWarnings, RESERVED_ROLE_IDS } from '../src/roles-doc.js';
import { ASSISTANT_ROLE_PROMPT_NAMES, PROMPTS } from '../src/prompts.js';
import { ASSISTANT_PROMPTS } from '@agil/ai';
import { buildCreatePollBody, buildVotePollBody, POLL_PERMISSION_NOTE } from '../src/tools/polls.js';
import { scalePatchSchema, roleCreateSchema } from '../src/schemas.js';
import {
  assistantToolInfos,
  explainFeatureMarkdown,
  explainSpotlightMarkdown,
  SPOTLIGHT_TARGETS,
} from '../src/assistant-doc.js';
import { parseProvidersConfig } from '../src/schemas.js';
import { readEnv } from '../src/env.js';
import { AgilHttpClient } from '../src/http-client.js';

test('an unrecognized MCP mode keeps write tools disabled', () => {
  const settings = readEnv({ AGIL_MCP_MODE: 'typo' });
  assert.equal(settings.env.mode, 'read');
  assert.ok(settings.warnings.length > 0);
  assert.equal(readEnv({ AGIL_MCP_MODE: 'full' }).env.mode, 'full');
});

test('MCP requests refuse redirects', async (context) => {
  const request = context.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  await new AgilHttpClient(readEnv({}).env).request('/v1/health');
  assert.equal(request.mock.callCount(), 1);
});

test('in-call agent model patches preserve the history compression setting when omitted', () => {
  assert.deepEqual(inCallAgentPartialSchema.parse({ model: 'company-model' }), { model: 'company-model' });
  assert.deepEqual(inCallAgentPartialSchema.parse({ compressContext: true }), { compressContext: true });
});

const SEGMENTS = [
  {
    id: 's1',
    participantId: 'p1',
    participantName: 'Анна',
    text: 'Обсудим план запуска продукта на следующей неделе.',
    start: 0,
    end: 4,
    isFinal: true,
    ts: 1,
  },
  {
    id: 's2',
    participantId: 'p2',
    participantName: 'Иван',
    text: 'Решили запустить релиз в четверг, я подготовлю отчёт к среде.',
    start: 4,
    end: 9,
    isFinal: true,
    ts: 2,
  },
  {
    id: 's3',
    participantId: 'p1',
    participantName: 'Анна',
    text: 'Есть риск, что не успеем с тестированием и пароль от тестового стенда.',
    start: 9,
    end: 13,
    isFinal: true,
    ts: 3,
  },
] as const;

test('generateTheme: derives a coherent, accessible theme from a brand color', () => {
  const result = generateTheme({ brandColor: '#0b5fff' });
  assert.equal(result.primary, '#0b5fff');
  assert.equal(result.tokenCount, 36);
  assert.equal(result.cssVars['--agil-color-primary'], '#0b5fff');
  assert.equal(result.palette.primary, '#0b5fff');
  assert.ok(result.theme.colors.primaryHover);
  assert.ok(Array.isArray(result.contrastIssues));
  assert.equal(typeof result.accessible, 'boolean');
});

test('generateTheme: respects preset and scheme', () => {
  const corporate = generateTheme({ brandColor: '#0b5fff', preset: 'corporate' });
  assert.equal(corporate.preset, 'corporate');
  assert.equal(corporate.theme.spacing.density, 'compact');

  const dark = generateTheme({ brandColor: '#7c3aed', scheme: 'dark' });
  assert.equal(dark.theme.scheme, 'dark');
  assert.equal(dark.primary, '#7c3aed');
});

test('generateTheme: rejects a non-hex brand color', () => {
  assert.throws(() => generateTheme({ brandColor: 'blue' }), /Invalid brand color/);
});

test('validateConfig: full default config is valid', () => {
  const result = validateConfig(defaultConfig({ tenantId: 'demo' }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.ok(Array.isArray(result.warnings));
});

test('validateConfig: invalid theme color produces zod errors with paths', () => {
  const result = validateConfig({ theme: { colors: { primary: 'not-a-color' } } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('theme.colors.primary')), result.errors.join('\n'));
});

test('validateConfig: patch is resolved over defaults and warns about semantic issues', () => {
  const result = validateConfig({
    video: { codecs: ['vp8'], preferredCodec: 'av1' },
    features: { recording: true },
  });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => warning.includes('video.preferredCodec')), result.warnings.join('\n'));
});

test('validateConfig: unknown top-level keys are reported', () => {
  const result = validateConfig({ ...defaultConfig({ tenantId: 'demo' }), unexpectedSection: { a: 1 } });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => warning.includes('unexpectedSection')));
});

test('validateConfig: enabled legacy session binding is reported for either option', () => {
  for (const bindToIp of [true, false]) {
    const result = validateConfig({ security: { sessionBinding: { enabled: true, bindToIp, bindToDevice: !bindToIp } } });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((warning) => warning.includes('sessionBinding is a legacy configuration block')));
  }
});

test('applyThemeToConfig: returns a new validated config with a diff', () => {
  const before = defaultConfig({ tenantId: 'demo' });
  const result = applyThemeToConfig({ config: before, brandColor: '#0b5fff' });
  assert.equal(result.config.tenantId, 'demo');
  assert.equal(result.theme.colors.primary, '#0b5fff');
  assert.ok(result.changes.some((change) => change.path === 'theme.colors.primary'));
  assert.ok(result.changeSummary.length > 0);
  assert.ok(result.cssVars['--agil-color-primary']);
});

test('applyThemeToConfig: theme patch is deep-merged', () => {
  const result = applyThemeToConfig({
    config: defaultConfig({ tenantId: 'demo' }),
    themePatch: { shape: { radiusMd: 3 }, colors: { primary: '#111111' } },
  });
  assert.equal(result.theme.shape.radiusMd, 3);
  assert.equal(result.theme.colors.primary, '#111111');
  // untouched tokens keep their preset values
  assert.equal(result.theme.colors.background, defaultConfig().theme.colors.background);
});

test('auditAccessibility: passes for the default light preset and fails for unreadable tokens', () => {
  const good = auditAccessibility({ theme: themePresets.light });
  assert.equal(good.passed, true, JSON.stringify(good.issues));

  const bad = auditAccessibility({ theme: { colors: { background: '#ffffff', text: '#ffffff' } } });
  assert.equal(bad.passed, false);
  assert.ok(bad.issues.some((issue) => issue.code === 'text-on-background'));
  assert.ok(bad.issues.every((issue) => issue.suggestedForeground));
});

test('suggestLowBandwidthProfile: every scenario returns a schema-valid patch', () => {
  for (const scenario of Object.keys(LOW_BANDWIDTH_PROFILES) as Array<keyof typeof LOW_BANDWIDTH_PROFILES>) {
    const result = suggestLowBandwidthProfile({ scenario });
    assert.equal(result.validated, true);
    const parsed = tenantConfigPatchSchema.safeParse(result.patch);
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    assert.equal(result.patch.fallback.lowBandwidth.enabled, true);
    assert.ok(result.notes.length > 0);
  }
  assert.equal(suggestLowBandwidthProfile({ scenario: 'satellite' }).patch.fallback.lowBandwidth.strategy, 'audio-only');
  assert.equal(suggestLowBandwidthProfile({ scenario: 'office-wifi' }).patch.fallback.lowBandwidth.strategy, 'reduce-video');
});

test('summarizeMeeting: produces a summary, excerpts and markdown', () => {
  const result = summarizeMeeting({ segments: [...SEGMENTS], locale: 'ru', maxExcerpts: 5 });
  assert.ok(result.notes.summary.length > 0);
  assert.ok(result.notes.excerpts.length > 0);
  assert.equal(result.notes.segmentsAnalyzed, SEGMENTS.length);
  assert.ok(result.markdown.includes('Excerpts'));
  assert.ok(result.markdown.includes('Анна'));
});

test('analyzeCompliance: detects a phrase rule and exports findings', () => {
  const result = analyzeCompliance({
    segments: [...SEGMENTS],
    rules: [
      {
        id: 'phrase.password',
        name: 'Password disclosure',
        type: 'phrase',
        pattern: 'пароль',
        severity: 'critical',
        action: 'flag',
        enabled: true,
      },
    ],
  });
  assert.equal(result.summary.total, 1);
  assert.equal(result.findings[0]?.ruleId, 'phrase.password');
  assert.ok(result.findings[0]?.excerpt.includes('пароль'));
  assert.equal(result.summary.bySeverity.critical, 1);
  assert.ok(result.recommendations.some((recommendation) => recommendation.includes('Critical')));
});

test('analyzeCompliance: default rules still find PII-free text but flag passwords', () => {
  const result = analyzeCompliance({ segments: [...SEGMENTS] });
  assert.ok(result.rulesApplied > 0);
  assert.ok(result.summary.total >= 1);
});

test('explainAccess: guest loses recording, host keeps it when enabled', () => {
  const config = defaultConfig({
    tenantId: 'demo',
    overrides: { features: { recording: true, knowledgeAgent: true } },
  });
  const guest = explainAccess({ role: 'guest', config });
  assert.ok(!guest.allowed.includes('recording'));
  assert.ok(guest.denied.includes('recording'));
  assert.ok(guest.counts.allowed > 0);
  assert.equal(typeof guest.description, 'string');

  const host = explainAccess({ role: 'host', config });
  assert.ok(host.allowed.includes('recording'));
  assert.ok(host.byRole.guest.denied.includes('recording'));
});

test('explainAccess: token permissions and strict mode are honored', () => {
  const config = defaultConfig({
    tenantId: 'demo',
    overrides: {
      features: { chat: true, recording: true },
      security: { accessPolicy: { mode: 'strict', roleDefaults: { host: [], moderator: [], guest: [] } } },
    },
  });
  const pinned = explainAccess({ role: 'guest', config, tokenPermissions: ['chat'] });
  assert.equal(pinned.source, 'token');
  assert.deepEqual(pinned.allowed, ['chat']);

  const strict = explainAccess({ role: 'host', config });
  assert.equal(strict.source, 'strict');
  assert.deepEqual(strict.allowed, []);
});

test('explainAccess: user overrides replace role defaults', () => {
  const config = defaultConfig({
    tenantId: 'demo',
    overrides: {
      security: {
        accessPolicy: {
          mode: 'role-defaults',
          roleDefaults: { host: ['chat', 'recording'], moderator: ['chat'], guest: ['chat'] },
          deniedFeatures: [],
          userOverrides: { 'user-42': ['chat', 'screenShare'] },
        },
      },
    },
  });
  const overridden = explainAccess({ role: 'guest', userId: 'user-42', config });
  assert.equal(overridden.source, 'user-override');
  assert.deepEqual(overridden.allowed, ['chat', 'screenShare']);
});

test('buildEmbedSnippet: SDK snippet mounts the widget and escapes untrusted values', () => {
  const malicious = '</script><script>alert(1)</script>';
  const result = buildEmbedSnippet({ room: 'team-sync', token: malicious, mode: 'sdk' }, 'http://localhost:8787');
  assert.ok(result.sdkHtml.includes('AgilFrame.mount'));
  assert.ok(result.sdkHtml.includes('/sdk/agilframe.js'));
  assert.ok(!result.sdkHtml.includes('</script><script>alert(1)'), result.sdkHtml);
  assert.ok(result.sdkHtml.includes('\\u003c/script'));
  assert.ok(result.iframeUrl.includes('/embed.html?'));
  assert.ok(result.iframeHtml.includes('allow="camera; microphone;'));
  assert.ok(result.notes.length > 0);
});

test('buildEmbedSnippet: rejects a non-http(s) server URL', () => {
  assert.throws(
    () => buildEmbedSnippet({ room: 'r' }, 'javascript:alert(1)'),
    /Invalid serverUrl/,
  );
});

test('buildEmbedSnippet: iframe mode is selected when requested', () => {
  const result = buildEmbedSnippet({ room: 'r', theme: { scheme: 'dark' }, mode: 'iframe' }, 'https://calls.example.com');
  assert.equal(result.mode, 'iframe');
  assert.equal(result.snippet, result.iframeHtml);
  assert.ok(result.iframeUrl.includes('theme=dark'));
  assert.ok(result.iframeUrl.startsWith('https://calls.example.com/embed.html?'));
});

test('buildEmbedSnippet: §22 layout overrides go into config.layout', () => {
  const result = buildEmbedSnippet(
    {
      room: 'r',
      layout: {
        chrome: 'none',
        minimized: { enabled: true, mode: 'bubble', position: 'bottom-right' },
        persistAcrossPages: true,
        inheritHostStyles: true,
      },
    },
    'http://localhost:8787',
  );
  assert.ok(result.sdkHtml.includes('config'));
  assert.ok(result.sdkHtml.includes('chrome'));
  assert.ok(result.sdkHtml.includes('"none"'));
  assert.ok(result.sdkHtml.includes('bubble'));
  assert.ok(result.sdkHtml.includes('persistAcrossPages'));
  assert.ok(result.sdkHtml.includes('AgilFrame.resume()'));
  assert.deepEqual(result.layout?.minimized?.mode, 'bubble');
  assert.ok(result.notes.some((note) => note.includes('chrome="none"')));
  assert.ok(result.notes.some((note) => note.includes('resume')));
});

test('escape helpers are safe', () => {
  assert.equal(escapeHtml('<b>"x"&</b>'), '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;');
  assert.ok(safeJsonForScript({ t: '</script>' }).includes('\\u003c'));
});

test('diffConfigs: reports only leaf-level changes', () => {
  const before = { a: 1, nested: { b: 2, c: 3 }, list: [1, 2] };
  const after = { a: 1, nested: { b: 5, c: 3 }, list: [1, 2, 3] };
  const changes = diffConfigs(before, after);
  assert.deepEqual(
    changes.map((change) => change.path).sort(),
    ['list', 'nested.b'],
  );
});

test('explainProvidersMarkdown: covers all six slots and the extensibility guide', () => {
  assert.equal(PROVIDER_SLOTS.length, 6);
  const markdown = explainProvidersMarkdown();
  for (const slot of PROVIDER_SLOTS) assert.ok(markdown.includes(slot), `missing ${slot}`);
  assert.ok(markdown.includes('agil/core/docs/extensibility.md'));
  assert.ok(markdown.includes('builtin'));
  assert.ok(markdown.includes('fallback'));
  assert.ok(explainProvidersMarkdown('chat').includes('session.chat.ui'));
  assert.ok(explainProvidersMarkdown('stt').includes('Speech-to-text'));
});

test('providersPatchSchema / parseProvidersConfig validate providers slots', () => {
  const patch = providersPatchSchema.safeParse({
    chat: { mode: 'external', endpoint: 'https://example.com/agil/chat', fallback: 'builtin' },
    stt: { mode: 'builtin' },
  });
  assert.equal(patch.success, true);
  assert.equal(providersPatchSchema.safeParse({ chat: { mode: 'native' } }).success, false);
  assert.equal(providersPatchSchema.safeParse({ chat: { timeoutMs: 100 } }).success, false);

  const defaults = parseProvidersConfig(defaultConfig({ tenantId: 'demo' }).providers);
  assert.equal(defaults.success, true);
  assert.equal(parseProvidersConfig({ chat: { mode: 'builtin' } }).success, false);
});

test('assistant tools: 18 user-scoped tools with permission requirements and spotlight targets', () => {
  const tools = assistantToolInfos();
  assert.equal(tools.length, 18);
  const recording = tools.find((tool) => tool.tool === 'start_recording');
  assert.equal(recording?.requiredFeature, 'recording');
  assert.deepEqual(recording?.requiredRoles, ['host', 'moderator']);
  assert.equal(recording?.spotlightTarget, 'recording');
  assert.equal(tools.find((tool) => tool.tool === 'toggle_mic')?.requiredFeature, null);
  assert.equal(tools.find((tool) => tool.tool === 'open_chat')?.requiredFeature, 'chat');
  assert.equal(tools.find((tool) => tool.tool === 'start_recording')?.localIntent, true);
  assert.equal(tools.find((tool) => tool.tool === 'raise_hand')?.localIntent, false);
  const targets = new Set(SPOTLIGHT_TARGETS);
  assert.equal(targets.size, 14);
  assert.ok(targets.has('mic') && targets.has('invite') && targets.has('newtab'));
});

test('spotlight docs: cover all targets and per-target guides', () => {
  const markdown = explainSpotlightMarkdown();
  for (const target of SPOTLIGHT_TARGETS) assert.ok(markdown.includes(target), `missing ${target}`);
  assert.ok(markdown.includes('agil/core/docs/in-call-agent.md'));
  assert.ok(markdown.includes('aria-live'));
  const screen = explainSpotlightMarkdown('screen');
  assert.ok(screen.includes('screenShare'));
  assert.ok(screen.includes('toggle_screen_share'));
  assert.ok(explainSpotlightMarkdown('recording').includes('host|moderator'));
});

test('feature docs include the spotlight-tour hint', () => {
  const recording = explainFeatureMarkdown('recording');
  assert.ok(recording.includes('Spotlight'));
  assert.ok(recording.includes('`recording`'));
  assert.ok(recording.includes('start_recording'));
  const blur = explainFeatureMarkdown('backgroundBlur');
  assert.ok(blur.includes('`blur`'));
  const generic = explainFeatureMarkdown('webinarMode');
  assert.ok(generic.includes('No dedicated spotlight target'));
  assert.ok(generic.includes('agil_explain_spotlight'));
});

test('scaleWarnings: semantic checks for mesh/sfu/turn/webinar/cluster/streaming', () => {
  const base = structuredClone(defaultConfig({ tenantId: 'demo' }).scale);
  // The default config is a valid single-node mesh setup without extra warnings
  // except the "mesh with 100 participants" hint — check the important classes separately.
  const meshBig = { ...base, mediaMode: 'mesh' as const, maxParticipants: 500 };
  assert.ok(scaleWarnings(meshBig).some((warning) => warning.includes('mesh')));

  const sfuNoUrl = { ...base, mediaMode: 'sfu' as const };
  assert.ok(scaleWarnings(sfuNoUrl).some((warning) => warning.includes('sfu.url')));

  const turnNoCred = {
    ...base,
    turn: [{ id: 't1', urls: ['turn:turn.example.com:3478'], username: 'agil', credentialEnv: '', region: '', weight: 1 }],
  };
  assert.ok(scaleWarnings(turnNoCred).some((warning) => warning.includes('credentialEnv')));

  const webinarMesh = { ...base, webinar: { ...base.webinar, enabled: true } };
  assert.ok(scaleWarnings(webinarMesh).some((warning) => warning.includes('mesh')));

  const multiNode = {
    ...base,
    signaling: {
      ...base.signaling,
      redisUrl: '',
      nodes: [
        { id: 'n1', url: 'https://n1.example.com', region: 'eu', weight: 1 },
        { id: 'n2', url: 'https://n2.example.com', region: 'us', weight: 1 },
      ],
    },
  };
  assert.ok(scaleWarnings(multiNode).some((warning) => warning.includes('redisUrl')));

  const streaming = { ...base, streaming: { ...base.streaming, enabled: true, provider: 'none' as const } };
  assert.ok(scaleWarnings(streaming).some((warning) => warning.includes('provider')));
});

test('explainScalingMarkdown: covers modes, components and the guide', () => {
  const markdown = explainScalingMarkdown();
  assert.ok(markdown.includes('agil/core/docs/scaling.md'));
  for (const mode of ['mesh', 'sfu', 'broadcast']) assert.ok(markdown.includes(mode));
  for (const component of ['Redis', 'TURN', 'SFU', 'webinar', 'CDN']) {
    assert.ok(markdown.toLowerCase().includes(component.toLowerCase()), `missing ${component}`);
  }
  assert.ok(markdown.includes('agil_set_scale'));
});

test('scalePatchSchema accepts deep partials and validates values', () => {
  const ok = scalePatchSchema.safeParse({
    mediaMode: 'sfu',
    sfu: { url: 'https://sfu.example.com' },
    turn: [{ id: 'eu-1', urls: ['turn:turn.example.com:3478'], username: 'agil', credentialEnv: 'AGIL_TURN_CREDENTIAL', region: 'eu', weight: 10 }],
    webinar: { enabled: true, viewerLimit: 5000 },
  });
  assert.equal(ok.success, true);
  assert.equal(scalePatchSchema.safeParse({ mediaMode: 'p2p' }).success, false);
  assert.equal(scalePatchSchema.safeParse({ maxParticipants: 1 }).success, false);
});

test('roleWarnings: reserved ids, duplicates, empty features, guest+recording', () => {
  const base = {
    id: 'streamer',
    name: 'Стример',
    description: '',
    baseRole: 'host' as const,
    features: ['chat' as const],
    canModerate: false,
    color: '#8576ff',
  };
  assert.deepEqual(roleWarnings({ role: base, existingRoles: [] }).errors, []);
  assert.ok(
    roleWarnings({ role: { ...base, id: 'host' }, existingRoles: [] }).errors.some((error) => error.includes('reserved')),
  );
  assert.ok(
    roleWarnings({ role: base, existingRoles: [{ id: 'streamer' }] }).errors.some((error) => error.includes('already exists')),
  );
  assert.ok(
    roleWarnings({ role: { ...base, features: [] }, existingRoles: [] }).warnings.some((warning) => warning.includes('no features')),
  );
  assert.ok(
    roleWarnings({ role: { ...base, baseRole: 'guest', features: ['recording'] }, existingRoles: [] }).warnings.some(
      (warning) => warning.includes('guest'),
    ),
  );
  assert.equal(
    roleWarnings({ role: base, existingRoles: [{ id: 'streamer' }], updating: true }).errors.length,
    0,
  );
  assert.ok(RESERVED_ROLE_IDS.has('host') && RESERVED_ROLE_IDS.has('system'));
});

test('explainRolesMarkdown: precedence, examples and docs link', () => {
  const markdown = explainRolesMarkdown();
  assert.ok(markdown.includes('agil/core/docs/api-guide.md'));
  for (const role of ['host', 'moderator', 'guest', 'customRoles', 'roleId']) {
    assert.ok(markdown.includes(role), `missing ${role}`);
  }
  assert.ok(markdown.includes('streamer'));
  assert.ok(markdown.includes('operator'));
  assert.ok(markdown.includes('viewer'));
  assert.ok(markdown.includes('baseRole'));
});

test('roleCreateSchema: fills defaults and validates the id pattern', () => {
  const parsed = roleCreateSchema.safeParse({ id: 'operator', name: 'Оператор', baseRole: 'moderator' });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.canModerate, false);
    assert.deepEqual(parsed.data.features, []);
  }
  assert.equal(roleCreateSchema.safeParse({ id: 'Bad ID', name: 'x', baseRole: 'host' }).success, false);
  assert.equal(roleCreateSchema.safeParse({ id: 'ok', name: '', baseRole: 'host' }).success, false);
});

test('assistant prompts: 10 MCP prompts including seven delegating dashboard roles', () => {
  assert.equal(PROMPTS.length, 10);
  assert.equal(ASSISTANT_PROMPTS.length, 7);
  const names = PROMPTS.map((prompt) => prompt.name);
  for (const base of ['agil-brand-setup', 'agil-embed-install', 'agil-compliance-review']) {
    assert.ok(names.includes(base));
  }
  for (const prompt of ASSISTANT_PROMPTS) {
    const name = ASSISTANT_ROLE_PROMPT_NAMES[prompt.role];
    assert.ok(names.includes(name), `missing MCP prompt ${name}`);
    const definition = PROMPTS.find((entry) => entry.name === name);
    assert.ok(definition);
    const rendered = definition.render({ request: 'выключить запись звонков' });
    const text = rendered.messages[0]?.content.text ?? '';
    assert.match(text, /agil_dashboard_assistant/);
    assert.ok(text.includes(`role: "${prompt.role}"`));
    assert.equal('systemPrompt' in prompt, false);
    assert.ok(text.includes('выключить запись звонков'));
    assert.ok(!text.toLowerCase().includes('api key:'));
  }
});

test('config docs: markdown and JSON schema cover every section', () => {
  const markdown = configMarkdown('all');
  for (const section of [
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
  ]) {
    assert.ok(markdown.includes(`## ${section}`), `missing section ${section}`);
  }
  assert.ok(markdown.includes('security.accessPolicy'));
  assert.ok(markdown.includes('session.knowledgeAgent'));
  assert.ok(markdown.includes('session.inCallAgent'));
  assert.ok(markdown.includes('integrations.webhooks'));
  assert.ok(markdown.includes('providers.chat'));
  assert.ok(markdown.includes('scale.mediaMode'));
  assert.ok(markdown.includes('theme.colors.primary'));

  const schema = configJsonSchema();
  const properties = schema.properties ?? {};
  for (const section of ['theme', 'security', 'session', 'integrations', 'providers', 'scale']) {
    assert.ok(properties[section], `JSON schema missing ${section}`);
  }
  assert.ok(configMarkdown('theme').includes('theme.colors'));
});

test('endpointsFromOpenApi: derives method/path/summary from a spec fragment', () => {
  const endpoints = endpointsFromOpenApi({
    openapi: '3.1.0',
    paths: {
      '/v1/admin/access-policy': {
        get: { summary: 'Read access policy', tags: ['admin', 'access'] },
        put: { summary: 'Update access policy', tags: ['admin', 'access'] },
      },
      '/v1/health': { get: { summary: 'Health', tags: ['health'] } },
    },
  });
  assert.equal(endpoints.length, 3);
  const put = endpoints.find((endpoint) => endpoint.method === 'PUT');
  assert.equal(put?.path, '/v1/admin/access-policy');
  assert.equal(put?.summary, 'Update access policy');
  assert.deepEqual(put?.tags, ['admin', 'access']);
});

test('sessionChat schema accepts partial contract §22 values', () => {
  const valid = sessionChatPartialSchema.safeParse({
    ui: 'external',
    externalProviderName: 'Corp Messenger',
    allowSystemMessages: true,
  });
  assert.equal(valid.success, true);
  const invalid = sessionChatPartialSchema.safeParse({ ui: 'native' });
  assert.equal(invalid.success, false);
});

test('embedded API catalog covers the new contract sections', () => {
  const paths = API_ENDPOINTS.map((endpoint) => endpoint.path);
  for (const required of [
    '/v1/admin/access-policy',
    '/v1/admin/knowledge-agent',
    '/v1/admin/knowledge/ask',
    '/v1/admin/webhooks',
    '/v1/admin/webhooks/test',
    '/v1/rooms/:roomId/chat',
    '/v1/admin/rooms/:roomId/chat',
    '/v1/admin/providers',
    '/v1/admin/providers/test',
    '/v1/tenants/:tenantId/backgrounds',
    '/v1/rooms/:roomId/assistant',
    '/v1/admin/in-call-agent',
    '/v1/admin/scale',
    '/v1/admin/cluster/status',
    '/v1/admin/roles',
    '/v1/admin/roles/:roleId',
    '/openapi.json',
    '/docs',
  ]) {
    assert.ok(paths.includes(required), `catalog missing ${required}`);
  }
});


test('polls: create/vote payload builders validate and normalise MCP input', () => {
  const body = buildCreatePollBody({
    question: '  Какой вариант выбрать?  ',
    options: ['  Да  ', 'Нет'],
    multiple: true,
    anonymous: false,
    kind: 'poll',
  });
  assert.equal(body.question, 'Какой вариант выбрать?');
  assert.deepEqual(body.options, [{ text: 'Да' }, { text: 'Нет' }]);
  assert.equal(body.multiple, true);
  assert.equal(body.anonymous, false);
  assert.equal(body.kind, 'poll');

  assert.throws(() => buildCreatePollBody({ question: 'Вопрос?', options: ['Да', 'да'] }), /unique/i);
  assert.throws(() => buildCreatePollBody({ question: 'Вопрос?', options: ['Да', '  '] }), /empty/i);
  assert.throws(() => buildCreatePollBody({ question: 'x', options: ['Да', 'Нет'] }), /Invalid poll payload/i);

  assert.deepEqual(buildVotePollBody([' opt-1 ', 'opt-2']).optionIds, ['opt-1', 'opt-2']);
  assert.throws(() => buildVotePollBody(['opt-1', 'opt-1']), /duplicate/i);
  assert.match(POLL_PERMISSION_NOTE, /hosts\/moderators create and close/i);
});
