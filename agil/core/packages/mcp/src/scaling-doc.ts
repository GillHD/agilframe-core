/**
 * Scale-out / multi-node / TURN / SFU / webinar documentation and validation
 * (contract `agil/core/packages/protocol/src/scaling.ts`, guide `agil/core/docs/scaling.md`).
 */
import type { ScaleConfig } from '@agil/protocol';

export const MEDIA_MODES = ['mesh', 'sfu', 'broadcast'] as const;

/** Semantic warnings for a scale config (used by agil_set_scale and the editor). */
export function scaleWarnings(scale: ScaleConfig): string[] {
  const warnings: string[] = [];
  if (scale.mediaMode === 'mesh' && scale.maxParticipants > 12) {
    warnings.push(
      `scale.mediaMode="mesh" with maxParticipants=${scale.maxParticipants}: mesh WebRTC degrades above ~12 participants; use "sfu" for larger rooms.`,
    );
  }
  if (scale.mediaMode === 'sfu' && !scale.sfu.url) {
    warnings.push('scale.mediaMode="sfu" requires scale.sfu.url; without it the server cannot join the SFU.');
  }
  if (scale.sfu.url && !/^https?:\/\//i.test(scale.sfu.url)) {
    warnings.push('scale.sfu.url should be an http(s) URL of the SFU API.');
  }
  if (scale.mediaMode === 'sfu' && scale.maxParticipants > scale.sfu.maxParticipants) {
    warnings.push(
      `scale.maxParticipants (${scale.maxParticipants}) exceeds scale.sfu.maxParticipants (${scale.sfu.maxParticipants}): rooms above the SFU capacity must be rejected or sharded.`,
    );
  }
  for (const server of scale.turn) {
    if (!server.credentialEnv) {
      warnings.push(`scale.turn["${server.id}"] has no credentialEnv: TURN credentials must come from an env variable.`);
    }
    for (const url of server.urls) {
      if (!/^(turn|turns|stun):/i.test(url)) {
        warnings.push(`scale.turn["${server.id}"] url "${url}" should start with turn:/turns:/stun:.`);
      }
    }
  }
  if (scale.webinar.enabled && scale.mediaMode === 'mesh') {
    warnings.push('scale.webinar.enabled with mediaMode="mesh": broadcast mode is not effective; use "sfu" or "broadcast".');
  }
  if (scale.webinar.enabled && scale.mediaMode !== 'broadcast') {
    warnings.push('scale.webinar.enabled but mediaMode is not "broadcast": viewers may publish media unless hostOnlyPublish is enforced.');
  }
  if (scale.signaling.nodes.length > 1 && !scale.signaling.redisUrl) {
    warnings.push(
      'scale.signaling.nodes has several nodes but scale.signaling.redisUrl is empty: multi-node signaling needs Redis-compatible pub/sub.',
    );
  }
  if (scale.signaling.nodes.length > 0 && !scale.signaling.stickySessions) {
    warnings.push('Multi-node mesh signaling requires sticky sessions (scale.signaling.stickySessions=true).');
  }
  if (scale.signaling.redisUrl && !/^(redis|rediss):\/\//i.test(scale.signaling.redisUrl)) {
    warnings.push('scale.signaling.redisUrl should start with redis:// or rediss://.');
  }
  if (scale.streaming.enabled && scale.streaming.provider === 'none') {
    warnings.push('scale.streaming.enabled but provider="none": choose rtmp|hls|webrtc.');
  }
  if (scale.streaming.provider === 'rtmp' && !scale.streaming.rtmpUrl) {
    warnings.push('streaming.provider="rtmp" requires streaming.rtmpUrl (YouTube/VK/corporate platform).');
  }
  if (scale.streaming.provider === 'hls' && !scale.streaming.hlsUrl) {
    warnings.push('streaming.provider="hls" requires streaming.hlsUrl.');
  }
  if (scale.cdn.enabled && !scale.cdn.baseUrl) {
    warnings.push('scale.cdn.enabled requires cdn.baseUrl.');
  }
  if (scale.loadBalancer.strategy !== 'round-robin' && scale.signaling.nodes.length === 0) {
    warnings.push(
      `scale.loadBalancer.strategy="${scale.loadBalancer.strategy}" with no signaling.nodes: the LB has nothing to route to.`,
    );
  }
  return warnings;
}

function modeRow(): string[] {
  return [
    '| Mode | How media flows | When to use |',
    '|---|---|---|',
    '| `mesh` | P2P between participants (MVP default) | 1:1 and small groups (≤ ~12); no extra infrastructure |',
    '| `sfu` | one SFU hop (LiveKit/mediasoup) | larger meetings, camera-heavy calls, weak client uplinks |',
    '| `broadcast` | speakers publish, viewers receive-only (webinar/streaming) | webinars, town halls, streams to thousands |',
  ];
}

/** Offline markdown guide for scaling (docs/scaling.md §4–§9). */
export function explainScalingMarkdown(): string {
  return [
    '# Scaling AgilFrame: mesh → SFU → broadcast',
    '',
    '`TenantConfig.scale` declares the media/cluster topology. Defaults are `mediaMode:"mesh"`, single node, ' +
      'no TURN/SFU — exactly the MVP behaviour. Full guide: `agil/core/docs/scaling.md` (§4–§9); admin API: ' +
      '`GET/PUT /v1/admin/scale`, `GET /v1/admin/cluster/status`.',
    '',
    '## Media plane modes',
    '',
    ...modeRow(),
    '',
    '`effectiveMediaMode(scale)` picks broadcast for webinars (non-mesh mode) and keeps 1:1 direct calls on mesh ' +
      'unless SFU is configured.',
    '',
    '## When you need what',
    '',
    '| Component | Need it when | Config |',
    '|---|---|---|',
    '| Redis pub/sub | more than one signaling node (rooms live in node memory; chat/presence/config must fan out) | `scale.signaling.redisUrl`, `pubsubChannel`, `stickySessions:true`, `nodes[]` |',
    '| Load balancer | multi-node: sticky routing by room/cookie, health checks | `scale.loadBalancer` (strategy round-robin/least-rooms/geo/weighted, healthPath, stickyCookie) |',
    '| SFU (LiveKit/mediasoup) | > ~12 participants or webinar speakers | `scale.mediaMode:"sfu"`, `scale.sfu{provider,url,apiKeyEnv,apiSecretEnv,region,maxParticipants,capacityProfile}` (profile low/standard/high sizes the gallery video budget; env `AGIL_SFU_PROFILE` wins) |',
    '| TURN pool | corporate networks / symmetric NAT, any real deployment | `scale.turn[]` (`urls`, `username`, `credentialEnv`, `region`, `weight`) → advertised in `welcome.iceServers` |',
    '| Webinar/broadcast | receive-only viewers, moderated chat, hand-raise queue | `scale.webinar{enabled,hostOnlyPublish,viewerLimit,chatMode,reactions,raiseHandQueue}` + `mediaMode:"broadcast"` |',
    '| Streaming egress | RTMP to YouTube/VK, HLS playlist | `scale.streaming{enabled,provider:rtmp|hls|webrtc,rtmpUrl,hlsUrl,latencyMode}` |',
    '| CDN | thousands of passive viewers (HLS/LL-HLS) | `scale.cdn{enabled,baseUrl,provider}` |',
    '',
    '## Recipes',
    '',
    '**Webinar for 5000 viewers**',
    '```json',
    '{ "scale": { "mediaMode": "broadcast", "maxParticipants": 5000, "maxVideoSubscriptions": 12,',
    '  "sfu": { "provider": "livekit", "url": "https://sfu.example.com", "apiKeyEnv": "AGIL_SFU_API_KEY", "apiSecretEnv": "AGIL_SFU_API_SECRET", "maxParticipants": 5000 },',
    '  "webinar": { "enabled": true, "hostOnlyPublish": true, "viewerLimit": 5000, "chatMode": "moderated", "reactions": true, "raiseHandQueue": true },',
    '  "streaming": { "enabled": true, "provider": "rtmp", "rtmpUrl": "rtmp://a.rtmp.youtube.com/live2/KEY", "latencyMode": "low" } } }',
    '```',
    'Viewers join as `guest` (receive-only); hosts/moderators publish. For >2k passive viewers add `cdn`.',
    '',
    '**Add a TURN pool**',
    '```json',
    '{ "scale": { "turn": [',
    '  { "id": "eu-1", "urls": ["turn:turn-eu.example.com:3478?transport=udp"], "username": "agil", "credentialEnv": "AGIL_TURN_EU_CREDENTIAL", "region": "eu", "weight": 10 },',
    '  { "id": "us-1", "urls": ["turns:turn-us.example.com:5349?transport=tcp"], "username": "agil", "credentialEnv": "AGIL_TURN_US_CREDENTIAL", "region": "us", "weight": 10 }',
    '] } }',
    '```',
    'Secrets stay in env variables (`credentialEnv` is only a name); the pool is advertised to clients automatically.',
    '',
    '## MVP status (be honest with planners)',
    '',
    '- The **contract and admin API are implemented**: schema/defaults, limits up to 50 000, `RoomInfo.mediaMode`, ' +
      'TURN pool → `welcome.iceServers` substitution, admin DTOs/endpoints, editor/MCP/докs.',
    '- **Not implemented yet** (needs infrastructure + a separate stage): Redis pub/sub multi-node fan-out, room ownership/leases, ' +
      'real SFU orchestration (token issue, fan-out), server-side egress/recording at scale, CDN integration, TURN REST credentials, capacity autoscaling.',
    '',
    '## Tools',
    '',
    '- `agil_get_scale` — current scale config + cluster/TURN/SFU/webinar summary and limitations.',
    '- `agil_set_scale` — merge/validate/diff + warnings (`dryRun` first!), then `PUT /v1/admin/scale`.',
    '- `agil_get_cluster_status` — node list, strategy, Redis/sticky flags, `multiNodeActive`.',
    '- `agil_explain_scaling` — this guide (offline).',
  ].join('\n');
}
