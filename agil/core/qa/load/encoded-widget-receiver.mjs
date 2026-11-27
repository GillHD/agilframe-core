/** Real Core and AGIL widget receiver for the local pre-encoded SFU benchmark. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startTestServer } from '../../apps/server/test/helpers.ts';

const budget = 6;

export async function startWidgetReceiver(page, { count, url, apiKey, secret }) {
  const core = await startTestServer({
    docsDataDir: '', sfuEnabled: true, sfuConfigured: true,
    sfuUrl: url, sfuApiKey: apiKey, sfuApiSecret: secret, sfuProfile: 'high',
  });
  const headers = { 'x-api-key': 'dev-key' };
  try {
    const configured = await core.api('PATCH', '/v1/tenants/demo/config', { headers, body: {
      integrations: { allowedOrigins: [core.base] },
      limits: { maxParticipants: 200, galleryVideoBudget: budget },
      scale: { mediaMode: 'sfu', maxParticipants: 200, maxVideoSubscriptions: budget, sfu: { maxParticipants: 200 } },
    } });
    assert.equal(configured.status, 200);
    const created = await core.api('POST', '/v1/admin/rooms', { headers, body: {
      name: 'Local encoded media QA', maxParticipants: count + 1,
    } });
    assert.equal(created.status, 200);
    assert.equal(created.body.room.maxParticipants, count + 1);
    const room = created.body.room.id;
    const issued = await core.api('POST', '/v1/tokens', { headers, body: {
      tenantId: 'demo', roomId: room, participant: { name: 'Local observer', role: 'guest' },
    } });
    assert.equal(issued.status, 200);
    await page.evaluateOnNewDocument(() => {
      window.qaMediaPeers = [];
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) {
          super(...args);
          window.qaMediaPeers.push(this);
        }
      };
    });
    await page.goto(`${core.base}/robots.txt`);
    await page.evaluate(async ({ room, token }) => {
      // Local fake capture lets Chromium expose hardware-related WebRTC stats.
      // It stays separate from the call and the receiver publishes no media.
      window.qaCapture = await navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 90, frameRate: 1 } });
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Receiver-only benchmark', 'NotAllowedError'); };
      const root = document.createElement('main');
      document.body.style.margin = '0';
      root.style.height = '100dvh';
      document.body.replaceChildren(root);
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/widget/agil-calls-widget.css';
      await new Promise((resolve, reject) => {
        css.onload = resolve;
        css.onerror = reject;
        document.head.append(css);
      });
      const { mountWidget } = await import('/widget/agil-calls-widget.js');
      const call = await mountWidget(root, { room, token, tenantId: 'demo', serverUrl: location.origin, locale: 'ru' });
      window.qaCall = call;
      if (call.getState().phase !== 'joined') await call.join();
    }, { room, token: issued.body.token });
    await page.waitForFunction(() => window.qaCall.getState().settings.sfuStatus === 'connected', { timeout: 20000 });
    return {
      room: `demo__${room}`,
      close: () => core.close(),
      check: (options) => checkWidget(page, options),
      verifyReleased: async () => {
        await page.evaluate(() => window.qaCall.leave());
        await page.waitForFunction(() => document.querySelectorAll('[data-agil-tile], audio[data-agil-sfu-audio]').length === 0 &&
          Object.keys(window.qaCall.getState().remoteStreams).length === 0 &&
          window.qaMediaPeers.every((peer) => peer.connectionState === 'closed'), { timeout: 10000 });
        return true;
      },
    };
  } catch (error) {
    await core.close();
    throw error;
  }
}

async function checkWidget(page, { count, width, height, fps, steadyMs, hostTicks, cpuPercent, withAudio }) {
  await page.waitForFunction((number) => window.qaCall.getState().participants.filter((peer) => peer.state.cam === 'on').length === number,
    { timeout: 35000, polling: 150 }, count).catch(async (error) => {
    const state = await page.evaluate(() => ({
      participants: window.qaCall.getState().participants.length,
      cameras: window.qaCall.getState().participants.filter((peer) => peer.state.cam === 'on').length,
      sfu: window.qaCall.getState().settings.sfuStatus,
    }));
    throw new Error(`Widget publisher discovery: ${JSON.stringify(state)}`, { cause: error });
  });
  const settle = () => page.waitForFunction(() => {
    const grid = document.querySelector('.agil-grid');
    const requested = Number(grid.dataset.videoCount);
    const live = [...grid.querySelectorAll('[data-self="false"] video')]
      .filter((video) => !video.paused && video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 5);
    return requested > 0 && live.length === requested;
  }, { timeout: 20000, polling: 150 });
  if (withAudio) await page.waitForFunction((number) =>
    [...document.querySelectorAll('audio[data-agil-sfu-audio]')].filter((element) => !element.paused).length === number,
  { timeout: 20000, polling: 150 }, count).catch(async (error) => {
    const state = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('audio[data-agil-sfu-audio]')];
      return { audioElements: elements.length, playing: elements.filter((element) => !element.paused).length,
        subscribedAudio: Object.values(window.qaCall.getState().remoteStreams).filter((stream) => stream.getAudioTracks().length).length,
        sfu: window.qaCall.getState().settings.sfuStatus };
    });
    throw new Error(`Widget audio startup: ${JSON.stringify(state)}`, { cause: error });
  });
  const sample = () => page.evaluate(async (withAudio) => {
    const grid = document.querySelector('.agil-grid');
    const live = [...grid.querySelectorAll('[data-self="false"] video')].filter((video) => !video.paused && video.videoWidth > 0);
    const state = window.qaCall.getState();
    const rtc = [];
    const audio = [];
    const playingTracks = new Map();
    if (withAudio) {
      for (const element of document.querySelectorAll('audio[data-agil-sfu-audio]')) {
        if (element.paused || element.muted || element.volume === 0) continue;
        for (const track of element.srcObject?.getAudioTracks() ?? []) {
          if (track.readyState === 'live' && track.enabled) playingTracks.set(track.id, element.dataset.agilSfuAudio);
        }
      }
    }
    for (const peer of window.qaMediaPeers) {
      if (peer.connectionState === 'closed') continue;
      const stats = await peer.getStats();
      for (const entry of stats.values()) {
        if (entry.type !== 'inbound-rtp') continue;
        if (withAudio && entry.kind === 'audio' && entry.packetsReceived > 0) {
          audio.push({ id: entry.id, participant: playingTracks.get(entry.trackIdentifier),
            packets: entry.packetsReceived, energy: entry.totalAudioEnergy ?? 0 });
        }
        if (entry.kind !== 'video' || !entry.framesDecoded) continue;
        const codec = stats.get(entry.codecId)?.mimeType ?? null;
        rtc.push({ codec, width: entry.frameWidth, height: entry.frameHeight, framesDecoded: entry.framesDecoded,
          decoder: entry.decoderImplementation ?? null, powerEfficientDecoder: entry.powerEfficientDecoder ?? null });
      }
    }
    return {
      participants: state.participants.length, virtualized: grid.dataset.virtualized === 'true',
      tiles: grid.querySelectorAll('[data-agil-tile]').length,
      desired: grid.dataset.videoIds.split(',').filter(Boolean),
      subscribed: Object.values(state.remoteStreams).filter((stream) => stream.getVideoTracks().length).length,
      playing: live.length, rtc,
      ...(withAudio ? { audio, audioPlaying: playingTracks.size,
      sampledAt: performance.now() } : {}),
      videos: live.map((video) => ({ id: video.closest('[data-agil-tile]').dataset.participantId,
        width: video.videoWidth, height: video.videoHeight, renderedWidth: Math.round(video.clientWidth),
        renderedHeight: Math.round(video.clientHeight), frames: video.getVideoPlaybackQuality().totalVideoFrames })),
    };
  }, withAudio);
  const audioProgress = (before, after) => {
    const previous = new Map(before.audio.map((entry) => [entry.id, entry]));
    const elapsedMs = Math.round(after.sampledAt - before.sampledAt);
    const continued = after.audio.filter((entry) => previous.has(entry.id));
    const rates = continued.map((entry) => (entry.packets - previous.get(entry.id).packets) * 1000 / Math.max(1, elapsedMs));
    return { elapsedMs, receiving: after.audio.length, playing: after.audioPlaying,
      continuing: continued.length, advancing: rates.filter((rate) => rate > 0).length,
      withSignal: continued.filter((entry) => entry.energy > previous.get(entry.id).energy).length,
      minPacketsPerSecond: rates.length ? Math.round(Math.min(...rates)) : 0 };
  };
  const measure = async (previousView) => {
    await settle();
    const before = await sample();
    const baseline = hostTicks();
    const started = performance.now();
    await delay(steadyMs);
    const view = await sample();
    const sampleMs = performance.now() - started;
    const precedingFrames = new Map(before.videos.map(({ id, frames }) => [id, frames]));
    const frameDeltas = view.videos.map(({ id, frames }) => ({ id, presented: frames - (precedingFrames.get(id) ?? frames) }));
    const threshold = fps * sampleMs / 1000 * 0.8;
    return { ...view, frameDeltas, sampleMs: Math.round(sampleMs),
      advanced: frameDeltas.filter(({ presented }) => presented > 0).length,
      realtime: frameDeltas.filter(({ presented }) => presented >= threshold).length,
      ...(withAudio ? { audioProgress: audioProgress(before, view),
        ...(previousView ? { audioDuringScroll: audioProgress(previousView, before) } : {}) } : {}),
      cpuPct: cpuPercent(baseline, hostTicks()) };
  };
  const initial = await measure();
  let scrolled = initial;
  if (initial.virtualized) {
    await page.hover('.agil-grid');
    await page.mouse.wheel({ deltaY: 100000 });
    await page.waitForFunction((ids) => {
      const next = document.querySelector('.agil-grid')?.dataset.videoIds?.split(',').filter(Boolean);
      return next?.length && next.every((id) => !ids.includes(id));
    }, {}, initial.desired);
    scrolled = await measure(initial);
  }
  for (const view of [initial, scrolled]) {
    assert.equal(view.participants, count);
    assert.ok(view.playing > 0 && view.playing === view.desired.length && view.subscribed <= budget && view.desired.length <= budget);
    assert.equal(view.advanced, view.playing, 'every playing video must advance across the measurement window');
    assert.ok(view.videos.every((video) => video.width === width && video.height === height));
  }
  if (withAudio) {
    const expectedParticipants = Array.from({ length: count }, (_, index) => `guest-${String(index + 1).padStart(3, '0')}`);
    for (const view of [initial, scrolled]) {
      assert.deepEqual(view.audio.map((stream) => stream.participant).sort(), expectedParticipants,
        'each publisher must have its own incoming track playing in the widget');
    }
    for (const window of [initial.audioProgress, scrolled.audioDuringScroll, scrolled.audioProgress].filter(Boolean)) {
      for (const field of ['receiving', 'playing', 'continuing', 'advancing', 'withSignal']) {
        assert.equal(window[field], count, `${field}: audio window ${JSON.stringify(window)}`);
      }
    }
  }
  return { count, width, height, fps, sampleMs: steadyMs, budget, hostCpuPct: initial.cpuPct, initial, scrolled };
}
