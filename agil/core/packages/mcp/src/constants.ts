/**
 * Static, hand-curated data used by the offline MCP tools:
 *  - roadmap/beta feature flags (for config validation warnings);
 *  - low-bandwidth presets per network scenario;
 *  - a sensible default set of deterministic compliance rules.
 */
import type { CompliancePolicyRule, FeatureKey } from '@agil/protocol';

/** Feature flags that are accepted by the API but not implemented yet (contract §16). */
export const ROADMAP_FEATURES: readonly FeatureKey[] = [
  'breakoutRooms',
  'polls',
  'whiteboard',
  'annotations',
  'liveStreaming',
  'sipDialIn',
  'calendarIntegration',
  'translation',
  'aiAssistant',
  'autoFraming',
  'lowLightEnhancement',
  'speakerSpotlight',
  'remoteControl',
  'webinarMode',
];

/** Implemented but still stabilising: enabling them is fine, just worth a note. */
export const BETA_FEATURES: readonly FeatureKey[] = ['aiCompliance', 'meetingNotes'];

export const LOW_BANDWIDTH_SCENARIOS = ['mobile-3g', 'satellite', 'office-wifi', 'audio-only'] as const;
export type LowBandwidthScenario = (typeof LOW_BANDWIDTH_SCENARIOS)[number];

export interface LowBandwidthProfile {
  scenario: LowBandwidthScenario;
  strategy: 'reduce-video' | 'audio-only' | 'chat-first';
  enterThreshold: { rttMs: number; lossPct: number; jitterMs: number; minBitrateKbps: number };
  restoreThreshold: { rttMs: number; lossPct: number; minBitrateKbps: number };
  autoReconnect: { enabled: boolean; attempts: number; backoffMs: number; maxBackoffMs: number };
  iceRestartOnFailure: boolean;
  notes: string[];
}

/**
 * Enter degradation early; the restore thresholds are stricter to avoid flapping.
 */
export const LOW_BANDWIDTH_PROFILES: Record<LowBandwidthScenario, LowBandwidthProfile> = {
  'mobile-3g': {
    scenario: 'mobile-3g',
    strategy: 'reduce-video',
    enterThreshold: { rttMs: 350, lossPct: 8, jitterMs: 120, minBitrateKbps: 120 },
    restoreThreshold: { rttMs: 180, lossPct: 2, minBitrateKbps: 400 },
    autoReconnect: { enabled: true, attempts: 8, backoffMs: 700, maxBackoffMs: 12000 },
    iceRestartOnFailure: true,
    notes: [
      'Targets ~300-600ms RTT and bursty 3G loss: video switches to a reduced tier early, chat stays on signaling.',
      'Pair with `video.maxResolution: "360p"`, `video.maxFps: 15` and `audio.opusBitrateKbps: 24` for the best result.',
    ],
  },
  satellite: {
    scenario: 'satellite',
    strategy: 'audio-only',
    enterThreshold: { rttMs: 900, lossPct: 12, jitterMs: 220, minBitrateKbps: 60 },
    restoreThreshold: { rttMs: 500, lossPct: 3, minBitrateKbps: 200 },
    autoReconnect: { enabled: true, attempts: 10, backoffMs: 1000, maxBackoffMs: 20000 },
    iceRestartOnFailure: true,
    notes: [
      'Satellite links have 600-1200ms RTT: media degrades to audio-only almost immediately.',
      'Consider `stereo: false`, a larger `jitterBufferTargetMs` (150-300) and `audio.ptimeMs: 40`.',
    ],
  },
  'office-wifi': {
    scenario: 'office-wifi',
    strategy: 'reduce-video',
    enterThreshold: { rttMs: 250, lossPct: 3, jitterMs: 45, minBitrateKbps: 300 },
    restoreThreshold: { rttMs: 120, lossPct: 1, minBitrateKbps: 900 },
    autoReconnect: { enabled: true, attempts: 5, backoffMs: 400, maxBackoffMs: 6000 },
    iceRestartOnFailure: true,
    notes: [
      'Stable LAN/Wi-Fi preset: only degrades on real problems, recovers quickly.',
      'Keep `video.simulcast: true` so weak receivers get a lower layer instead of full quality.',
    ],
  },
  'audio-only': {
    scenario: 'audio-only',
    strategy: 'audio-only',
    enterThreshold: { rttMs: 400, lossPct: 6, jitterMs: 100, minBitrateKbps: 100 },
    restoreThreshold: { rttMs: 250, lossPct: 2, minBitrateKbps: 300 },
    autoReconnect: { enabled: true, attempts: 8, backoffMs: 600, maxBackoffMs: 10000 },
    iceRestartOnFailure: true,
    notes: [
      'Call-center / voice-first profile: video is disabled early, audio gets all the bandwidth.',
      'Set `features.backgroundBlur: false` and `video.maxBitrateKbps: 300` to save CPU and bandwidth.',
    ],
  },
};

/** Deterministic local rules used when `agil_analyze_compliance` gets no explicit rules. */
export const DEFAULT_COMPLIANCE_RULES: CompliancePolicyRule[] = [
  {
    id: 'pii.contacts',
    name: 'Personal data (phone / email / card / passport)',
    type: 'pii',
    pattern: '',
    severity: 'warn',
    action: 'flag',
    enabled: true,
  },
  {
    id: 'phrase.password.ru',
    name: 'Password disclosure (RU)',
    type: 'phrase',
    pattern: 'пароль',
    severity: 'critical',
    action: 'flag',
    enabled: true,
  },
  {
    id: 'phrase.password.en',
    name: 'Password disclosure (EN)',
    type: 'phrase',
    pattern: 'password',
    severity: 'critical',
    action: 'flag',
    enabled: true,
  },
  {
    id: 'phrase.confidential.ru',
    name: 'Confidentiality marker (RU)',
    type: 'phrase',
    pattern: 'конфиденциально',
    severity: 'warn',
    action: 'flag',
    enabled: true,
  },
  {
    id: 'phrase.confidential.en',
    name: 'Confidentiality marker (EN)',
    type: 'phrase',
    pattern: 'confidential',
    severity: 'warn',
    action: 'flag',
    enabled: true,
  },
  {
    id: 'phrase.legal.escalation',
    name: 'Legal escalation',
    type: 'phrase',
    pattern: 'юрист',
    severity: 'info',
    action: 'warn',
    enabled: true,
  },
];
