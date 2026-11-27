/**
 * Optional server-side media processing policy (client-first by default) and
 * the E2EE readiness/conflict report.
 *
 * Reports the tenant policy and configured readiness. Actual media handling
 * can be client-side, forwarded via SFU, or run by separate provisioned workers.
 * E2EE conflicts with processing that needs plaintext media.
 */
import type { TenantConfig } from '@agil/protocol';
import type { Env } from './env.js';
import { sfuConfigured } from './sfu.js';

export interface MediaProcessingStatus {
  policy: TenantConfig['mediaProcessing'];
  /** True only when policy opts in AND at least one processing component is on. */
  serverProcessingActive: boolean;
  /** SFU/broadcast mode means the server forwards media (no client mesh). */
  sfuForwardingOnly: boolean;
  /** Egress is declared in the policy. Worker health is checked separately. */
  egressConfigured: boolean;
  /** server-assisted without any component enabled (warning, not an error). */
  misconfigured: boolean;
  /** Explicit AGIL_E2EE_SECRET is configured (recommended; fallback is dev-only). */
  e2eeConfigured: boolean;
  /** E2EE is enabled and the SFU media session will carry the room key. */
  e2eeActive: boolean;
  /** E2EE conflicts with egress/transcoding/recording/server-side STT. */
  e2eeConflict: boolean;
  note: string;
}

export function mediaProcessingStatus(config: TenantConfig, env?: Env): MediaProcessingStatus {
  const p = config.mediaProcessing;
  const components = [p.video, p.audio, p.egress, p.transcoding].filter(Boolean).length;
  const serverProcessingActive = p.mode === 'server-assisted' && components > 0;
  const mediaMode = config.scale?.mediaMode ?? 'mesh';
  const sfuForwardingOnly = mediaMode !== 'mesh';
  const egressConfigured = Boolean(p.egress && p.provider !== 'none');
  const e2eeConfigured = Boolean(env?.e2eeSecret);
  const e2eeActive = Boolean(
    config.security.e2ee &&
      (mediaMode === 'sfu' || mediaMode === 'broadcast') &&
      env &&
      sfuConfigured(env, config),
  );
  const serverRecording = Boolean(config.session.recording.enabled || config.session.recording.storeOnServer);
  const serverStt = config.providers.stt.mode !== 'builtin';
  const e2eeConflict = Boolean(config.security.e2ee && (p.egress || p.transcoding || serverRecording || serverStt));
  const misconfigured = (p.mode === 'server-assisted' && components === 0) || e2eeConflict;

  const notes: string[] = [];
  if (p.mode === 'server-assisted' && components === 0) {
    notes.push(
      'Выбран server-assisted, но ни один компонент (video/audio/egress/transcoding) не включён — серверная обработка не активируется; рекомендуется client-only.',
    );
  } else if (serverProcessingActive) {
    notes.push(
      'Политика разрешает серверную обработку (video/audio/egress/transcoding). Этот статус отражает настройки организации. Доступность воркеров и выполняемые задания проверяются отдельно.',
    );
  } else if (egressConfigured) {
    notes.push('Egress указан в настройках. Для запуска заданий проверьте доступность настроенного воркера.');
  } else if (sfuForwardingOnly) {
    notes.push('SFU/broadcast: сервер только пересылает медиа; транскодинга, блюра и аудио-миксов на сервере нет.');
  } else {
    notes.push('client-only: вся обработка видео/аудио выполняется на клиентах — рекомендуемый режим по умолчанию.');
  }
  if (e2eeConflict) {
    notes.push(
      'E2EE конфликтует с egress/transcoding/recording/server-side STT: SFU не сможет расшифровать медиа, поэтому серверная обработка/egress не запускаются. Отключите эти компоненты или E2EE.',
    );
  }
  if (e2eeActive && !e2eeConfigured) {
    notes.push(
      'AGIL_E2EE_SECRET не задан — ключ комнаты выводится из join-секрета (fallback только для dev). Задайте отдельный AGIL_E2EE_SECRET в продакшене.',
    );
  }
  if (e2eeActive) {
    notes.push('E2EE включён: участники получают AES-GCM-ключ комнаты в media.e2ee; сервер видит только шифрованный поток.');
  } else if (config.security.e2ee) {
    notes.push('E2EE включён в конфиге, но активен только в режимах sfu/broadcast при настроенном SFU (сейчас media не выдаётся).');
  }

  return {
    policy: p,
    serverProcessingActive,
    sfuForwardingOnly,
    egressConfigured,
    misconfigured,
    e2eeConfigured,
    e2eeActive,
    e2eeConflict,
    note: notes.join(' '),
  };
}
