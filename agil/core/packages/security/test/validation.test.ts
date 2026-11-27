import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilename, MAX_FILENAME_LENGTH } from '../src/sanitize.js';
import { validateOutboundUrl, MAX_OUTBOUND_URL_LENGTH } from '../src/url-validation.js';

/* ------------------------------------------------------------------ */
/* sanitizeFilename                                                     */
/* ------------------------------------------------------------------ */

test('sanitizeFilename: обычные имена не меняются', () => {
  assert.equal(sanitizeFilename('report.pdf'), 'report.pdf');
  assert.equal(sanitizeFilename('отчёт за 2026 год.docx'), 'отчёт за 2026 год.docx');
  assert.equal(sanitizeFilename('a b_c-1.2.txt'), 'a b_c-1.2.txt');
});

test('sanitizeFilename: basename (POSIX и Windows) — traversal отрезается', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\Windows\\System32\\cmd.exe'), 'cmd.exe');
  assert.equal(sanitizeFilename('/absolute/path/photo.png'), 'photo.png');
  assert.equal(sanitizeFilename('dir\\sub\\file.bin'), 'file.bin');
});

test('sanitizeFilename: ., .., пустые и без-именные значения -> "file"', () => {
  for (const input of ['', '.', '..', '   ', '\u0000', '../../', 'dir/', 'dir\\']) {
    assert.equal(sanitizeFilename(input), 'file', `input=${JSON.stringify(input)}`);
  }
  assert.equal(sanitizeFilename(undefined as unknown as string), 'file');
});

test('sanitizeFilename: управляющие символы и NUL удаляются', () => {
  assert.equal(sanitizeFilename('a\u0000b\u001fc.txt'), 'abc.txt');
  assert.equal(sanitizeFilename('line\nbreak\ttab.txt'), 'linebreaktab.txt');
  assert.equal(sanitizeFilename('\u0000\u0001\u0002'), 'file');
});

test('sanitizeFilename: длина ограничена 180 символами', () => {
  const long = `${'x'.repeat(300)}.txt`;
  const sanitized = sanitizeFilename(long);
  assert.equal(sanitized.length, MAX_FILENAME_LENGTH);
  assert.ok(long.length > MAX_FILENAME_LENGTH);
  assert.equal(MAX_FILENAME_LENGTH, 180);
});

/* ------------------------------------------------------------------ */
/* validateOutboundUrl                                                  */
/* ------------------------------------------------------------------ */

test('validateOutboundUrl: валидные https URL', () => {
  for (const raw of [
    'https://api.example.com/v1/hook',
    'https://example.com:8443/path?x=1#fragment',
    'https://8.8.8.8/',
    'https://[2001:db8::1]/hook',
  ]) {
    const result = validateOutboundUrl(raw);
    assert.equal(result.ok, true, `${raw} -> ${JSON.stringify(result)}`);
    if (result.ok) assert.ok(result.url instanceof URL);
  }
});

test('validateOutboundUrl: http только с allowHttp=true', () => {
  const blocked = validateOutboundUrl('http://example.com/hook');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error, 'http_not_allowed');

  const allowed = validateOutboundUrl('http://example.com/hook', { allowHttp: true });
  assert.equal(allowed.ok, true);
});

test('validateOutboundUrl: неподдерживаемые протоколы и мусор', () => {
  for (const raw of ['', '   ', 'not a url', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,x']) {
    const result = validateOutboundUrl(raw);
    assert.equal(result.ok, false, `raw=${JSON.stringify(raw)}`);
  }
  assert.equal(validateOutboundUrl(null as unknown as string).ok, false);
});

test('validateOutboundUrl: user:password в URL запрещены', () => {
  const result = validateOutboundUrl('https://user:secret@example.com/hook');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'credentials_not_allowed');
});

test('validateOutboundUrl: длина <= 500 символов', () => {
  const ok = `https://example.com/${'a'.repeat(MAX_OUTBOUND_URL_LENGTH - 20)}`;
  assert.ok(ok.length <= MAX_OUTBOUND_URL_LENGTH);
  assert.equal(validateOutboundUrl(ok).ok, true);

  const tooLong = `https://example.com/${'a'.repeat(MAX_OUTBOUND_URL_LENGTH)}`;
  assert.ok(tooLong.length > MAX_OUTBOUND_URL_LENGTH);
  const result = validateOutboundUrl(tooLong);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'url_too_long');
});

test('validateOutboundUrl: private/loopback/link-local адреса блокируются', () => {
  const blocked = [
    'https://localhost/hook',
    'https://localhost./hook',
    'https://api.localhost/hook',
    'https://127.0.0.1/',
    'https://127.1.2.3/',
    'https://2130706433/', // 127.0.0.1 в числовой форме
    'https://0x7f000001/', // 127.0.0.1 в hex-форме
    'https://10.1.2.3/',
    'https://172.16.0.1/',
    'https://172.31.255.255/',
    'https://192.168.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://0.0.0.0/',
    'https://[::1]/',
    'https://[::]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[fe80::1]/',
    'https://[fc00::1]/',
    'https://[fd12:3456::1]/',
  ];
  for (const raw of blocked) {
    const result = validateOutboundUrl(raw);
    assert.equal(result.ok, false, `должен быть заблокирован: ${raw}`);
    if (!result.ok) assert.equal(result.error, 'private_address_not_allowed', raw);
  }
});

test('validateOutboundUrl: публичные адреса не блокируются', () => {
  for (const raw of ['https://8.8.8.8/', 'https://172.32.0.1/', 'https://192.169.0.1/', 'https://api.example.com/']) {
    assert.equal(validateOutboundUrl(raw).ok, true, raw);
  }
});

test('validateOutboundUrl: allowPrivate=true разрешает localhost/private (только dev)', () => {
  for (const raw of ['https://localhost/hook', 'https://127.0.0.1/', 'https://192.168.1.10/', 'https://[::1]/']) {
    assert.equal(validateOutboundUrl(raw, { allowPrivate: true }).ok, true, raw);
  }
  // http всё равно требует явного allowHttp
  assert.equal(validateOutboundUrl('http://localhost/', { allowPrivate: true }).ok, false);
});
