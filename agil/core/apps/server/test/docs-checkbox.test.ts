/** Docs explorer checkbox UX (label hit-area, custom box, toggle) + static markup guard. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delay, startTestServer, type TestServer } from './helpers.js';

let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  await ts.close();
});

function findChrome(): string | undefined {
  return [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate!));
}

test('docs explorer: admin-spec checkbox is a full label with a custom 20px box', async () => {
  const docs = await ts.api('GET', '/docs');
  assert.equal(docs.status, 200);
  assert.ok(docs.text.includes('<label class="check" for="adminSpec"'), 'label is associated with the input');
  assert.ok(docs.text.includes('title="admin-спека:'), 'technical term is in the title tooltip');
  assert.ok(docs.text.includes('Показывать админские методы'), 'human-readable label text');
  assert.ok(docs.text.includes('type="checkbox" id="adminSpec"'));
  assert.ok(docs.text.includes('<span class="box" aria-hidden="true">'));
  assert.ok(docs.text.includes('min-height:44px') && docs.text.includes('.check .box { width:20px; height:20px'), '44px hit target + 20px box');
  assert.ok(docs.text.includes('input:focus-visible + .box'), 'focus ring for keyboard users');
});

test('docs explorer: disclosure and checkbox work in a real browser (390/768/1440, light/dark)', async (t) => {
  const executablePath = findChrome();
  if (!executablePath) {
    t.skip('Chrome/Edge not available for the DOM check');
    return;
  }
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  try {
    for (const width of [390, 768, 1440]) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage();
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
        await page.setViewport({ width, height: 900 });
        await page.goto(`${ts.base}/docs`, { waitUntil: 'networkidle0' });
        const guide = '#guide';
        const summary = `${guide} > summary`;
        const isGuideOpen = () => page.$eval(guide, (el) => (el as HTMLDetailsElement).open);
        assert.equal(await isGuideOpen(), false, `${width}/${theme}: guide starts closed`);
        await page.click(summary);
        assert.equal(await isGuideOpen(), true, `${width}/${theme}: click opens guide`);
        await page.focus(summary);
        await page.keyboard.press('Enter');
        assert.equal(await isGuideOpen(), false, `${width}/${theme}: Enter closes guide`);

        const result = await page.evaluate(() => {
          const label = document.querySelector('label.check[for="adminSpec"]') as HTMLLabelElement | null;
          const input = document.querySelector('#adminSpec') as HTMLInputElement | null;
          const box = label?.querySelector('.box') as HTMLElement | null;
          const rect = label?.getBoundingClientRect();
          const boxRect = box?.getBoundingClientRect();
          return {
            exists: Boolean(label && input && box),
            contains: Boolean(label && input && label.contains(input)),
            labelHeight: rect?.height ?? 0,
            labelWidth: rect?.width ?? 0,
            boxWidth: boxRect?.width ?? 0,
            boxHeight: boxRect?.height ?? 0,
            text: label?.textContent?.trim() ?? '',
            clipped: label ? label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1 : true,
            pageScrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            labelRight: rect?.right ?? 0,
            viewport: document.documentElement.clientWidth,
          };
        });
        assert.equal(result.exists, true, `${width}/${theme}: label + input + box exist`);
        assert.equal(result.contains, true, `${width}/${theme}: label.contains(input)`);
        assert.ok(result.labelHeight >= 44, `${width}/${theme}: hit area height ${result.labelHeight}`);
        assert.ok(result.labelWidth >= 44, `${width}/${theme}: hit area width ${result.labelWidth}`);
        assert.ok(result.boxWidth >= 18 && result.boxWidth <= 20, `${width}/${theme}: checkbox ${result.boxWidth}px`);
        assert.ok(result.boxHeight >= 18 && result.boxHeight <= 20);
        assert.ok(result.text.includes('Показывать админские методы'), `${width}/${theme}: full label text`);
        assert.equal(result.clipped, false, `${width}/${theme}: label is not clipped`);
        assert.ok(result.pageScrollWidth <= result.clientWidth, `${width}/${theme}: no horizontal page overflow`);
        assert.ok(result.labelRight <= result.viewport + 0.5, `${width}/${theme}: label inside viewport`);

        // Clicking the label toggles the checkbox (label is a real hit-area).
        await page.click('label.check');
        assert.equal(await page.$eval('#adminSpec', (el) => (el as HTMLInputElement).checked), true, `${width}/${theme}: click checks it`);
        await page.keyboard.press('Tab');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        await page.click('label.check');
        assert.equal(await page.$eval('#adminSpec', (el) => (el as HTMLInputElement).checked), false, `${width}/${theme}: click unchecks it`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('docs explorer: direct links and keyboard move to the requested operation', async (t) => {
  const executablePath = findChrome();
  if (!executablePath) return t.skip('Chrome/Edge is required');
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  try {
    for (const [width, theme] of [[320, 'light'], [1440, 'dark']] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 720 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/openapi.json') {
          void delay(700).then(() => request.continue());
        } else {
          void request.continue();
        }
      });
      const directId = 'op-post--v1-rooms-roomId-chat';
      await page.goto(`${ts.base}/docs#${directId}`);
      await page.waitForSelector(`#${directId}`);
      const focusedHeading = () => page.evaluate(() => ({
        id: document.activeElement?.id,
        top: document.activeElement?.getBoundingClientRect().top,
      }));
      const direct = await focusedHeading();
      assert.equal(direct.id, directId, `${width}px: direct link focuses the loaded operation`);
      assert.ok(direct.top !== undefined && direct.top >= -1 && direct.top < 160);

      const nextId = 'op-get--v1-rooms-roomId-transcript';
      await page.focus(`#nav a[href="#${nextId}"]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction((id) => location.hash === '#' + id, {}, nextId);
      const next = await focusedHeading();
      assert.equal(next.id, nextId, `${width}px: Enter moves focus from navigation to its operation`);
      assert.ok(next.top !== undefined && next.top >= -1 && next.top < 160);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.id), `${nextId}-param-path-roomId`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('docs explorer: spec selection, credentials and real requests', async (t) => {
  const executablePath = findChrome();
  if (!executablePath) return t.skip('Chrome/Edge is required');
  assert.equal((await ts.api('PATCH', '/v1/tenants/demo/config', {
    headers: { 'x-api-key': 'dev-key' }, body: { features: { fileShare: true } },
  })).status, 200);
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 320, height: 600 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      if (!sessionStorage.getItem('qa-initialized')) {
        localStorage.setItem('agil.docs.apiKey', 'legacy-qa-key');
        localStorage.setItem('agil.docs.bearer', 'legacy-qa-token');
        sessionStorage.setItem('qa-initialized', 'true');
      }
    });
    await page.goto(`${ts.base}/docs`);
    await page.waitForSelector('section.op');
    const checkTag = async (present: boolean) => page.waitForFunction((expected) => {
      const options = Array.from(document.querySelectorAll<HTMLOptionElement>('#tagFilter option'));
      return options.some((opt) => opt.value === 'Admin') === expected;
    }, { timeout: 5000 }, present);
    await checkTag(false);
    await page.click('label.check');
    await checkTag(true);
    assert.equal(await page.$eval('#download', (link) => (link as HTMLAnchorElement).download), 'openapi.admin.json');
    await page.select('#tagFilter', 'Admin');
    await page.waitForFunction(() => document.querySelectorAll('#nav h3').length === 1 &&
      [...document.querySelectorAll('section.op h2')].some((heading) => heading.textContent?.includes('/v1/admin/')));
    await page.click('label.check');
    await checkTag(false);
    assert.equal(await page.$eval('#tagFilter', (filter) => (filter as HTMLSelectElement).value), '');

    await page.setRequestInterception(true);
    let releaseAdmin: (() => Promise<void>) | undefined;
    const holdAdmin = (request: import('puppeteer-core').HTTPRequest) => {
      if (new URL(request.url()).pathname === '/openapi.admin.json') releaseAdmin = () => request.continue();
      else void request.continue();
    };
    page.on('request', holdAdmin);
    await page.click('label.check');
    for (let attempt = 0; !releaseAdmin && attempt < 50; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(releaseAdmin);
    await page.click('label.check');
    await page.waitForSelector('#download[href="/openapi.json"]');
    await releaseAdmin();
    await page.waitForNetworkIdle();
    await checkTag(false);
    assert.equal(await page.$eval('#download', (link) => (link as HTMLAnchorElement).download), 'openapi.json');
    page.off('request', holdAdmin);
    await page.setRequestInterception(false);

    await page.click('.connection-settings summary');
    await page.type('#apiKey', 'dev-key');
    await page.type('#bearer', 'qa-page-token');
    await page.click('#save');
    assert.deepEqual(await page.evaluate(() => [
      localStorage.getItem('agil.docs.server'), localStorage.getItem('agil.docs.apiKey'), localStorage.getItem('agil.docs.bearer'),
    ]), [ts.base, null, null]);
    await page.$eval('#bearer', (el) => { (el as HTMLInputElement).value = ''; });

    await page.type('#search', 'post /v1/rooms');
    const create = '#op-post--v1-rooms';
    const draft = JSON.stringify({ name: 'Черновик комнаты' });
    await page.$eval(`${create} textarea`, (field, value) => { (field as HTMLTextAreaElement).value = value; }, draft);
    const setSearch = (value: string) => page.$eval('#search', (field, next) => {
      (field as HTMLInputElement).value = next;
      field.dispatchEvent(new Event('input'));
    }, value);
    await setSearch('does not match any API operation');
    assert.equal(await page.$(create), null);
    await setSearch('post /v1/rooms');
    assert.equal(await page.$eval(`${create} textarea`, (field) => (field as HTMLTextAreaElement).value), draft);
    await page.select('#tagFilter', 'Files');
    assert.equal(await page.$(create), null);
    await page.select('#tagFilter', '');
    assert.equal(await page.$eval(`${create} textarea`, (field) => (field as HTMLTextAreaElement).value), draft);
    await page.$eval(`${create} textarea`, (field) => { (field as HTMLTextAreaElement).value = '{'; });
    let creates = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/rooms') creates += 1;
    });
    await page.click(`${create} button.primary`);
    assert.match(await page.$eval(`${create} pre`, (el) => el.textContent || ''), /синтаксис JSON/);
    assert.equal(creates, 0);
    await page.$eval(`${create} textarea`, (field) => { (field as HTMLTextAreaElement).value = JSON.stringify({ name: "QA d'API" }); });
    await page.click(`${create} button:not(.primary)`);
    const command = await page.$eval(`${create} pre`, (el) => el.textContent || '');
    assert.ok(command.startsWith('curl -X POST') && command.includes('<ADMIN_KEY>') && command.includes(`'"'"'`));
    assert.ok(!command.includes('dev-key'));
    await page.evaluate(() => {
      const clipboard = {};
      Reflect.set(clipboard, 'writeText', (value: string) => {
        document.documentElement.dataset.clipboard = value;
        return Promise.resolve();
      });
      Object.defineProperty(navigator, 'clipboard', { value: clipboard });
    });
    await page.click(`${create} button:not(.primary)`);
    await page.waitForFunction(() => Boolean(document.documentElement.dataset.clipboard));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.clipboard), command);
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/rooms' && response.request().method() === 'POST');
    await page.click(`${create} button.primary`);
    const createdResponse = await created;
    assert.equal(createdResponse.status(), 200);
    const token = (await createdResponse.json()).token;
    assert.ok(token);
    await page.waitForSelector(`${create} .pill.ok`);
    assert.equal(creates, 1);

    await setSearch('post /scim/v2/users');
    const scim = '#op-post--scim-v2-Users';
    await page.$eval(`${scim} textarea`, (field) => { (field as HTMLTextAreaElement).value = '{"userName":"QA"}'; });
    await page.click(`${scim} button:not(.primary)`);
    await page.waitForFunction(() => document.documentElement.dataset.clipboard?.includes('application/scim+json'));

    await page.$eval('#search', (field) => { (field as HTMLInputElement).value = ''; field.dispatchEvent(new Event('input')); });
    await page.type('#search', 'get /v1/rooms/{roomId}');
    const room = '#op-get--v1-rooms-roomId-';
    assert.equal(await page.$eval(`${room} label`, (label) => Boolean((label as HTMLLabelElement).control)), true);
    await page.click(`${room} button.primary`);
    assert.match(await page.$eval(`${room} pre`, (el) => el.textContent || ''), /обязательные параметры.*roomId/);

    await page.$eval('#search', (field) => { (field as HTMLInputElement).value = ''; field.dispatchEvent(new Event('input')); });
    await page.type('#search', 'post /v1/files');
    const files = '#op-post--v1-files';
    assert.ok(await page.$(`${files} input[type=file]`));
    await page.click(`${files} button.primary`);
    assert.match(await page.$eval(`${files} pre`, (el) => el.textContent || ''), /Выберите файл/);
    await page.$eval('#bearer', (input, value) => { (input as HTMLInputElement).value = value; }, token);
    await page.$eval(`${files} input[type=file]`, (field) => {
      const files = new DataTransfer();
      files.items.add(new File(['Docs browser QA'], 'отчёт.txt', { type: 'text/plain' }));
      (field as HTMLInputElement).files = files.files;
    });
    const uploaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/files' && response.request().method() === 'POST');
    await page.click(`${files} button.primary`);
    const uploadedResponse = await uploaded;
    assert.equal(uploadedResponse.status(), 200);
    const uploadedFile = await uploadedResponse.json();
    assert.equal(uploadedFile.name, 'отчёт.txt');
    assert.equal(uploadedFile.size, Buffer.byteLength('Docs browser QA'));
    assert.equal(await page.evaluate(() => document.querySelector('section.op').getBoundingClientRect().right <= innerWidth), true);
    await page.reload();
    await page.waitForSelector('section.op');
    assert.deepEqual(await page.$$eval('#apiKey, #bearer', (inputs) => inputs.map((input) => (input as HTMLInputElement).value)), ['', '']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('docs explorer: every OpenAPI operation has a usable form and navigation link', async (t) => {
  const executablePath = findChrome();
  if (!executablePath) return t.skip('Chrome/Edge is required');
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  const downloads = await mkdtemp(join(tmpdir(), 'agil-openapi-'));
  try {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    for (const width of [320, 1440]) {
      await page.setViewport({ width, height: 840 });
      await page.goto(`${ts.base}/docs`);
      for (const endpoint of ['/openapi.json', '/openapi.admin.json']) {
        if (endpoint.endsWith('.admin.json')) await page.click('label.check');
        await page.waitForSelector(`#download[href="${endpoint}"]`);
        const matrix = await page.evaluate(async (url) => {
          const spec = await fetch(url).then((response) => response.json()) as {
            paths: Record<string, Record<string, {
              parameters?: Array<{ name: string; in: string; required?: boolean }>;
              requestBody?: { required?: boolean; content: Record<string, { schema?: { format?: string } }> };
            }>>;
          };
          const problems: string[] = [];
          let total = 0;
          for (const [path, methods] of Object.entries(spec.paths)) {
            for (const [method, operation] of Object.entries(methods)) {
              total += 1;
              const id = `op-${method}-${path.replace(/[^a-z0-9]+/gi, '-')}`;
              const sections = document.querySelectorAll<HTMLElement>(`section.op[id="${id}"]`);
              const section = sections[0];
              const send = section?.querySelector<HTMLButtonElement>('button.primary');
              const copy = section?.querySelector<HTMLButtonElement>('button:not(.primary)');
              const label = `${method.toUpperCase()} ${path}`;
              const nav = [...document.querySelectorAll<HTMLAnchorElement>(`#nav a[href="#${id}"]`)];
              if (sections.length !== 1 || !send || !copy || !nav.some((link) => link.textContent === label)) {
                problems.push(`${label}: missing or duplicate form or navigation`);
                continue;
              }
              if (section.getBoundingClientRect().right > innerWidth + 1) problems.push(`${label}: horizontal overflow`);
              for (const parameter of operation.parameters ?? []) {
                const input = document.getElementById(`${id}-param-${parameter.in}-${parameter.name}`) as HTMLInputElement | null;
                if (!input?.labels?.length || input.required !== Boolean(parameter.required)) {
                  problems.push(`${label}: invalid parameter ${parameter.name}`);
                }
              }
              const requestBody = operation.requestBody;
              const body = document.getElementById(`${id}-body`) as HTMLInputElement | HTMLTextAreaElement | null;
              if (requestBody) {
                const hasJson = Object.keys(requestBody.content).some((type) => type === 'application/json' || type.endsWith('+json'));
                const binary = !hasJson && Object.values(requestBody.content)
                  .some((media) => media.schema?.format === 'binary');
                if (!body?.labels?.length || body.required !== Boolean(requestBody.required) ||
                    (binary ? body.type !== 'file' : body.tagName !== 'TEXTAREA')) {
                  problems.push(`${label}: invalid request body`);
                }
              }
              if (operation.parameters?.some((parameter) => parameter.required)) {
                send.click();
                if (!section.querySelector('pre')?.textContent?.includes('обязательные параметры')) problems.push(`${label}: no missing parameter error`);
              } else if (body?.tagName === 'TEXTAREA') {
                body.value = '{';
                send.click();
                if (!section.querySelector('pre')?.textContent?.includes('синтаксис JSON')) problems.push(`${label}: no JSON syntax error`);
              } else if (body?.required) {
                send.click();
                if (!section.querySelector('pre')?.textContent?.includes('Выберите файл')) problems.push(`${label}: no missing file error`);
              }
            }
          }
          return { total, rendered: document.querySelectorAll('section.op').length, problems };
        }, endpoint);
        assert.ok(matrix.total > 0);
        assert.equal(matrix.rendered, matrix.total);
        assert.deepEqual(matrix.problems, [], `${width}px ${endpoint}`);
        t.diagnostic(`${width}px ${endpoint}: ${matrix.total} operation forms`);
        if (width === 320) {
          const file = join(downloads, endpoint.slice(1));
          await page.click('#download');
          for (let attempt = 0; !existsSync(file) && attempt < 60; attempt += 1) await delay(100);
          const downloaded = JSON.parse(await readFile(file, 'utf8'));
          assert.equal(downloaded.info.version, await page.$eval('#ver', (element) => element.textContent));
          assert.equal(Object.values(downloaded.paths).reduce<number>((total, methods) => total + Object.keys(methods as object).length, 0), matrix.total);
        }
      }
    }
  } finally {
    await browser.close();
    await rm(downloads, { recursive: true, force: true });
  }
});
