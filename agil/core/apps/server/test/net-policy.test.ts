/**
 * IP allowlist policy (docs/pilot/domain-tls-evidence.md §8.2 retest P1).
 *
 * The root-cause bug was `isIpAllowed()` returning **true** for a non-empty
 * allowlist that parsed to zero rules: a typo (`172.17.0.1/33`, a hostname, a
 * stray character) silently opened the gate instead of closing it. These tests
 * pin the fixed contract:
 * - empty allowlist = "no restriction" (the docs/admin/enroll defaults);
 * - non-empty allowlist with zero valid IP/CIDR rules = deny everyone
 *   (fail closed), never allow-all;
 * - with at least one valid rule, only the valid rules decide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIpAllowed, parseAllowlist } from '../src/net-policy.js';

test('empty allowlist keeps the documented "no restriction" default', () => {
  assert.equal(isIpAllowed('203.0.113.7', []), true);
  assert.equal(isIpAllowed('::1', []), true);
  // Historical call sites (docs/admin/enroll) rely on this branch; the
  // /v1/domain/ask handler rejects an empty list before calling this function.
});

test('non-empty allowlist with zero valid rules fails closed', () => {
  const broken: string[][] = [
    ['typo'],
    ['172.17.0.1/33'],
    ['172.17.0.1/-1'],
    ['calls.example.com'],
    ['*'],
    ['127.0.0.1:8787'],
    ['typo', '172.17.0.1/33', '10.0.0.1/8/9'],
    ['   '],
  ];
  for (const allowlist of broken) {
    assert.equal(parseAllowlist(allowlist).length, 0, `${JSON.stringify(allowlist)} parses to zero rules`);
    assert.equal(
      isIpAllowed('127.0.0.1', allowlist),
      false,
      `${JSON.stringify(allowlist)} must not allow loopback`,
    );
    assert.equal(
      isIpAllowed('203.0.113.7', allowlist),
      false,
      `${JSON.stringify(allowlist)} must not allow an external IP`,
    );
    assert.equal(isIpAllowed(undefined, allowlist), false, `${JSON.stringify(allowlist)} must not allow an unknown peer`);
  }
});

test('only valid entries decide when the allowlist mixes valid and invalid rules', () => {
  const allowlist = ['typo', '10.9.8.7', '172.17.0.1/33'];
  assert.equal(isIpAllowed('10.9.8.7', allowlist), true);
  assert.equal(isIpAllowed('10.9.8.8', allowlist), false);
  assert.equal(isIpAllowed('127.0.0.1', allowlist), false);
});

test('IPv4 and IPv6 CIDR matching', () => {
  const v4 = ['203.0.113.0/24'];
  assert.equal(isIpAllowed('203.0.113.7', v4), true);
  assert.equal(isIpAllowed('203.0.113.255', v4), true);
  assert.equal(isIpAllowed('203.0.114.1', v4), false);
  assert.equal(isIpAllowed('::1', v4), false);

  const v6 = ['2001:db8::/32'];
  assert.equal(isIpAllowed('2001:db8:1::5', v6), true);
  assert.equal(isIpAllowed('2001:db9::1', v6), false);
  assert.equal(isIpAllowed('203.0.113.7', v6), false);

  // A host route without a prefix length is a /32 (v4) or /128 (v6).
  assert.equal(isIpAllowed('198.51.100.4', ['198.51.100.4']), true);
  assert.equal(isIpAllowed('198.51.100.5', ['198.51.100.4']), false);
  assert.equal(isIpAllowed('::1', ['::1']), true);
  assert.equal(isIpAllowed('::2', ['::1']), false);
});

test('malformed peer addresses are denied even with a valid allowlist', () => {
  assert.equal(isIpAllowed('', ['0.0.0.0/0']), false);
  assert.equal(isIpAllowed('not-an-ip', ['0.0.0.0/0']), false);
  assert.equal(isIpAllowed(undefined, ['0.0.0.0/0']), false);
  // `0.0.0.0/0` covers IPv4 only; it must not become a universal matcher.
  assert.equal(isIpAllowed('::1', ['0.0.0.0/0']), false);
});
