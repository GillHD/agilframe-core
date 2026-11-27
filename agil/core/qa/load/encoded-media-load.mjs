/** Local SFU and one Chromium subscriber. Publishers read VP8 files from disk. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { cpus, networkInterfaces } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const [liveKitBin, publishersBin, outputDir, ...options] = process.argv.slice(2);
const widgetMode = options.includes('--widget');
const clipsOption = options.find((entry) => entry.startsWith('--clips='));
const clipsDir = clipsOption?.slice('--clips='.length);
const audioOption = options.find((entry) => entry.startsWith('--audio='));
const audioFile = audioOption?.slice('--audio='.length);
const matrix = options.filter((entry) => entry !== '--widget' && entry !== clipsOption && entry !== audioOption);
assert.ok(liveKitBin && publishersBin && outputDir, 'Usage: node encoded-media-load.mjs LIVEKIT PUBLISHERS OUTPUT_DIR [10:low 25:low 10:high 25:high] [--widget] [--clips=DIR] [--audio=FILE]');
assert.ok(!clipsOption || clipsDir, '--clips requires a directory of VP8 IVF files');
assert.ok(!audioOption || (widgetMode && audioFile?.endsWith('.ogg')), '--audio requires --widget and a prepared Opus .ogg file');
if (audioFile) await access(audioFile);
const scenarios = (matrix.length ? matrix : ['10:low', '25:low', '10:high', '25:high']).map((entry) => {
  const [, count, quality] = /^(\d+):(low|high)$/.exec(entry) ?? [];
  assert.ok(Number(count) >= 1 && Number(count) <= 199, 'Expected N:low or N:high for 1–199 publishers');
  return { count: Number(count), quality };
});
const inputs = { low: { width: 320, height: 180, bitrate: '190k' }, high: { width: 1280, height: 720, bitrate: '1500k' } };
const fps = 15;
const apiKey = 'loopback-benchmark';
const secret = randomBytes(32).toString('hex');
const maxRunMs = 30000;
const steadyMs = 8000;
const localAddresses = Object.values(networkInterfaces()).flat()
  .filter((entry) => entry.family === 'IPv4' && !entry.internal)
  .map((entry) => entry.address);
const mediaIp = process.env.AGIL_QA_MEDIA_IP || localAddresses[0];
assert.ok(localAddresses.includes(mediaIp), 'AGIL_QA_MEDIA_IP must be an IPv4 address assigned to this machine');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function availablePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function availableUdpPort() {
  const socket = createSocket('udp4').bind(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function run(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  const finished = once(child, 'close');
  // The caller may first wait for readiness; keep a later spawn failure observable.
  void finished.catch(() => {});
  return { child, finished };
}

async function waitUntil(check, timeout, message) {
  const end = performance.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(150);
  } while (performance.now() < end);
  throw new Error(message);
}

function hostTicks() {
  return cpus().reduce(({ total, idle }, core) => ({
    total: total + Object.values(core.times).reduce((sum, value) => sum + value, 0),
    idle: idle + core.times.idle,
  }), { total: 0, idle: 0 });
}

function cpuPercent(before, after) {
  return Math.round(100 * (1 - (after.idle - before.idle) / (after.total - before.total)));
}

function token(room) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = encode({ iss: apiKey, sub: 'receiver', exp: Math.floor(Date.now() / 1000) + 120,
    video: { room, roomJoin: true, canSubscribe: true, canPublish: false } });
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

async function verifyClip(file, width, height) {
  const clip = await open(file, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await clip.read(header);
    assert.ok(bytesRead === header.length && header.toString('ascii', 0, 4) === 'DKIF' &&
      header.toString('ascii', 8, 12) === 'VP80', `${file}: expected a VP8 IVF clip`);
    assert.deepEqual([header.readUInt16LE(12), header.readUInt16LE(14)], [width, height], `${file}: unexpected dimensions`);
    assert.equal(header.readUInt32LE(16) / header.readUInt32LE(20), fps, `${file}: unexpected frame rate`);
  } finally {
    await clip.close();
  }
}

await mkdir(outputDir, { recursive: true });
for (const quality of new Set(scenarios.map((scenario) => scenario.quality))) {
  const { width, height, bitrate } = inputs[quality];
  const file = path.resolve(clipsDir || outputDir, `${quality}.ivf`);
  inputs[quality].file = file;
  if (clipsDir) {
    await verifyClip(file, width, height);
    continue;
  }
  const encoder = run(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `testsrc2=size=${width}x${height}:rate=${fps}`, '-t', '60', '-an',
    '-c:v', 'libvpx', '-threads', '4', '-deadline', 'realtime', '-cpu-used', '5',
    '-b:v', bitrate, '-g', String(fps), '-f', 'ivf', file,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  assert.equal((await encoder.finished)[0], 0, `FFmpeg failed for ${quality}`);
}

const [html, js] = await Promise.all([
  readFile(new URL('encoded-receiver.html', import.meta.url)),
  readFile(new URL('../../../../node_modules/livekit-client/dist/livekit-client.umd.js', import.meta.url)),
]);
const receiver = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/livekit.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/livekit.js' ? js : html);
});
const receiverPort = await listen(receiver);

async function startSfu(scenario) {
  const httpPort = await availablePort();
  let tcpPort = await availablePort();
  while (tcpPort === httpPort) tcpPort = await availablePort();
  const udpPort = await availableUdpPort();
  const config = JSON.stringify({
    rtc: { ips: { includes: [`${mediaIp}/32`] }, stun_servers: ['127.0.0.1:9'] },
    logging: { level: 'warn' },
  });
  const { child, finished } = run(liveKitBin, [
    '--bind', '127.0.0.1', '--node-ip', mediaIp, '--port', String(httpPort),
    '--rtc.tcp_port', String(tcpPort), '--udp-port', String(udpPort), '--keys', `${apiKey}: ${secret}`,
    '--config-body', config,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8').on('data', (chunk) => { log = (log + chunk).slice(-20000); });
  }
  const close = async () => {
    child.kill();
    try {
      await finished;
    } finally {
      if (log) await writeFile(path.join(outputDir, `livekit-${scenario}.log`), log.replaceAll(secret, '[redacted]'));
    }
  };
  try {
    await waitUntil(() => fetch(`http://127.0.0.1:${httpPort}`, { signal: AbortSignal.timeout(1000) })
      .then((res) => res.ok).catch(() => false), 8000, 'LiveKit did not become ready');
  } catch (error) {
    await close();
    throw error;
  }
  return { url: `ws://127.0.0.1:${httpPort}`, close };
}
let browser;
let baselineCpuPct;
const results = [];
const reportPath = path.join(outputDir, 'report.json');
const writeReport = () => writeFile(reportPath, JSON.stringify({
  fps, cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, baselineCpuPct, results,
  receiver: widgetMode ? 'agil-widget' : 'all-tracks',
  cameraFixtures: clipsDir ? 'existing-vp8' : 'encoded-before-benchmark',
  audioFixture: audioFile ? 'existing-opus' : null,
}, null, 2));
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: widgetMode ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] : [],
  });
  const baseline = hostTicks();
  await delay(steadyMs);
  baselineCpuPct = cpuPercent(baseline, hostTicks());
  for (const { count, quality } of scenarios) {
    const room = `bench-${randomBytes(6).toString('hex')}`;
    const { width, height, file } = inputs[quality];
    const label = `${count}-${quality}`;
    const sfu = await startSfu(label);
    let context;
    let publishers;
    let widget;
    try {
      context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      if (widgetMode) {
        const { startWidgetReceiver } = await import('./encoded-widget-receiver.mjs');
        widget = await startWidgetReceiver(page, { count, url: sfu.url, apiKey, secret });
      } else {
        await page.goto(`http://127.0.0.1:${receiverPort}/`);
        await page.evaluate((config) => window.connectReceiver(config), { url: sfu.url, token: token(room), count });
      }
      publishers = run(publishersBin, [
        '-url', sfu.url, '-room', widget?.room ?? room, '-file', file, '-count', String(count),
        '-width', String(width), '-height', String(height), '-fps', String(fps),
        ...(audioFile ? ['-audio', path.resolve(audioFile)] : []),
      ], { env: { ...process.env, LIVEKIT_API_KEY: apiKey, LIVEKIT_API_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'] });
      await once(publishers.child, 'spawn');
      let publishedOutput = '';
      let errors = '';
      publishers.child.stdout.setEncoding('utf8').on('data', (chunk) => { publishedOutput += chunk; });
      publishers.child.stderr.setEncoding('utf8').on('data', (chunk) => { errors = (errors + chunk).slice(-8000); });
      if (widget) {
        const result = await widget.check({ count, width, height, fps, steadyMs, hostTicks, cpuPercent, withAudio: Boolean(audioFile) }).catch((error) => {
          const published = [...publishedOutput.matchAll(/^PUBLISHED (guest-\d+)\s*$/gm)].length;
          const microphones = [...publishedOutput.matchAll(/^AUDIO (guest-\d+)\s*$/gm)].length;
          throw new Error(`${count} ${quality}: ${published} cameras and ${microphones} microphones published. ${error.message}`, { cause: error });
        });
        result.published = [...publishedOutput.matchAll(/^PUBLISHED (guest-\d+)\s*$/gm)].length;
        if (audioFile) result.publishedAudio = [...publishedOutput.matchAll(/^AUDIO (guest-\d+)\s*$/gm)].length;
        await page.screenshot({ path: path.join(outputDir, `grid-${label}.png`) });
        result.receiverReleased = await widget.verifyReleased();
        results.push(result);
        await writeReport();
        const afterScroll = result.initial.virtualized ? `, ${result.scrolled.playing} after scroll` : '';
        console.log(`${count} ${quality}: ${result.published} published, ${result.initial.playing} initial${afterScroll}; ${result.scrolled.subscribed}/${result.budget} subscribed`);
        assert.equal(result.published, count);
        if (audioFile) assert.equal(result.publishedAudio, count);
        continue;
      }
      const sample = () => page.evaluate(() => window.sampleReceiver());
      const started = performance.now();
      const allStarted = await page.waitForFunction((count) => window.startedVideos() === count,
        { timeout: maxRunMs, polling: 150 }, count).then(() => true, (error) => {
        if (error.name !== 'TimeoutError') throw error;
        return false;
      });
      const firstFramesMs = Math.round(performance.now() - started);
      const before = await sample();
      const previousCpu = hostTicks();
      await delay(steadyMs);
      const after = await sample();
      const finalCpu = hostTicks();
      const streams = Object.entries(after).map(([identity, video]) => ({
        identity, width: video.width, height: video.height,
        presented: video.presented - (before[identity]?.presented ?? 0),
        decoded: video.decoded === null ? null : video.decoded - (before[identity]?.decoded ?? 0),
        dropped: video.dropped - (before[identity]?.dropped ?? 0),
        decoder: video.decoder,
        packetsLost: video.packetsLost === null ? null : video.packetsLost - (before[identity]?.packetsLost ?? 0),
      }));
      const replayed = streams.filter((video) => video.width === width && video.height === height && video.presented > 0);
      const result = {
        count, quality, width, height, firstFramesMs, allStarted, sampleMs: steadyMs,
        published: [...publishedOutput.matchAll(/^PUBLISHED (guest-\d+)\s*$/gm)].length,
        presented: replayed.length, realtime: replayed.filter((video) => video.presented >= fps * steadyMs / 1000 * 0.8).length,
        hostCpuPct: cpuPercent(previousCpu, finalCpu),
        errors, streams,
      };
      results.push(result);
      await writeReport();
      await page.screenshot({ path: path.join(outputDir, `grid-${label}.png`) });
      console.log(`${count} ${quality}: ${result.published} published, ${result.presented} presented, ${result.realtime} ≥80% FPS, CPU ${result.hostCpuPct}%`);
    } finally {
      publishers?.child.kill();
      await Promise.all([publishers?.finished, context?.close(), sfu.close(), widget?.close()]);
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
    await writeReport();
  }
}
