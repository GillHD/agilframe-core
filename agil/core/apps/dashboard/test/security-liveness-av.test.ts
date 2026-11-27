/**
 * Dashboard security screen: liveness/AV blocks (QA P3-2).
 *
 * The save handler used to build the two policy objects inline, where a missing
 * optional field would silently reset the server default. These assertions pin
 * the defaults (both features off) and the complete PATCH payload; the visual
 * render itself is exercised by the headless probe in qa-liveness-sip.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, tenantConfigPatchSchema } from '@agil/protocol';
import {
  AV_SECTION_TITLE,
  LIVENESS_SECTION_TITLE,
  buildLivenessAvPatch,
  livenessAvSectionState,
} from '../src/screens/security-config.js';

test('dashboard security: liveness/AV blocks default off and send both complete objects', () => {
  const config = defaultConfig({ tenantId: 'demo' });

  // Defaults rendered by the two blocks: both features off, async + fail-open.
  const defaults = livenessAvSectionState(config.security);
  assert.deepEqual(defaults, {
    livenessEnabled: false,
    livenessOnEngineError: 'fail-open',
    avEnabled: false,
    avMode: 'async',
    avOnScanError: 'fail-open',
    avMaxScanMb: 25,
  });
  assert.equal(LIVENESS_SECTION_TITLE, 'Серверный liveness-челлендж');
  assert.equal(AV_SECTION_TITLE, 'Антивирусная проверка загрузок');

  // Toggling in the UI and saving must send every field, not just changed keys.
  const draft = structuredClone(config);
  draft.security.liveness.enabled = true;
  draft.security.liveness.onEngineError = 'fail-closed';
  draft.security.avScan.enabled = true;
  draft.security.avScan.mode = 'sync';
  draft.security.avScan.onScanError = 'fail-closed';
  draft.security.avScan.maxScanMb = 12;

  const patch = buildLivenessAvPatch(draft.security);
  assert.deepEqual(patch.liveness, { enabled: true, onEngineError: 'fail-closed' });
  assert.deepEqual(patch.avScan, { enabled: true, mode: 'sync', onScanError: 'fail-closed', maxScanMb: 12 });

  // The payload survives the server's patch schema unchanged (no defaults lost).
  const parsed = tenantConfigPatchSchema.parse({ security: patch });
  assert.deepEqual(parsed.security?.liveness, { enabled: true, onEngineError: 'fail-closed' });
  assert.deepEqual(parsed.security?.avScan, { enabled: true, mode: 'sync', onScanError: 'fail-closed', maxScanMb: 12 });

  // Values are clamped to the documented 1..100 MB UI range.
  const clamped = structuredClone(draft);
  clamped.security.avScan.maxScanMb = 500;
  assert.equal(livenessAvSectionState(clamped.security).avMaxScanMb, 100);
});
