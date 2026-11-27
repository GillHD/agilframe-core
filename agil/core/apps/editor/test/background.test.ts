/**
 * Background presets/upload contract.
 *
 * The gallery must ship landscapes inside the repository (no external
 * hotlinks), encode them as portable data URLs, and keep the config under the
 * server's 1 MiB JSON body limit. The browser-only compression path is not
 * exercised here; the pure helpers and the committed assets are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  estimateDataUrlBytes,
  fnv1a,
  formatBytes,
  isLocalImageUrl,
  MAX_BACKGROUND_DATA_URL_CHARS,
  MAX_CONFIG_CHARS,
  minifySvg,
  svgToDataUrl,
} from '../src/background-cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const backgroundsDir = path.resolve(here, '../src/backgrounds');
const svgFiles = readdirSync(backgroundsDir).filter((name) => name.endsWith('.svg'));

test('the gallery ships 4–6 local landscape SVGs', () => {
  assert.ok(svgFiles.length >= 4, `expected at least 4 presets, found ${svgFiles.length}`);
  assert.ok(svgFiles.length <= 6, `expected at most 6 presets, found ${svgFiles.length}`);
});

test('every preset SVG is self-contained (no external hotlinks)', () => {
  for (const name of svgFiles) {
    const svg = readFileSync(path.join(backgroundsDir, name), 'utf8').trim();
    assert.ok(svg.startsWith('<svg'), `${name} must start with <svg`);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name} needs the SVG namespace`);
    assert.doesNotMatch(svg, /(?:href|src|url\()\s*=?\s*["']?https?:\/\//i, `${name} must not reference external URLs`);
    assert.doesNotMatch(svg, /<script/i, `${name} must not contain scripts`);
    assert.ok(Buffer.byteLength(svg, 'utf8') < 8 * 1024, `${name} should stay small (was ${Buffer.byteLength(svg)} bytes)`);
  }
});

test('minifySvg removes inter-tag whitespace and keeps markup', () => {
  const svg = '<svg>\n  <rect/>\n  <circle/>\n</svg>';
  assert.equal(minifySvg(svg), '<svg><rect/><circle/></svg>');
});

test('svgToDataUrl is a percent-encoded data URL without external scheme', () => {
  const url = svgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff"/></svg>');
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.ok(url.includes('%3Csvg'));
  assert.ok(!url.includes('\n'), 'data URL must be single-line');
  assert.ok(!/^https?:/.test(url));
  // `#` and quotes are escaped so the URL is safe inside CSS `url("…")`.
  assert.ok(!url.includes('#'));
  assert.ok(!url.includes('"'));
});

test('estimateDataUrlBytes decodes base64 payloads and measures SVG URLs', () => {
  assert.equal(estimateDataUrlBytes('data:image/png;base64,AAAA'), 3);
  assert.equal(estimateDataUrlBytes('data:image/png;base64,AAA='), 2);
  assert.equal(estimateDataUrlBytes('data:image/png;base64,AA=='), 1);
  const svgUrl = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E';
  assert.equal(estimateDataUrlBytes(svgUrl), svgUrl.length - svgUrl.indexOf(',') - 1);
});

test('formatBytes is Russian-friendly and stable', () => {
  assert.equal(formatBytes(512), '512 Б');
  assert.equal(formatBytes(2048), '2 КБ');
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 МБ');
  assert.equal(formatBytes(-1), '—');
});

test('fnv1a is deterministic and differentiates long data URLs', () => {
  const presetUrl = svgToDataUrl(readFileSync(path.join(backgroundsDir, svgFiles[0] as string), 'utf8'));
  const same = fnv1a(presetUrl);
  assert.equal(fnv1a(presetUrl), same);
  assert.notEqual(fnv1a(`${presetUrl}x`), same);
  assert.match(same, /^[0-9a-f]{8}$/);
});

test('isLocalImageUrl accepts bundled/uploaded data URLs only', () => {
  assert.equal(isLocalImageUrl('data:image/svg+xml;charset=utf-8,%3Csvg%3E'), true);
  assert.equal(isLocalImageUrl('data:image/webp;base64,AAAA'), true);
  assert.equal(isLocalImageUrl('https://example.com/bg.jpg'), false);
  assert.equal(isLocalImageUrl(''), false);
});

test('config budget stays under the server 1 MiB JSON limit', () => {
  assert.ok(MAX_CONFIG_CHARS < 1024 * 1024, 'config cap must be below JSON_BODY_LIMIT');
  assert.ok(MAX_BACKGROUND_DATA_URL_CHARS < MAX_CONFIG_CHARS, 'a single image must fit the config budget');
  // Six presets plus one uploaded image are still a small config: a preset is
  // ~4 KB encoded, so the gallery itself cannot approach the limit.
  for (const name of svgFiles) {
    const url = svgToDataUrl(readFileSync(path.join(backgroundsDir, name), 'utf8'));
    assert.ok(url.length < 16 * 1024, `${name} encoded URL is unexpectedly large (${url.length})`);
  }
});
