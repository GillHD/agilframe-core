/**
 * Media integrity (anti-deepfake) scoring.
 *
 * Combines probabilistic browser-side signals (frame-timing regularity, face
 * detection, liveness challenge) with an optional external detector score into a
 * single 0..1 risk value. This is a heuristic risk score, NOT a legal
 * deepfake verdict — see the package README for the honest limitations.
 *
 * Weights: frame timing 0.30, liveness 0.30, face 0.15, external detector 0.35,
 * geo mismatch 0.05. The score is the weighted average over the signals that
 * were actually supplied; missing signals do not count as risk.
 *
 * Status:
 *   - 'unknown'    — feature disabled or no usable signal;
 *   - 'suspicious' — score >= cfg.flagThreshold, or a hard failure flag
 *                    (liveness_failed / external_detector_high);
 *   - 'verified'   — below threshold and at least one positive signal
 *                    (liveness passed, face detected, or a low external score).
 */
import type { TenantConfig } from '@agil/protocol';

/** Configuration shape mirroring `config.security.mediaIntegrity`. */
export type MediaIntegrityConfig = Partial<TenantConfig['security']['mediaIntegrity']>;

export type MediaIntegrityStatus = 'unknown' | 'verified' | 'suspicious';

export type MediaIntegrityFlag =
  | 'frame_timing_regular'
  | 'liveness_failed'
  | 'no_face'
  | 'external_detector_high'
  | 'geo_mismatch';

export const MEDIA_INTEGRITY_FLAGS: readonly MediaIntegrityFlag[] = [
  'frame_timing_regular',
  'liveness_failed',
  'no_face',
  'external_detector_high',
  'geo_mismatch',
];

export interface MediaIntegrityInput {
  /** 0..1: how regular the frame timings are (high = synthetic-looking). */
  frameTimingRegularity?: number;
  /** Result of the random liveness challenge (turn head / blink), when enabled. */
  livenessPassed?: boolean;
  /** Whether a face was detected in the video stream. */
  faceDetected?: boolean;
  /** External detector score, 0..1 (1 = definitely synthetic). */
  externalScore?: number;
  /** Whether an external detector (`AGIL_INTEGRITY_URL`) is configured. */
  externalConfigured?: boolean;
  /** Declared/identity country of the participant. */
  country?: string | null;
  /** Country resolved from the participant's IP address. */
  ipCountry?: string | null;
}

export interface MediaIntegrityResult {
  status: MediaIntegrityStatus;
  /** Risk score 0..1 (higher = more suspicious), rounded to 3 decimals. */
  score: number;
  flags: MediaIntegrityFlag[];
}

const DEFAULT_FLAG_THRESHOLD = 0.7;
/** Frame-timing regularity above which the `frame_timing_regular` flag is set. */
const FRAME_REGULARITY_THRESHOLD = 0.85;

const WEIGHT_FRAME = 0.3;
const WEIGHT_LIVENESS = 0.3;
const WEIGHT_FACE = 0.15;
const WEIGHT_EXTERNAL = 0.35;
const WEIGHT_GEO = 0.05;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeCountry(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

export class MediaIntegrityService {
  /** Normalised configuration (copy; safe to inspect). */
  readonly config: MediaIntegrityConfig;
  readonly enabled: boolean;
  readonly frameHeuristics: boolean;
  readonly livenessChallenge: boolean;
  readonly flagThreshold: number;

  constructor(cfg: MediaIntegrityConfig = {}) {
    const source = cfg && typeof cfg === 'object' ? cfg : {};
    this.config = { ...source };
    this.enabled = source.enabled ?? true;
    this.frameHeuristics = source.frameHeuristics ?? true;
    this.livenessChallenge = source.livenessChallenge ?? false;
    this.flagThreshold = clamp01(toFiniteNumber(source.flagThreshold) ?? DEFAULT_FLAG_THRESHOLD) || DEFAULT_FLAG_THRESHOLD;
  }

  /** Evaluates one participant snapshot. Never throws. */
  evaluate(input: MediaIntegrityInput = {}): MediaIntegrityResult {
    if (!this.enabled) return { status: 'unknown', score: 0, flags: [] };
    const data: MediaIntegrityInput = input && typeof input === 'object' ? input : {};

    const risks: Array<{ risk: number; weight: number }> = [];
    const flags: MediaIntegrityFlag[] = [];
    let positiveEvidence = false;

    const frameRegularity = toFiniteNumber(data.frameTimingRegularity);
    if (this.frameHeuristics && frameRegularity !== undefined) {
      const risk = clamp01(frameRegularity);
      risks.push({ risk, weight: WEIGHT_FRAME });
      if (risk >= FRAME_REGULARITY_THRESHOLD) flags.push('frame_timing_regular');
    }

    if (typeof data.livenessPassed === 'boolean') {
      const risk = data.livenessPassed ? 0 : 1;
      risks.push({ risk, weight: WEIGHT_LIVENESS });
      if (data.livenessPassed) {
        positiveEvidence = true;
      } else {
        flags.push('liveness_failed');
      }
    }

    if (typeof data.faceDetected === 'boolean') {
      const risk = data.faceDetected ? 0 : 1;
      risks.push({ risk, weight: WEIGHT_FACE });
      if (data.faceDetected) {
        positiveEvidence = true;
      } else {
        flags.push('no_face');
      }
    }

    const externalScore = toFiniteNumber(data.externalScore);
    if (data.externalConfigured === true && externalScore !== undefined) {
      const risk = clamp01(externalScore);
      risks.push({ risk, weight: WEIGHT_EXTERNAL });
      if (risk >= this.flagThreshold) {
        flags.push('external_detector_high');
      } else {
        positiveEvidence = true;
      }
    }

    const country = normalizeCountry(data.country);
    const ipCountry = normalizeCountry(data.ipCountry);
    if (country && ipCountry) {
      const mismatch = country !== ipCountry;
      risks.push({ risk: mismatch ? 1 : 0, weight: WEIGHT_GEO });
      if (mismatch) flags.push('geo_mismatch');
    }

    if (risks.length === 0) return { status: 'unknown', score: 0, flags: [] };

    const totalWeight = risks.reduce((sum, item) => sum + item.weight, 0);
    const weightedRisk = risks.reduce((sum, item) => sum + item.risk * item.weight, 0);
    const score = Math.round((totalWeight > 0 ? weightedRisk / totalWeight : 0) * 1000) / 1000;

    const hardFailure = flags.includes('liveness_failed') || flags.includes('external_detector_high');
    let status: MediaIntegrityStatus;
    if (hardFailure || score >= this.flagThreshold) {
      status = 'suspicious';
    } else if (positiveEvidence) {
      status = 'verified';
    } else {
      status = 'unknown';
    }

    return { status, score, flags };
  }
}
