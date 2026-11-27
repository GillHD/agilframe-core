/**
 * Scaling section: media mode (mesh/sfu/broadcast), multi-node signaling,
 * SFU, TURN pool, load balancer, webinar and streaming/CDN (docs/scaling.md).
 * Defaults keep the single-node mesh behaviour; changing fields here does not
 * require any infrastructure yet — it declares the topology.
 */
import { SFU_CAPACITY_PROFILES, effectiveMediaMode, resolveSfuCapacityProfile, scaleConfigSchema, sipConfigSchema, type ScaleConfig } from '@agil/protocol';
import { badge, el, setBadge } from '../dom';
import {
  card,
  fieldShell,
  renderSchema,
  tableField,
  type FieldCtx,
  type Sync,
} from '../fields';
import type { SectionDefinition } from './types';
import { tr } from '../i18n';

const SCALE_LABELS: Record<string, string> = {
  mediaMode: 'Режим связи',
  maxParticipants: 'Макс. участников',
  maxVideoSubscriptions: 'Макс. видеоподписок',
  capacityProfile: 'Профиль ёмкости SFU',
  signaling: 'Сигнальный сервер и кластер',
  nodeId: 'Идентификатор узла',
  redisUrl: 'Адрес Redis (обмен сообщениями)',
  pubsubChannel: 'Канал обмена сообщениями',
  stickySessions: 'Закрепление участника за узлом (sticky-сессии)',
  nodes: 'Узлы сигнального сервера',
  id: 'Идентификатор',
  url: 'Адрес',
  region: 'Регион',
  weight: 'Вес',
  enabled: 'Включено',
  hostOnlyPublish: 'Публикуют только организатор и модератор',
  viewerLimit: 'Лимит зрителей',
  chatMode: 'Режим чата',
  reactions: 'Реакции',
  raiseHandQueue: 'Очередь поднятых рук',
  provider: 'Внешний сервис',
  rtmpUrl: 'Адрес RTMP',
  hlsUrl: 'Адрес HLS',
  latencyMode: 'Задержка',
  sfu: 'SFU (сервер, который пересылает видео участникам)',
  turn: 'TURN-пул (серверы для звонков через сложные сети)',
  loadBalancer: 'Балансировщик нагрузки',
  webinar: 'Вебинар',
  streaming: 'Трансляция',
  cdn: 'CDN (сеть доставки файлов)',
  apiKeyEnv: 'Переменная окружения с ключом',
  apiSecretEnv: 'Переменная окружения с секретом',
  urls: 'Адреса TURN-серверов',
  username: 'Пользователь TURN',
  credentialEnv: 'Переменная окружения с паролем',
  strategy: 'Алгоритм выбора',
  healthPath: 'Путь проверки работоспособности',
  stickyCookie: 'Cookie закрепления',
  baseUrl: 'Базовый адрес',
};

const SCALE_HINTS: Record<string, string> = {
  mediaMode: 'mesh — участники соединяются напрямую, подходит для малых звонков (базовая версия); sfu — видео идёт через один сервер SFU, для больших звонков; broadcast — вебинар или трансляция, зрители только смотрят.',
  maxParticipants: 'От 2 до 50 000 — лимит по умолчанию для новых комнат. В режиме mesh реально работает около 12 участников; в SFU эффективный лимит дополнительно ограничен профилем ёмкости.',
  maxVideoSubscriptions: 'Сколько видео других участников декодировать одновременно (в режиме SFU), от 1 до 1000.',
  capacityProfile: 'Ёмкость SFU: low — 25 участников (1–2 vCPU / 2 GB), standard — 50 (8–16 vCPU / 16 GB), high — 200 (16–32 vCPU / 32 GB). Определяет и бюджет видео, и эффективный лимит комнаты; env AGIL_SFU_PROFILE на сервере важнее этого значения.',
  nodeId: 'Идентификатор этого сигнального узла, уникальный в кластере.',
  redisUrl: 'redis://host:6379 или rediss://… Нужен для нескольких узлов: через Redis расходятся сообщения чата, присутствие и конфигурация. Пусто — один узел.',
  pubsubChannel: 'Канал Redis для обмена сообщениями между узлами (по умолчанию agil:signaling).',
  stickySessions: 'Нужно для mesh при нескольких узлах: участник всегда попадает на свой узел.',
  url: 'Внешний или внутренний адрес https:// узла, SFU или TURN.',
  credentialEnv: 'Только имя переменной окружения с секретом; сам секрет в конфигурацию не попадает.',
  apiKeyEnv: 'Только имя переменной окружения с ключом SFU.',
  apiSecretEnv: 'Только имя переменной окружения с секретом SFU.',
  provider: 'SFU: livekit | mediasoup | external; трансляция: none | rtmp | hls | webrtc; CDN — произвольное имя.',
  enabled: 'Для вебинара и трансляции включайте вместе с режимом broadcast или sfu.',
  hostOnlyPublish: 'Зрители получают видео только от спикеров и не показывают своё.',
  viewerLimit: 'От 2 до 50 000 зрителей вебинара.',
  chatMode: 'moderated — сообщения проходят модерацию и очередь; open — свободный чат.',
  raiseHandQueue: 'Очередь поднятых рук для выступлений зрителей.',
  urls: 'Список адресов через запятую: turn:host:3478, turns:host:5349.',
  username: 'Постоянное имя пользователя TURN (или имя из переменной окружения на сервере).',
  rtmpUrl: 'Адрес rtmp:// площадки (YouTube, VK, корпоративный сервер).',
  hlsUrl: 'Адрес https:// HLS-плейлиста для зрителей, которые только смотрят.',
  latencyMode: 'low — малая задержка (интерактивнее), standard — стабильнее.',
  baseUrl: 'https://cdn.example.com — база HLS/LL-HLS для тысяч зрителей, которые только смотрят.',
  strategy: 'round-robin — по очереди; least-rooms — где меньше комнат; geo — ближе по региону; weighted — с учётом веса.',
  healthPath: 'Путь проверки работоспособности в балансировщике (обычно /v1/health).',
  stickyCookie: 'Cookie, по которой балансировщик удерживает участника на узле (agil_node).',
  nodes: 'Список узлов сигнального сервера и API: идентификатор, адрес https, регион, вес (1–100).',
  hostOnlyPublish2: '',
};

const NODE_LABELS: Record<string, string> = { id: 'Идентификатор', url: 'Адрес узла', region: 'Регион', weight: 'Вес' };
const TURN_LABELS: Record<string, string> = {
  id: 'Идентификатор',
  urls: 'Адреса (через запятую)',
  credentialMode: 'Тип учётных данных TURN',
  nodeId: 'ID узла (необязательно)',
  username: 'Имя пользователя',
  credentialEnv: 'Переменная окружения с паролем',
  region: 'Регион',
  weight: 'Вес',
};

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Same semantic checks as the MCP/API side, for live editor feedback. */
function scalingWarnings(scale: ScaleConfig): string[] {
  const warnings: string[] = [];
  const mode = effectiveMediaMode(scale);
  const profile = resolveSfuCapacityProfile(scale.sfu.capacityProfile);
  const capacity = SFU_CAPACITY_PROFILES[profile].participants;
  if (mode !== 'mesh' && scale.maxParticipants > capacity) {
    warnings.push(
      tr('scale.maxParticipants = {limit}, а профиль {profile} рассчитан на {capacity} участников: комнаты будут ограничены {capacity}. ', {
        limit: scale.maxParticipants, profile, capacity,
      }) + tr('Уменьшите лимит, поднимите профиль (standard/high) или задайте AGIL_SFU_PROFILE на сервере.'),
    );
  }
  if (mode !== 'mesh' && scale.sfu.maxParticipants > capacity) {
    warnings.push(
      tr('scale.sfu.maxParticipants = {limit} больше ёмкости профиля {profile} ({capacity}): эффективный лимит комнаты всё равно {capacity}.', {
        limit: scale.sfu.maxParticipants, profile, capacity,
      }),
    );
  }
  if (scale.mediaMode === 'mesh' && scale.maxParticipants > 12) {
    warnings.push(tr('Режим mesh с {limit} участниками: реально работает около 12 — выберите режим sfu.', { limit: scale.maxParticipants }));
  }
  if (mode !== 'mesh' && !scale.sfu.url.trim()) warnings.push('Укажите адрес SFU здесь или задайте AGIL_SFU_URL на сервере.');
  if (scale.sfu.url && !/^(https?|wss?):\/\//i.test(scale.sfu.url.trim())) warnings.push('Адрес SFU должен начинаться с http://, https://, ws:// или wss://.');
  if (scale.webinar.enabled && scale.mediaMode === 'mesh') {
    warnings.push('Вебинар включён, но выбран режим mesh: режим трансляции не включится — нужен sfu или broadcast.');
  }
  for (const server of scale.turn) {
    if (server.credentialMode !== 'rest' && !server.credentialEnv) warnings.push(tr('TURN {id}: укажите переменную окружения с паролем (credentialEnv).', { id: server.id || tr('(без идентификатора)') }));
    if (server.credentialEnv && !ENV_NAME_RE.test(server.credentialEnv)) {
      warnings.push(tr('TURN {id}: значение credentialEnv «{credential}» не похоже на имя переменной окружения (латинские заглавные буквы, цифры и _).', { id: server.id, credential: server.credentialEnv }));
    }
    for (const url of server.urls) {
      if (!/^(turn|turns|stun):/i.test(url)) warnings.push(tr('TURN {id}: адрес «{url}» должен начинаться с turn:, turns: или stun:.', { id: server.id, url }));
    }
  }
  if (scale.signaling.nodes.length > 1 && !scale.signaling.redisUrl) {
    warnings.push('Узлов несколько, а адрес Redis не задан: обмен между узлами не заработает.');
  }
  if (mode === 'mesh' && scale.signaling.nodes.length > 1 && !scale.signaling.stickySessions) {
    warnings.push('Для mesh с несколькими узлами проверьте закрепление подключений во внешнем прокси.');
  }
  if (scale.signaling.redisUrl && !/^(redis|rediss):\/\//i.test(scale.signaling.redisUrl)) {
    warnings.push('Адрес Redis должен начинаться с redis:// или rediss://.');
  }
  if (scale.streaming.enabled && scale.streaming.provider === 'none') warnings.push('Трансляция включена, но внешний сервис не выбран (provider = none).');
  if (scale.streaming.provider === 'rtmp' && !scale.streaming.rtmpUrl) warnings.push('Выбран RTMP, но адрес rtmpUrl не задан.');
  if (scale.streaming.provider === 'hls' && !scale.streaming.hlsUrl) warnings.push('Выбран HLS, но адрес hlsUrl не задан.');
  if (scale.cdn.enabled && !scale.cdn.baseUrl) warnings.push('CDN включена, но базовый адрес не задан.');
  return warnings;
}

/** Summary: effective media mode + live warnings. */
function summaryCard(ctx: FieldCtx, parent: HTMLElement): Sync {
  const summary = card('Топология и проверка', {
    hint: 'Здесь проверяются параметры черновика. Состояние развёрнутых узлов, Redis и TURN проверяется отдельно.',
  });
  const modeRow = el('div', 'inline-row');
  const modeBadge = badge('mesh', 'muted');
  modeRow.append(el('span', 'field-label', tr('Эффективный режим:')), modeBadge);
  const warningsHost = el('div', 'provider-summary');
  summary.body.append(modeRow, warningsHost);
  parent.append(summary.root);

  const sync: Sync = () => {
    const scale = ctx.config().scale;
    const mode = effectiveMediaMode(scale);
    setBadge(modeBadge, mode, mode === 'mesh' ? 'muted' : mode === 'sfu' ? 'info' : 'ok');
    const warnings = scalingWarnings(scale);
    warningsHost.replaceChildren(
      ...(warnings.length === 0
        ? [el('p', 'a11y-ok', tr('В черновике нет предупреждений о масштабировании.'))]
        : warnings.map((warning) => el('p', 'field-error', `⚠ ${tr(warning)}`))),
    );
  };
  sync();
  return sync;
}

export const scalingSection: SectionDefinition = {
  id: 'scaling',
  title: 'Масштабирование',
  icon: 'layers',
  description:
    'Режим связи (mesh, sfu, broadcast), несколько узлов с Redis, SFU (сервер, который пересылает видео участникам), пул TURN (серверы для звонков через сложные сети), балансировщик, вебинар, трансляция и CDN (сеть доставки файлов).',
  render(ctx, root) {
    const syncs: Sync[] = [];
    syncs.push(summaryCard(ctx, root));

    const mediaCard = card('Передача видео и звука', {
      hint: 'mesh — участники соединяются напрямую (базовая версия); sfu — через сервер SFU; broadcast — вебинар или трансляция, зрители только смотрят.',
    });
    const mediaFields = renderSchema(
      scaleConfigSchema.pick({ mediaMode: true, maxParticipants: true, maxVideoSubscriptions: true }),
      'scale',
      ctx,
      { labels: SCALE_LABELS, hints: SCALE_HINTS },
    );
    mediaCard.body.append(mediaFields.node);
    root.append(mediaCard.root);
    syncs.push(...mediaFields.syncs);

    const signalCard = card('Сигнальный сервер и несколько узлов', {
      hint: 'Redis передаёт сообщения и события присутствия между узлами Core. Если требуется закрепление подключений, настройте его во внешнем прокси.',
    });
    const signalFields = renderSchema(scaleConfigSchema.shape.signaling.omit({ nodes: true }), 'scale.signaling', ctx, {
      labels: SCALE_LABELS,
      hints: SCALE_HINTS,
    });
    signalCard.body.append(signalFields.node);
    syncs.push(...signalFields.syncs);
    syncs.push(
      tableField(
        ctx,
        signalCard.body,
        'scale.signaling.nodes',
        scaleConfigSchema.shape.signaling.shape.nodes.element,
        'Узлы сигнального сервера',
        {
          labels: NODE_LABELS,
          hints: {
            url: 'Адрес узла https:// (сигнальный сервер и API).',
            weight: 'Вес при выборе узла (алгоритмы weighted и least-rooms), от 1 до 100.',
          },
          idPrefix: 'node',
          addLabel: 'Добавить узел',
          emptyText: 'Узлов нет — работает один сервер (базовая версия).',
          defaults: { url: 'https://node.example.com', region: '', weight: 1 },
        },
      ),
    );
    root.append(signalCard.root);

    const sfuCard = card('SFU (LiveKit / mediasoup)', {
      hint: 'Нужен для больших звонков и вебинаров. Секреты хранятся только как имена переменных окружения.',
    });
    const sfuFields = renderSchema(scaleConfigSchema.shape.sfu, 'scale.sfu', ctx, {
      labels: SCALE_LABELS,
      hints: SCALE_HINTS,
    });
    sfuCard.body.append(sfuFields.node);
    root.append(sfuCard.root);
    syncs.push(...sfuFields.syncs);

    const turnCard = card('TURN-пул', {
      hint: 'Клиент получает TURN при входе в звонок. Для временных данных ключ подписи задаётся в окружении Core для организации и ID реле.',
    });
    syncs.push(
      tableField(ctx, turnCard.body, 'scale.turn', scaleConfigSchema.shape.turn.element, 'TURN-серверы', {
        labels: TURN_LABELS,
        hints: {
          urls: 'turn:host:3478?transport=udp, turns:host:5349?transport=tcp (через запятую).',
          credentialEnv: 'Имя переменной с постоянным паролем. Временный режим использует отдельный ключ Core.',
          credentialMode: 'При временном режиме Core создаёт логин и пароль при входе в звонок.',
          nodeId: 'Core выдаёт адрес, пока на этом узле работает модуль TURN.',
          weight: 'Вес для выбора региона (1–100).',
        },
        idPrefix: 'turn',
        addLabel: 'Добавить TURN',
        emptyText: 'TURN-серверов нет — клиенты используют только STUN и могут не соединиться в корпоративной сети.',
        defaults: {
          nodeId: undefined,
          urls: ['turn:turn.example.com:3478'],
          username: 'agil',
          credentialEnv: 'AGIL_TURN_CREDENTIAL',
          region: '',
          weight: 10,
        },
      }),
    );
    root.append(turnCard.root);

    const lbCard = card('Балансировщик нагрузки', {
      hint: 'Примените эти параметры в конфигурации внешнего прокси.',
    });
    const lbFields = renderSchema(scaleConfigSchema.shape.loadBalancer, 'scale.loadBalancer', ctx, {
      labels: SCALE_LABELS,
      hints: SCALE_HINTS,
    });
    lbCard.body.append(lbFields.node);
    root.append(lbCard.root);
    syncs.push(...lbFields.syncs);

    const webinarCard = card('Вебинар и трансляция', {
      hint: 'Выступающие показывают видео, зрители только смотрят; чат модерируется, есть очередь желающих выступить.',
    });
    const webinarFields = renderSchema(scaleConfigSchema.shape.webinar, 'scale.webinar', ctx, {
      labels: SCALE_LABELS,
      hints: SCALE_HINTS,
    });
    webinarCard.body.append(webinarFields.node);
    root.append(webinarCard.root);
    syncs.push(...webinarFields.syncs);

    const streamCard = card('Трансляция и CDN', {
      hint: 'Для вывода в RTMP, HLS и записи разверните LiveKit Egress. Здесь задаются параметры трансляции и адрес CDN.',
    });
    const streamFields = renderSchema(scaleConfigSchema.shape.streaming, 'scale.streaming', ctx, {
      labels: SCALE_LABELS,
      hints: SCALE_HINTS,
    });
    const cdnFields = renderSchema(scaleConfigSchema.shape.cdn, 'scale.cdn', ctx, {
      labels: SCALE_LABELS,
      hints: SCALE_HINTS,
    });
    const cdnGroup = el('div', 'field-group');
    cdnGroup.append(el('div', 'group-title', 'CDN'), cdnFields.node);
    streamCard.body.append(streamFields.node, cdnGroup);
    root.append(streamCard.root);
    syncs.push(...streamFields.syncs, ...cdnFields.syncs);

    const sipCard = card('SIP');
    const sipFields = renderSchema(sipConfigSchema.pick({ nodeId: true }), 'scale.sip', ctx, {
      labels: { nodeId: 'ID узла SIP' },
      hints: { nodeId: 'Укажите узел организации, если новые вызовы из Core зависят от его модуля SIP. Пустое поле отключает проверку узла.' },
    });
    sipCard.body.append(sipFields.node);
    root.append(sipCard.root);
    syncs.push(...sipFields.syncs);

    // Small note with the secret/URL policy (mirrors the CLI/MCP validation).
    const policy = fieldShell('Правила ввода', {
      hint: 'Допустимые протоколы зависят от поля. В полях ключей и паролей указывайте имена переменных окружения.',
    });
    root.append(policy.root);

    return syncs;
  },
};
