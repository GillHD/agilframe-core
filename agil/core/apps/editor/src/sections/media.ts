/**
 * Audio/video section: codec multi-select + preferred codec restricted to the
 * selected codecs, plus bitrate/resolution/degradation policy.
 */
import { audioConfigSchema, mediaProcessingSchema, videoCodecPriority, videoConfigSchema, type TenantConfig } from '@agil/protocol';
import { z } from 'zod';
import { el } from '../dom';
import { tr } from '../i18n';
import {
  card,
  fieldShell,
  multiSelectField,
  readBoolean,
  readString,
  readStringArray,
  renderSchema,
  type FieldCtx,
  type Sync,
} from '../fields';
import type { SectionDefinition } from './types';

const MEDIA_PROCESSING_LABELS: Record<string, string> = {
  mode: 'Режим обработки медиа',
  video: 'Серверная обработка видео',
  audio: 'Серверная обработка аудио',
  egress: 'Облачная запись (egress)',
  transcoding: 'Транскодинг',
  provider: 'Провайдер обработки',
  egressNodeId: 'ID узла Egress',
};

const MEDIA_PROCESSING_HINTS: Record<string, string> = {
  mode:
    'client-only — всё обрабатывается в браузере, сервер только пересылает медиа (по умолчанию). server-assisted — видео/аудио обрабатываются на сервере: нужны CPU/GPU и отдельные воркеры, растут задержка и стоимость.',
  video: 'Серверная обработка/миксинг видео: требует ресурсов, влияет на задержку. SFU сам по себе только пересылает потоки, без транскодинга.',
  audio: 'Серверный миксинг/обработка аудио: требует CPU и добавленного латентного буфера.',
  egress: 'Серверную запись выполняет LiveKit Egress рядом с SFU или на отдельном сервере.',
  egressNodeId: 'Укажите узел организации, если запуск зависит от его модуля Egress. Пустое поле отключает проверку узла.',
  transcoding: 'Перекодирование между кодеками/разрешениями — самый дорогой режим; SFU пересылает без транскодинга, включайте только при несовместимых кодеках.',
  provider: 'none — без внешнего провайдера; livekit-egress — egress/запись через LiveKit; external — собственная система (нужны endpoint и ключи в env).',
};

const AUDIO_CODECS = ['opus', 'red', 'pcmu', 'g722'] as const;
const VIDEO_CODECS = ['av1', 'vp9', 'h264', 'vp8'] as const;

const ENCODING_LABELS: Record<string, string> = {
  strategy: 'Стратегия кодирования',
  allowH265: 'Разрешить H.265 (HEVC)',
};

const ENCODING_HINTS: Record<string, string> = {
  strategy:
    'В режиме совместимости первыми идут VP8 и H.264. Реализацию кодека выбирает браузер.',
  allowH265:
    'Флаг хранится для сторонних клиентов. Встроенный виджет исключает H.265 из переговоров.',
};

const CODEC_LABELS: Record<string, string> = {
  av1: 'AV1',
  h264: 'H.264',
  vp9: 'VP9',
  vp8: 'VP8',
  opus: 'Opus',
  red: 'RED',
  pcmu: 'G.711 μ-law',
  g722: 'G.722',
};

type VideoCodec = TenantConfig['video']['codecs'][number];

function setVideoCodecPriority(ctx: FieldCtx, codecs: string[], priorities: string[]): void {
  const video = ctx.config().video;
  const enabled = codecs.filter((codec): codec is VideoCodec => (VIDEO_CODECS as readonly string[]).includes(codec));
  const ordered = videoCodecPriority({
    ...video,
    codecs: enabled,
    encoding: { ...video.encoding, preferredCodecs: priorities.filter((codec): codec is VideoCodec => enabled.includes(codec as VideoCodec)) },
  });
  ctx.set('video', {
    ...video,
    codecs: enabled,
    preferredCodec: ordered[0],
    encoding: { ...video.encoding, preferredCodecs: ordered },
  });
}

const AUDIO_LABELS: Record<string, string> = {
  echoCancellation: 'Эхоподавление',
  noiseSuppression: 'Подавление шума',
  autoGainControl: 'Автоусиление микрофона',
  dtx: 'Экономия трафика в тишине (DTX)',
  ptimeMs: 'Длительность пакета (ptime), мс',
  opusBitrateKbps: 'Скорость звука (Opus), кбит/с',
  stereo: 'Стерео',
  jitterBufferTargetMs: 'Буфер дрожания задержки, мс',
};

const AUDIO_HINTS: Record<string, string> = {
  dtx: 'Во время тишины звук не передаётся — трафик экономится.',
  ptimeMs: 'От 10 до 60 мс; 20 мс — стандарт WebRTC (технология видеозвонков в браузере).',
  opusBitrateKbps: 'От 6 до 128 кбит/с; для речи достаточно 32.',
  jitterBufferTargetMs: '0 — браузер подстраивает буфер сам.',
  stereo: 'Требует два канала у источника.',
};

const VIDEO_LABELS: Record<string, string> = {
  simulcast: 'Несколько слоёв качества (simulcast)',
  scalableVideoCoding: 'Масштабируемое видео (SVC)',
  maxResolution: 'Максимальное разрешение',
  maxFps: 'Максимум кадров в секунду (FPS)',
  maxBitrateKbps: 'Максимальная скорость потока, кбит/с',
  degradationPreference: 'Что важнее при ухудшении связи',
  keyFrameIntervalMs: 'Интервал ключевых кадров, мс',
  contentHint: 'Подсказка о содержимом кадра (content hint)',
};

const VIDEO_HINTS: Record<string, string> = {
  simulcast: 'Три слоя качества: низкий, средний и высокий (sendEncodings low/mid/high).',
  scalableVideoCoding: 'В режиме SFU кодеки VP9 и AV1 передают несколько уровней качества в одном потоке. Остальные кодеки используют настройку simulcast.',
  degradationPreference: 'maintain-framerate — не снижать частоту кадров; maintain-resolution — не снижать чёткость; balanced — компромисс.',
  contentHint: 'motion — движение (видео с камеры); detail — мелкие детали (текст, слайды); text — документы.',
  keyFrameIntervalMs: 'От 500 до 10 000 мс.',
};

/**
 * Chips for the codec list plus a preferred-codec select that only offers the
 * codecs currently enabled. The preferred value is kept valid on user changes.
 */
function codecPair(
  ctx: FieldCtx,
  parent: HTMLElement,
  kind: 'audio' | 'video',
  codecsTitle: string,
  options: readonly string[],
  preferredTitle: string,
): Sync[] {
  const codecsPath = `${kind}.codecs`;
  const preferredPath = `${kind}.preferredCodec`;
  const primary = (codecs: string[]): string[] => codecs.filter((codec) => codec !== 'red');

  const chipsSync = multiSelectField(ctx, parent, codecsPath, codecsTitle, options, {
    minSelected: 1,
    labels: CODEC_LABELS,
    hint: kind === 'audio'
      ? tr('RED помогает при потерях пакетов. Оставьте хотя бы один основной аудиокодек.')
      : tr('Браузер выбирает доступный кодек из этого списка. Порядок можно изменить в разделе «Кодирование».'),
    validate: (values) => primary(values).length > 0 ? undefined : tr('Нужен хотя бы один основной аудиокодек.'),
    onChange: (values) => {
      if (kind === 'video') {
        setVideoCodecPriority(ctx, values, videoCodecPriority(ctx.config().video));
        return;
      }
      const current = readString(ctx, preferredPath);
      const candidates = primary(values);
      const preferredCodec = candidates.includes(current) ? current : candidates[0];
      ctx.set(kind, { ...ctx.config()[kind], codecs: values, preferredCodec });
    },
  });

  const shell = fieldShell(preferredTitle, { hint: tr('Можно выбрать только из включённых основных кодеков.') });
  const select = el('select', 'input input-select');
  select.setAttribute('aria-label', preferredTitle);
  shell.body.append(select);
  parent.append(shell.root);

  select.addEventListener('change', () => {
    if (!select.value) return;
    if (kind === 'audio') ctx.set(preferredPath, select.value);
    else {
      const video = ctx.config().video;
      setVideoCodecPriority(ctx, video.codecs, [select.value, ...videoCodecPriority(video)]);
    }
  });

  const preferredSync: Sync = () => {
    const enabled = readStringArray(ctx, codecsPath).filter((codec) => options.includes(codec));
    const values = primary(enabled);
    const current = kind === 'video' ? videoCodecPriority(ctx.config().video)[0] : readString(ctx, preferredPath);
    const currentOptions = Array.from(select.options, (option) => option.value);
    if (currentOptions.join(',') !== values.join(',')) select.replaceChildren(
      ...values.map((codec) => {
        const option = el('option');
        option.value = codec;
        option.textContent = CODEC_LABELS[codec] ?? codec;
        option.title = codec;
        return option;
      }),
    );
    select.disabled = values.length === 0;
    select.value = current && values.includes(current) ? current : (values[0] ?? '');
  };
  preferredSync();

  return [chipsSync, preferredSync];
}

/** Ordered codec preference list (first = highest priority). */
function orderedCodecsField(ctx: FieldCtx, parent: HTMLElement): Sync {
  const shell = fieldShell(tr('Приоритет видеокодеков'), {
    hint: tr('Сначала браузер пробует кодеки из списка приоритетов, затем остальные включённые. Режим совместимости отдаёт приоритет VP8 и H.264.'),
  });
  const list = el('div', 'codec-order');
  const addRow = el('div', 'codec-add');
  const addSelect = el('select', 'input input-select');
  addSelect.setAttribute('aria-label', tr('Добавить видеокодек'));
  const addButton = el('button', 'btn btn-small', tr('Добавить'));
  addButton.type = 'button';
  addButton.dataset.testid = 'codec-add';
  addRow.append(addSelect, addButton);
  shell.body.append(list, addRow);
  parent.append(shell.root);

  const write = (values: string[]): void => {
    setVideoCodecPriority(ctx, ctx.config().video.codecs, values);
  };

  let renderedOrder = '';
  const sync: Sync = () => {
    const video = ctx.config().video;
    const order = videoCodecPriority(video);
    const signature = `${video.codecs.join(',')}:${order.join(',')}`;
    if (signature === renderedOrder) return;
    renderedOrder = signature;
    const active = list.contains(document.activeElement) ? document.activeElement as HTMLButtonElement : null;
    const activeCodec = active?.closest<HTMLElement>('[data-codec]')?.dataset.codec;
    const activeTitle = active?.getAttribute('aria-label');
    const adding = document.activeElement === addButton;
    list.replaceChildren();
    order.forEach((codec, index) => {
      const row = el('div', 'codec-order-row');
      row.dataset.codec = codec;
      row.append(el('span', 'codec-order-index', String(index + 1)));
      row.append(el('strong', 'codec-order-name', CODEC_LABELS[codec] ?? codec));
      const up = el('button', 'btn btn-small codec-order-btn', '↑');
      up.type = 'button';
      up.title = tr('Выше');
      up.setAttribute('aria-label', tr('Поднять {codec}', { codec: CODEC_LABELS[codec] ?? codec }));
      up.disabled = index === 0;
      up.addEventListener('click', () => {
        const next = [...order];
        [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
        write(next);
      });
      const down = el('button', 'btn btn-small codec-order-btn', '↓');
      down.type = 'button';
      down.title = tr('Ниже');
      down.setAttribute('aria-label', tr('Опустить {codec}', { codec: CODEC_LABELS[codec] ?? codec }));
      down.disabled = index === order.length - 1;
      down.addEventListener('click', () => {
        const next = [...order];
        [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
        write(next);
      });
      const remove = el('button', 'btn btn-small codec-order-btn codec-order-remove', '×');
      remove.type = 'button';
      remove.title = tr('Убрать из приоритета');
      remove.setAttribute('aria-label', tr('Убрать {codec}', { codec: CODEC_LABELS[codec] ?? codec }));
      remove.disabled = order.length <= 1;
      remove.addEventListener('click', () => {
        if (order.length <= 1) return;
        write(order.filter((item) => item !== codec));
      });
      row.append(up, down, remove);
      list.append(row);
    });
    const missing = video.codecs.filter((codec) => !order.includes(codec));
    addSelect.replaceChildren(
      ...missing.map((codec) => {
        const option = el('option');
        option.value = codec;
        option.textContent = CODEC_LABELS[codec] ?? codec;
        return option;
      }),
    );
    addSelect.disabled = missing.length === 0;
    addButton.disabled = missing.length === 0;
    if (active || (adding && addButton.disabled)) {
      const row = [...list.children].find((child) => (child as HTMLElement).dataset.codec === activeCodec);
      const sameRow = [...(row?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const target = sameRow.find((button) => button.getAttribute('aria-label') === activeTitle)
        ?? sameRow[0] ?? (!addButton.disabled ? addButton : list.querySelector<HTMLButtonElement>('button:not(:disabled)'));
      target?.focus({ preventScroll: true });
    }
  };

  addButton.addEventListener('click', () => {
    const codec = addSelect.value;
    if (!codec) return;
    write([...videoCodecPriority(ctx.config().video), codec]);
  });

  sync();
  return sync;
}

export const mediaSection: SectionDefinition = {
  id: 'media',
  title: 'Аудио/видео',
  icon: 'video',
  description: 'Кодеки, слои видео (simulcast и SVC), скорость потока, разрешение, ухудшение качества и подсказки о содержимом кадра (content hint).',
  render(ctx, root) {
    const syncs: Sync[] = [];

    const audioCard = card(tr('Аудио'), {
      hint: tr('В прямом звонке браузер использует выбранные аудиокодеки. В режиме SFU кодеком управляет медиасервер.'),
    });
    syncs.push(
      ...codecPair(ctx, audioCard.body, 'audio', tr('Кодеки'), AUDIO_CODECS, tr('Предпочитаемый аудиокодек')),
    );
    const audioFields = renderSchema(audioConfigSchema, 'audio', ctx, {
      labels: AUDIO_LABELS,
      hints: AUDIO_HINTS,
      skip: ['codecs', 'preferredCodec'],
    });
    audioCard.body.append(audioFields.node);
    syncs.push(...audioFields.syncs);
    root.append(audioCard.root);

    const videoCard = card(tr('Видео'), {
      hint: tr('Слои качества и приоритет при ухудшении применяются при создании соединения (RTCPeerConnection).'),
    });
    syncs.push(
      ...codecPair(ctx, videoCard.body, 'video', tr('Кодеки'), VIDEO_CODECS, tr('Предпочитаемый видеокодек')),
    );
    const videoFields = renderSchema(videoConfigSchema, 'video', ctx, {
      labels: VIDEO_LABELS,
      hints: VIDEO_HINTS,
      skip: ['codecs', 'preferredCodec', 'encoding'],
    });
    videoCard.body.append(videoFields.node);
    syncs.push(...videoFields.syncs);
    root.append(videoCard.root);

    const encodingCard = card(tr('Кодирование'), {
      hint: tr('Настройте порядок видеокодеков. Браузер выбирает доступный кодек и реализацию энкодера.'),
    });
    const encodingFields = renderSchema(
      z.object({
        strategy: z.enum(['auto', 'prefer-hardware', 'software-only']),
        allowH265: z.boolean(),
      }),
      'video.encoding',
      ctx,
      { labels: ENCODING_LABELS, hints: ENCODING_HINTS },
    );
    encodingCard.body.append(encodingFields.node);
    syncs.push(...encodingFields.syncs);
    syncs.push(orderedCodecsField(ctx, encodingCard.body));
    const h265Note = el('div', 'media-note');
    h265Note.dataset.testid = 'h265-warning';
    h265Note.setAttribute('role', 'status');
    const updateH265Note = (): void => {
      if (!readBoolean(ctx, 'video.encoding.allowH265')) {
        h265Note.hidden = true;
        h265Note.textContent = '';
        return;
      }
      h265Note.hidden = false;
      h265Note.dataset.tone = 'danger';
      h265Note.replaceChildren(
        el('strong', 'media-note-title', tr('Встроенный виджет исключает H.265')),
        el(
          'p',
          'media-note-item',
          tr('Встроенный виджет использует AV1, H.264, VP9 или VP8. Проверьте H.265 отдельно в своём клиенте.'),
        ),
      );
    };
    updateH265Note();
    encodingCard.body.append(h265Note);
    syncs.push(updateH265Note);
    root.append(encodingCard.root);

    const processingCard = card(tr('Обработка медиа'), {
      hint: tr('Где обрабатываются видео и аудио. По умолчанию client-only: медиа обрабатывается в браузере, сервер (SFU/mesh) только пересылает потоки. server-assisted включает серверные шаги и требует ресурсов.'),
    });
    const processingFields = renderSchema(mediaProcessingSchema, 'mediaProcessing', ctx, {
      labels: MEDIA_PROCESSING_LABELS,
      hints: MEDIA_PROCESSING_HINTS,
    });
    const processingNote = el('div', 'media-note');
    processingNote.dataset.testid = 'media-processing-note';
    processingNote.setAttribute('role', 'status');
    processingNote.setAttribute('aria-live', 'polite');
    const updateProcessingNote = (): void => {
      const mp = ctx.config().mediaProcessing;
      const items: string[] = [];
      const serverSteps = mp.video || mp.audio || mp.egress || mp.transcoding;
      let tone: 'info' | 'warning' | 'danger' = 'info';
      if (mp.mode === 'client-only' && serverSteps) {
        tone = 'danger';
        items.push(tr('Включены серверные шаги, но режим client-only: переключите режим на server-assisted, иначе настройки не применятся.'));
      }
      if (mp.mode === 'server-assisted') {
        tone = tone === 'danger' ? tone : 'warning';
        items.push(tr('server-assisted требует CPU/GPU и отдельных воркеров: вырастут задержка и стоимость; проверьте capacity и лимиты (docs/scaling.md).'));
      }
      if (mp.video) items.push(tr('Серверная обработка видео требует ресурсов и увеличивает задержку; SFU без транскодинга только пересылает медиа.'));
      if (mp.audio) items.push(tr('Серверная обработка аудио требует CPU и добавляет буфер задержки.'));
      if (mp.egress) {
        items.push(tr('Для воспроизведения серверной записи настройте хранилище Egress и доступ на чтение в Core.'));
        if (mp.provider === 'none') {
          tone = 'danger';
          items.push(tr('При provider=none egress не заработает: выберите livekit-egress или external и задайте ключи в env.'));
        }
      }
      if (mp.transcoding) {
        tone = tone === 'danger' ? tone : 'warning';
        items.push(tr('Транскодинг — самый дорогой режим: SFU пересылает без транскодинга; включайте только при несовместимых кодеках.'));
      }
      if (mp.provider !== 'none' && !mp.egress && !mp.transcoding) {
        items.push(tr('Провайдер выбран, но egress и транскодинг выключены — внешний обработчик не будет использоваться.'));
      }
      if (items.length === 0) {
        tone = 'info';
        items.push(tr('Клиентская обработка (client-only): видео/аудио обрабатываются в браузере, сервер пересылает потоки (SFU/mesh) без транскодинга — рекомендуемый режим.'));
      }
      processingNote.dataset.tone = tone;
      processingNote.replaceChildren(
        el('strong', 'media-note-title', tone === 'info' ? tr('Клиентская обработка') : tr('Внимание: серверная обработка медиа')),
        ...items.map((item) => el('p', 'media-note-item', item)),
      );
    };
    processingCard.body.append(processingFields.node, processingNote);
    updateProcessingNote();
    syncs.push(...processingFields.syncs, updateProcessingNote);
    root.append(processingCard.root);

    return syncs;
  },
};
