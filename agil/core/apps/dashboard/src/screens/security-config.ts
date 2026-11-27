/**
 * Pure liveness/AV policy mapping for the security screen.
 *
 * Kept outside `security.ts` so the save payload can be tested without a DOM
 * (QA P3-2). Both policy objects carry schema-level defaults, so the PATCH must
 * always send complete objects — `buildLivenessAvPatch` is the single place
 * that decides which fields go out.
 */
import type { TenantConfig, TenantConfigPatch } from '@agil/protocol';

/** Section titles rendered by `/dashboard/#/security`. */
export const LIVENESS_SECTION_TITLE = 'Серверный liveness-челлендж';
export const AV_SECTION_TITLE = 'Антивирусная проверка загрузок';

export interface LivenessAvSectionState {
  livenessEnabled: boolean;
  livenessOnEngineError: 'fail-open' | 'fail-closed';
  avEnabled: boolean;
  avMode: 'async' | 'sync';
  avOnScanError: 'fail-open' | 'fail-closed';
  avMaxScanMb: number;
}

type SecurityPatch = NonNullable<TenantConfigPatch['security']>;

/** Normalised values the two settings blocks display (defaults are off). */
export function livenessAvSectionState(security: TenantConfig['security']): LivenessAvSectionState {
  const liveness = security.liveness;
  const avScan = security.avScan;
  return {
    livenessEnabled: liveness.enabled === true,
    livenessOnEngineError: liveness.onEngineError === 'fail-closed' ? 'fail-closed' : 'fail-open',
    avEnabled: avScan.enabled === true,
    avMode: avScan.mode === 'sync' ? 'sync' : 'async',
    avOnScanError: avScan.onScanError === 'fail-closed' ? 'fail-closed' : 'fail-open',
    avMaxScanMb: Math.min(100, Math.max(1, Math.trunc(avScan.maxScanMb))),
  };
}

/**
 * Complete `liveness` + `avScan` patch objects for `PATCH /v1/tenants/:id/config`.
 * Sending only changed nested keys is not enough: the server's config schema
 * defaults would otherwise reset the omitted policy field.
 */
export function buildLivenessAvPatch(security: TenantConfig['security']): Pick<SecurityPatch, 'liveness' | 'avScan'> {
  const state = livenessAvSectionState(security);
  return {
    liveness: {
      enabled: state.livenessEnabled,
      onEngineError: state.livenessOnEngineError,
    },
    avScan: {
      enabled: state.avEnabled,
      mode: state.avMode,
      onScanError: state.avOnScanError,
      maxScanMb: state.avMaxScanMb,
    },
  };
}
