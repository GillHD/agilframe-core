import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaIntegrityService, MEDIA_INTEGRITY_FLAGS } from '../src/integrity.js';

const enabledConfig = {
  enabled: true,
  livenessChallenge: true,
  frameHeuristics: true,
  externalProvider: '',
  flagThreshold: 0.7,
  autoMuteOnHighRisk: false,
  sessionBinding: { enabled: false, bindToIp: false, bindToDevice: false },
};

test('disabled: всегда unknown, score 0, без флагов', () => {
  const service = new MediaIntegrityService({ ...enabledConfig, enabled: false });
  const result = service.evaluate({
    frameTimingRegularity: 1,
    livenessPassed: false,
    faceDetected: false,
    externalScore: 1,
    externalConfigured: true,
    country: 'RU',
    ipCountry: 'US',
  });
  assert.deepEqual(result, { status: 'unknown', score: 0, flags: [] });
});

test('verified: низкий риск + положительные сигналы', () => {
  const service = new MediaIntegrityService(enabledConfig);
  const result = service.evaluate({
    frameTimingRegularity: 0.1,
    livenessPassed: true,
    faceDetected: true,
    externalScore: 0.05,
    externalConfigured: true,
    country: 'RU',
    ipCountry: 'RU',
  });
  assert.equal(result.status, 'verified');
  assert.ok(result.score < 0.7, `score=${result.score}`);
  assert.deepEqual(result.flags, []);
  for (const flag of result.flags) assert.ok(MEDIA_INTEGRITY_FLAGS.includes(flag));
});

test('suspicious: все сигналы высокого риска -> score ~1 и все флаги', () => {
  const service = new MediaIntegrityService(enabledConfig);
  const result = service.evaluate({
    frameTimingRegularity: 0.95,
    livenessPassed: false,
    faceDetected: false,
    externalScore: 0.95,
    externalConfigured: true,
    country: 'RU',
    ipCountry: 'US',
  });
  assert.equal(result.status, 'suspicious');
  assert.ok(result.score >= 0.7, `score=${result.score}`);
  assert.deepEqual([...result.flags].sort(), [
    'external_detector_high',
    'frame_timing_regular',
    'geo_mismatch',
    'liveness_failed',
    'no_face',
  ]);
});

test('suspicious: liveness_failed — жёсткий флаг даже при низком среднем скоре', () => {
  const service = new MediaIntegrityService(enabledConfig);
  const result = service.evaluate({ frameTimingRegularity: 0.1, livenessPassed: false });
  assert.ok(result.score < 0.7, `score=${result.score}`);
  assert.equal(result.status, 'suspicious');
  assert.ok(result.flags.includes('liveness_failed'));
});

test('suspicious: external_detector_high — жёсткий флаг', () => {
  const service = new MediaIntegrityService(enabledConfig);
  const result = service.evaluate({
    frameTimingRegularity: 0.05,
    livenessPassed: true,
    externalConfigured: true,
    externalScore: 0.9,
  });
  assert.equal(result.status, 'suspicious');
  assert.ok(result.flags.includes('external_detector_high'));
});

test('suspicious: score >= flagThreshold при одиночном сигнале', () => {
  const service = new MediaIntegrityService({ ...enabledConfig, flagThreshold: 0.5 });
  const result = service.evaluate({ frameTimingRegularity: 0.6 });
  assert.equal(result.score, 0.6);
  assert.equal(result.status, 'suspicious');
});

test('no_face не является жёстким флагом: без положительных сигналов -> unknown', () => {
  const service = new MediaIntegrityService(enabledConfig);
  const result = service.evaluate({ frameTimingRegularity: 0.1, faceDetected: false });
  assert.equal(result.status, 'unknown');
  assert.ok(result.flags.includes('no_face'));
});

test('unknown: нет сигналов', () => {
  const service = new MediaIntegrityService(enabledConfig);
  assert.deepEqual(service.evaluate({}), { status: 'unknown', score: 0, flags: [] });
  assert.deepEqual(service.evaluate(), { status: 'unknown', score: 0, flags: [] });
});

test('externalScore игнорируется, если externalConfigured !== true', () => {
  const service = new MediaIntegrityService(enabledConfig);
  const result = service.evaluate({ externalScore: 0.99 });
  assert.deepEqual(result, { status: 'unknown', score: 0, flags: [] });
});

test('порог из конфига влияет на статус', () => {
  const strict = new MediaIntegrityService({ ...enabledConfig, flagThreshold: 0.2 });
  const lax = new MediaIntegrityService({ ...enabledConfig, flagThreshold: 0.9 });
  const input = { frameTimingRegularity: 0.5, livenessPassed: true };
  assert.equal(strict.evaluate(input).status, 'suspicious');
  assert.equal(lax.evaluate(input).status, 'verified');
});
