/**
 * Room egress card for recording, RTMP and HLS.
 */
import type { AppContext } from '../context.js';
import type { ScaleConfig } from '@agil/protocol';
import { ApiError, type EgressKind, type EgressSession, type EgressStatus, type EgressWorkerStatus } from '../api.js';
import { h, setButtonLoading } from '../dom.js';
import { describeError } from '../errors.js';
import { formatDateTime } from '../format.js';
import { t, type MessageKey } from '../i18n.js';
import { readCredential, storeCredential } from '../storage.js';
import { badge } from './badge.js';
import { button, field, selectInput, textInput } from './controls.js';
import { guardedSave } from './guard.js';
import { copyText } from './copy-button.js';
import { alert } from '../screens/common.js';

export interface EgressView {
  el: HTMLElement;
  destroy: () => void;
}

const STATUS_LABELS: Record<string, MessageKey> = {
  EGRESS_STARTING: 'egress.statusStarting',
  EGRESS_ACTIVE: 'egress.statusActive',
  EGRESS_ENDING: 'egress.statusEnding',
  EGRESS_COMPLETE: 'egress.statusComplete',
  EGRESS_FAILED: 'egress.statusFailed',
  EGRESS_ABORTED: 'egress.statusAborted',
  EGRESS_LIMIT_REACHED: 'egress.statusLimit',
  starting: 'egress.statusStarting',
  active: 'egress.statusActive',
  ending: 'egress.statusEnding',
};

const STOPPABLE_STATUSES = new Set(['EGRESS_STARTING', 'EGRESS_ACTIVE', 'starting', 'active']);

function isOngoing(status: string): boolean {
  return STOPPABLE_STATUSES.has(status) || status === 'EGRESS_ENDING' || status === 'ending';
}

function statusLabel(status: string): string {
  return t(STATUS_LABELS[status] ?? 'egress.statusUnknown');
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'EGRESS_ACTIVE' || status === 'active') return 'success';
  if (status === 'EGRESS_FAILED' || status === 'EGRESS_ABORTED') return 'danger';
  if (status === 'EGRESS_LIMIT_REACHED') return 'warning';
  return 'neutral';
}

function maskStreamKey(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/');
    const last = parts.at(-1) ?? '';
    if (last.length > 6) parts[parts.length - 1] = `${last.slice(0, 3)}…${last.slice(-2)}`;
    parsed.pathname = parts.join('/');
    return parsed.toString();
  } catch {
    return url.replace(/\/[^/]{6,}$/, '/***');
  }
}

export function createEgressCard(ctx: AppContext, roomId: string, recordingEnabled: boolean, streaming?: ScaleConfig['streaming']): EgressView {
  const body = h('div', { class: 'stack' });
  const statusHost = h('div', { class: 'actions' });
  const nodeStatusHost = h('div', { attrs: { 'aria-live': 'polite' } });
  const errorHost = h('div', { attrs: { 'aria-live': 'polite' } });
  const startIssueHost = h('div', { class: 'stack', attrs: { 'aria-live': 'polite' } });
  const sessionsHost = h('div', { class: 'stack' });
  let sessions: EgressSession[] = [];
  let workerConfigured = false;
  let workerEnabled = true;
  let workerKnown = false;
  let startNodeAvailable = true;
  let startRestrictions: EgressStatus['startRestrictions'];
  let roomStatusLoaded = false;
  let loading = false;
  let destroyed = false;
  let timer: number | null = null;
  let delay = 10_000;
  let workerHealth: EgressWorkerStatus | null = null;
  let healthRequest = 0;
  const pendingStartKeys = new Map<EgressKind, string>();
  const startIssues = new Map<EgressKind, boolean>();
  const startStorageKey = (kind: EgressKind) => 'agil.egress.start:' + JSON.stringify([ctx.credentials.serverUrl, ctx.tenantId, roomId, kind]);
  const clearStart = (kind: EgressKind): void => {
    pendingStartKeys.delete(kind);
    storeCredential(startStorageKey(kind), '');
    startIssues.delete(kind);
    renderStartIssues();
  };
  const renderStartIssues = (): void => {
    startIssueHost.hidden = startIssues.size === 0;
    startIssueHost.replaceChildren(...[...startIssues].map(([kind, conflict]) => alert('warning',
      `${t('egress.startUnconfirmed')} · ${kind === 'hls' ? 'HLS' : t(kind === 'recording' ? 'egress.kindRecording' : 'egress.kindRtmp')}`,
      t(conflict ? 'egress.startSettingsChanged' : 'egress.startUnconfirmedHint'),
      button(t('egress.separateStart'), { variant: 'subtle', size: 'sm', onClick: () => clearStart(kind) }))));
  };

  const linkTtl = selectInput(
    [
      { value: '900', label: t('egress.ttl15m') },
      { value: '3600', label: t('egress.ttl1h') },
      { value: '86400', label: t('egress.ttl24h') },
    ],
    { value: '900', ariaLabel: t('egress.linkLifetime') },
  );

  /** Mints a signed playback link, copies it, and (for HLS) opens the viewer. */
  const createPlaybackLink = async (session: EgressSession, openViewer: boolean): Promise<void> => {
    if (!session.id) {
      errorHost.replaceChildren(alert('danger', t('egress.missingId')));
      return;
    }
    try {
      const link = await ctx.api.egressPlayback(roomId, session.id, Number(linkTtl.value));
      // Only an HLS link belongs in the playlist field / player; an MP4 link is
      // a download, not something the HLS player can open.
      if (link.kind === 'hls') {
        hlsUrlInput.value = link.url;
        openHls.disabled = false;
      }
      const copied = await copyText(link.url);
      ctx.toast(
        copied ? t('egress.linkCopied', { expires: formatDateTime(link.expiresAt) }) : t('egress.linkCopyFailed'),
        copied ? 'success' : 'warning',
      );
      if (openViewer && link.kind === 'hls') {
        window.open(`/live.html?hls=${encodeURIComponent(link.url)}`, '_blank', 'noopener');
      }
      if (link.kind === 'recording') {
        // Content-Disposition: attachment turns navigation into a download;
        // the transient anchor keeps the dashboard (and its polling) in place.
        const anchor = document.createElement('a');
        anchor.href = link.url;
        anchor.rel = 'noopener';
        anchor.download = '';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        errorHost.replaceChildren(
          alert('info', t('egress.artifactPending'), t('egress.artifactPendingHint')),
        );
        return;
      }
      if (error instanceof ApiError && error.status === 501) {
        errorHost.replaceChildren(alert('warning', t('egress.signedLinksMissing'), t('egress.signedLinksMissingHint')));
        return;
      }
      reportError(error);
    }
  };

  const stopPolling = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    if (destroyed) return;
    stopPolling();
    timer = window.setTimeout(() => void load(), delay);
  };
  const isUnavailable = (error: unknown): boolean => error instanceof ApiError && [404, 405, 501].includes(error.status);

  const updateStartControls = (): void => {
    body.querySelectorAll<HTMLButtonElement>('button[data-egress-start]').forEach((node) => {
      const kind = node.dataset.egressStart as EgressKind;
      const restriction = startRestrictions?.[kind];
      const reason = restriction === 'e2ee_incompatible' ? t('egress.e2eeBlocked')
        : restriction === 'feature_disabled' || (!startRestrictions && kind === 'recording' && !recordingEnabled)
          ? t(kind === 'recording' ? 'egress.recordingDisabled' : 'egress.streamingDisabled')
        : workerKnown && !workerConfigured ? t('egress.controllerMissing')
        : !workerEnabled ? t('egress.controllerDisabled')
        : !startNodeAvailable ? t('egress.nodeUnavailable')
        : !roomStatusLoaded ? t('egress.roomStatusUnavailable')
        : '';
      node.disabled = Boolean(reason) || node.getAttribute('aria-busy') === 'true';
      if (reason) node.title = reason;
      else node.removeAttribute('title');
    });
  };

  const renderSessions = (): void => {
    sessionsHost.replaceChildren();
    if (sessions.length === 0) {
      sessionsHost.appendChild(h('p', { class: 'notice', text: t('egress.empty') }));
      return;
    }
    for (const session of sessions) {
      const kind = session.kind === 'hls' ? 'HLS' : t(session.kind === 'recording' ? 'egress.kindRecording' : 'egress.kindRtmp');
      const actions = h('div', { class: 'actions' });
      if (session.kind !== 'rtmp') {
        actions.appendChild(button(t(session.kind === 'recording' ? 'egress.download' : 'egress.link'), {
          variant: 'subtle', size: 'sm', icon: session.kind === 'recording' ? 'recordings' : 'copy',
          title: t('egress.signedLinkHint'),
          onClick: () => void createPlaybackLink(session, session.kind === 'hls'),
        }));
      }
      if (session.id && STOPPABLE_STATUSES.has(session.status)) {
        const stop = button(t('egress.stop'), { variant: 'danger-ghost', size: 'sm', icon: 'x' });
        stop.addEventListener('click', () => void stopSession(session, stop));
        actions.appendChild(stop);
      }
      sessionsHost.appendChild(
        h(
          'div',
          { class: 'egress-session' },
          h('div', { class: 'cell-stack' }, h('strong', { text: kind }), h('span', { class: 'cell-sub', text: session.url ? maskStreamKey(session.url) : session.id })),
          badge(statusLabel(session.status || 'unknown'), statusTone(session.status), { dot: true }),
          h('span', { class: 'notice', text: session.startedAt ? formatDateTime(session.startedAt) : '' }),
          actions,
        ),
      );
    }
  };

  const renderStatus = (): void => {
    statusHost.replaceChildren();
    if (workerKnown) {
      statusHost.appendChild(badge(t(workerConfigured ? 'egress.controllerConfigured' : 'egress.controllerMissing'),
        workerConfigured ? 'neutral' : 'warning', { dot: true }));
    }
    if (workerKnown && workerConfigured && !workerEnabled) {
      statusHost.appendChild(badge(t('egress.controllerDisabled'), 'danger'));
    }
    const warning = startRestrictions?.recording === 'e2ee_incompatible' ? 'e2ee'
      : workerConfigured && workerEnabled && !startNodeAvailable ? 'node' : '';
    if (nodeStatusHost.dataset.warning !== warning) {
      nodeStatusHost.dataset.warning = warning;
      nodeStatusHost.replaceChildren();
      if (warning === 'e2ee') nodeStatusHost.append(alert('warning', t('egress.e2eeBlocked')));
      if (warning === 'node') nodeStatusHost.append(alert('warning', t('egress.nodeUnavailable'), t('egress.nodeUnavailableHint')));
    }
    const ongoing = sessions.filter((session) => isOngoing(session.status)).length;
    statusHost.appendChild(badge(t('egress.activeCount', { count: ongoing }), ongoing ? 'info' : 'neutral'));
    if (workerHealth?.worker?.urlConfigured) {
      statusHost.appendChild(
        badge(
          t(workerHealth.worker.reachable ? 'egress.workerReachable' : 'egress.workerUnreachable'),
          workerHealth.worker.reachable ? 'success' : 'warning',
          { dot: true, title: workerHealth.worker.detail ?? undefined },
        ),
      );
    }
    const playback = workerHealth?.playback;
    if (playback) {
      const label = !playback.enabled ? 'egress.playbackDisabled'
        : playback.backend === 's3' ? 'egress.playbackS3'
        : playback.backend === 'local' ? 'egress.playbackLocal' : 'egress.playbackMissing';
      statusHost.appendChild(badge(t(label), playback.enabled && playback.backend !== 'none' ? 'neutral' : 'warning'));
    }
  };

  const refreshWorkerHealth = async (): Promise<void> => {
    const request = ++healthRequest;
    // Older deployments may omit this optional endpoint.
    const health = await ctx.api.egressWorkersHealth().catch(() => null);
    if (destroyed || request !== healthRequest) return;
    workerHealth = health;
    renderStatus();
  };

  const load = async (): Promise<void> => {
    if (destroyed || loading) return;
    loading = true;
    // Ask the worker status first: a disabled/unconfigured worker would make
    // `GET /v1/rooms/:id/egress` answer 501, which Chrome reports as a failed
    // request in the console. Skipping the probe keeps the fallback card usable
    // and the console clean (QA round 15 P3-4).
    let workerOk = false;
    try {
      const worker = await ctx.api.egressWorkerStatus();
      workerConfigured = Boolean(worker.configured);
      workerEnabled = worker.enabled !== false;
      startNodeAvailable = worker.startNodeAvailable !== false;
      workerKnown = true;
      workerOk = true;
    } catch {
      workerConfigured = false;
      workerEnabled = true;
      workerKnown = false;
    }
    roomStatusLoaded = false;
    if (workerOk && !workerConfigured) {
      sessions = [];
      errorHost.replaceChildren(
        alert(
          'warning',
          t('egress.controllerMissing'),
          t('egress.controllerMissingHint'),
        ),
      );
    } else {
      try {
        const egress = await ctx.api.egress(roomId);
        sessions = egress.sessions;
        startRestrictions = egress.startRestrictions;
        roomStatusLoaded = true;
        workerConfigured = egress.configured ?? true;
        workerKnown = true;
        if (egress.enabled !== undefined) workerEnabled = egress.enabled;
        errorHost.replaceChildren();
      } catch (error) {
        if (isUnavailable(error)) {
          sessions = [];
          errorHost.replaceChildren(alert('warning', t(workerEnabled ? 'egress.roomStatusUnavailable' : 'egress.controllerDisabled'),
            t(workerEnabled ? 'egress.roomStatusUnavailableHint' : 'egress.controllerDisabledHint')));
        } else {
          errorHost.replaceChildren(alert('warning', t('egress.statusFailedToLoad'), describeError(error).message));
          delay = Math.min(delay * 2, 60_000);
        }
      }
    }
    loading = false;
    if (destroyed) return;
    renderStatus();
    renderSessions();
    updateStartControls();
    schedule();
    void refreshWorkerHealth();
  };

  const reportError = (error: unknown): void => {
    if (error instanceof ApiError && error.code === 'egress_node_unavailable') {
      startNodeAvailable = false;
    } else if (error instanceof ApiError && error.status === 501) {
      const disabled = error.code === 'egress_disabled';
      errorHost.replaceChildren(alert('warning', t(disabled ? 'egress.controllerDisabled' : 'egress.controllerMissing'),
        t(disabled ? 'egress.controllerDisabledHint' : 'egress.controllerMissingHint')));
    } else if (error instanceof ApiError && error.code === 'e2ee_incompatible') {
      startRestrictions = { recording: 'e2ee_incompatible', rtmp: 'e2ee_incompatible', hls: 'e2ee_incompatible' };
    } else {
      const info = describeError(error);
      errorHost.replaceChildren(alert('danger', info.title, [info.message, info.hint].filter(Boolean).join(' ')));
    }
    renderStatus();
  };

  const start = async (kind: EgressKind, rtmpUrl?: string, buttonNode?: HTMLButtonElement): Promise<void> => {
    if (buttonNode) setButtonLoading(buttonNode, true);
    try {
      const perform = async () => {
        const existing = pendingStartKeys.get(kind) ?? readCredential(startStorageKey(kind));
        const key = existing ?? crypto.randomUUID();
        pendingStartKeys.set(kind, key);
        storeCredential(startStorageKey(kind), key);
        try {
          const result = await ctx.api.startEgress(roomId, { kind, ...(rtmpUrl ? { rtmpUrl } : {}) }, key);
          clearStart(kind);
          return result;
        } catch (error) {
          const conflict = error instanceof ApiError && error.code === 'idempotency_conflict';
          const unresolved = !(error instanceof ApiError) || error.status === 0 || error.code === 'invalid_response'
            || error.code === 'egress_start_outcome_unknown'
            || (error.status >= 500 && !['egress_node_unavailable', 'egress_disabled', 'egress_not_configured'].includes(error.code));
          if (conflict || unresolved) {
            startIssues.set(kind, conflict);
            renderStartIssues();
            void load();
          } else if (!existing) {
            clearStart(kind);
          }
          throw error;
        }
      };
      if (kind === 'recording' || kind === 'rtmp') {
        const result = await guardedSave('config', { egress: { kind, rtmpUrl: rtmpUrl ? '***' : undefined } },
          t(kind === 'rtmp' ? 'egress.confirmRtmp' : 'egress.confirmRecording'), perform);
        if (!result.allowed) return;
      } else {
        await perform();
      }
      ctx.toast(t(kind === 'recording' ? 'egress.recordingStarted' : kind === 'rtmp' ? 'egress.rtmpStarted' : 'egress.hlsStarted'), 'success');
      delay = 10_000;
      await load();
    } catch (error) {
      if (!startIssues.has(kind) || (error instanceof ApiError && error.code === 'egress_node_unavailable')) reportError(error);
    } finally {
      if (buttonNode) setButtonLoading(buttonNode, false);
      updateStartControls();
    }
  };

  const stopSession = async (session: EgressSession, control: HTMLButtonElement): Promise<void> => {
    if (!session.id) {
      errorHost.replaceChildren(alert('danger', t('egress.missingId')));
      return;
    }
    setButtonLoading(control, true);
    try {
      await ctx.api.stopEgress(roomId, session.id);
      ctx.toast(t('egress.stopped'), 'success');
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      setButtonLoading(control, false);
    }
  };

  const rtmpInput = textInput({ type: 'password', autocomplete: 'off', placeholder: 'rtmp://live.example/app/stream-key' });
  const reveal = button(t('egress.showKey'), { variant: 'ghost', size: 'sm' });
  reveal.addEventListener('click', () => {
    const hidden = rtmpInput.type === 'password';
    rtmpInput.type = hidden ? 'text' : 'password';
    const label = t(hidden ? 'egress.hideKey' : 'egress.showKey');
    reveal.textContent = label;
    reveal.setAttribute('aria-label', label);
  });
  const recording = button(t('egress.startRecording'), { variant: 'primary', size: 'sm', icon: 'recordings' });
  recording.dataset.egressStart = 'recording';
  recording.addEventListener('click', () => void start('recording', undefined, recording));
  const rtmpStart = button(t('egress.startRtmp'), { variant: 'subtle', size: 'sm', icon: 'activity' });
  rtmpStart.dataset.egressStart = 'rtmp';
  rtmpStart.addEventListener('click', () => {
    const url = rtmpInput.value.trim();
    if (!/^rtmps?:\/\//i.test(url)) {
      errorHost.replaceChildren(alert('danger', t('egress.rtmpMissing'), t('egress.rtmpFormat')));
      return;
    }
    void start('rtmp', url, rtmpStart);
  });
  const hls = button(t('egress.startHls'), { variant: 'subtle', size: 'sm', icon: 'activity' });
  hls.dataset.egressStart = 'hls';
  hls.addEventListener('click', () => void start('hls', undefined, hls));

  const hlsUrlInput = textInput({ type: 'url', placeholder: 'https://cdn.example.com/live/index.m3u8' });
  hlsUrlInput.value = streaming?.hlsUrl ?? '';
  const protectedLink = button(t('egress.protectedLink'), { variant: 'subtle', size: 'sm', icon: 'copy', title: t('egress.protectedLinkHint') });
  protectedLink.addEventListener('click', () => {
    const latest = [...sessions].reverse().find((session) => session.kind === 'hls');
    if (!latest) {
      errorHost.replaceChildren(alert('info', t('egress.noHlsSession'), t('egress.noHlsSessionHint')));
      return;
    }
    void createPlaybackLink(latest, true);
  });
  const preferRealtime = streaming?.playbackProtocol === 'whep';
  const openHls = button(t('egress.openHls'), {
    variant: streaming?.enabled && !preferRealtime ? 'primary' : 'subtle', size: 'sm', icon: 'play',
  });
  openHls.addEventListener('click', () => {
    const url = hlsUrlInput.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      errorHost.replaceChildren(alert('danger', t('egress.hlsMissing'), t('egress.hlsFormat')));
      return;
    }
    window.open(`/live.html?hls=${encodeURIComponent(url)}`, '_blank', 'noopener');
  });
  hlsUrlInput.addEventListener('input', () => {
    openHls.disabled = !/^https?:\/\//i.test(hlsUrlInput.value.trim());
  });
  openHls.disabled = !/^https?:\/\//i.test(hlsUrlInput.value.trim());

  const whepUrl = streaming?.whepUrl ?? '';
  const openRealtime = streaming?.enabled && /^https?:\/\//i.test(whepUrl)
    ? button(t('egress.openWebrtc'), { variant: preferRealtime ? 'primary' : 'subtle', size: 'sm', icon: 'play' })
    : null;
  openRealtime?.addEventListener('click', () => {
    window.open(`/live.html?${new URLSearchParams({ whep: whepUrl })}`, '_blank', 'noopener');
  });
  const playbackActions = preferRealtime && openRealtime
    ? [openRealtime, protectedLink, openHls] : [protectedLink, openHls, openRealtime];

  body.append(
    alert('info', t('egress.service'), t('egress.serviceHint')),
    statusHost,
    nodeStatusHost,
    errorHost,
    startIssueHost,
    h('div', { class: 'actions egress-actions' }, recording, hls),
    h('div', { class: 'egress-rtmp' }, field(t('egress.rtmpInput'), h('div', { class: 'row' }, rtmpInput, reveal)), h('div', { class: 'actions' }, rtmpStart)),
    h('div', { class: 'egress-rtmp' }, field(t('egress.hlsInput'), hlsUrlInput), field(t('egress.linkLifetime'), linkTtl),
      h('div', { class: 'actions' }, ...playbackActions)),
    sessionsHost,
  );
  renderStatus();
  renderSessions();
  renderStartIssues();
  updateStartControls();
  void load();
  return {
    el: h('section', { class: 'card egress-card' },
      h('div', { class: 'card-head' }, h('div', { class: 'card-heading' }, h('h2', { class: 'card-title', text: t('egress.title') }))),
      h('div', { class: 'card-body' }, body)),
    destroy: () => {
      destroyed = true;
      stopPolling();
    },
  };
}
