/**
 * Per-node module allowlist (Docker add-on packages).
 *
 * Core owns the catalog, including the operator-managed Ingress entry.
 * Preset inventory can use another tag or digest of the allowed repository.
 * The node agent owns local approval of custom images and containers.
 * Install commands carry the preset image or an approved digest from node
 * inventory. Environment values stay on the node.
 */
import { randomBytes } from 'node:crypto';
import {
  NODE_MODULE_COMMAND_MAX_QUEUE,
  NODE_MODULE_COMMAND_TTL_MS,
  isCustomNodeModuleAction,
  isComposeProvisionedNodeModuleImage,
  isOperatorManagedNodeModule,
  customNodeModuleActions,
  nodeModuleActionSchema,
  nodeModuleActions,
  nodeModuleCatalogEntrySchema,
  nodeModuleContainerIdSchema,
  nodeModuleIdSchema,
  nodeModuleImageRepository,
  nodeModuleSchema,
  nodeTemplateImageSchema,
  type NodeModule,
  type NodeModuleAction,
  type NodeModuleCatalogEntry,
  type NodeModuleCommand,
  type NodeModuleKind,
  type NodeModuleReport,
} from '@agil/protocol';

/** Command id format (`nmc_<16 hex>`), mirrored by the protocol schema. */
const COMMAND_ID_RE = /^nmc_[0-9a-f]{16}$/;
const LEGACY_WORKER_REPOSITORIES = { egress: 'agil/node-egress', sip: 'agil/node-sip' } as const;

/** Realistic default images; a deployment may pin a different tag of the same repo. */
const CATALOG: readonly NodeModuleCatalogEntry[] = [
  {
    id: 'egress',
    kind: 'egress',
    name: 'Egress streaming worker',
    description:
      'LiveKit worker for room recording and streaming. Deploy and maintain it with the node Compose configuration.',
    image: 'livekit/egress:v1.15.0',
    repository: 'livekit/egress',
    ports: [],
    env: [
      { name: 'EGRESS_CONFIG_BODY', required: true, secret: true, description: 'Node-local LiveKit, Redis and output storage configuration' },
      { name: 'LIVEKIT_API_KEY', required: true, secret: false, description: 'LiveKit API key configured on the node' },
      { name: 'LIVEKIT_API_SECRET', required: true, secret: true, description: 'LiveKit API secret configured on the node' },
    ],
    actions: nodeModuleActions.filter((action) => action !== 'install'),
  },
  {
    id: 'stt',
    kind: 'stt',
    name: 'Local speech-to-text worker',
    description:
      'Local STT add-on (Whisper-compatible) used by the transcript/captions pipeline when the tenant opts into '
      + 'on-node processing. No audio is uploaded by the agent itself.',
    image: 'agil/node-stt:0.1.0',
    repository: 'agil/node-stt',
    ports: [8090],
    env: [
      { name: 'STT_MODEL_DIR', required: true, secret: false, description: 'Preloaded model directory on the Docker host (read-only mount)' },
      { name: 'AGIL_STT_TOKEN', required: true, secret: true, description: 'Worker API credential (node-local)' },
      { name: 'AGIL_STT_PREVIOUS_TOKEN', required: false, secret: true, description: 'Previous worker API credential accepted during rotation (node-local)' },
      { name: 'STT_LISTEN_IP', required: false, secret: false, description: 'Docker host bind IP (default 127.0.0.1)' },
      { name: 'STT_IMAGE_SOURCE', required: false, secret: false, description: 'pull or local (preloaded catalog image)' },
      { name: 'STT_DOCKER_NETWORK', required: false, secret: false, description: 'Existing private Docker network for Core and STT' },
    ],
    actions: [...nodeModuleActions],
  },
  {
    id: 'recorder',
    kind: 'recorder',
    name: 'Recorder',
    description:
      'This entry manages existing Recorder containers. For new server-side recording deployments, use LiveKit Egress.',
    image: 'agil/node-recorder:0.1.0',
    repository: 'agil/node-recorder',
    ports: [8091],
    env: [
      { name: 'AGIL_RECORDINGS_DIR', required: false, secret: false, description: 'Local output directory (default /data)' },
      { name: 'AGIL_S3_BUCKET', required: false, secret: false, description: 'Optional object-store bucket' },
      { name: 'AGIL_S3_SECRET_KEY', required: false, secret: true, description: 'Object-store secret (node-local)' },
    ],
    actions: nodeModuleActions.filter((action) => action !== 'install'),
  },
  {
    id: 'turn',
    kind: 'turn',
    name: 'TURN/STUN relay',
    description:
      'coturn TURN/STUN relay used when direct/SFU ICE cannot traverse NAT. Ports 3478/udp+tcp and 5349/tls are '
      + 'published by the node; the shared secret never reaches the dashboard.',
    image: 'coturn/coturn:4.6',
    repository: 'coturn/coturn',
    ports: [3478, 5349],
    env: [
      { name: 'TURN_REALM', required: true, secret: false, description: 'TURN realm (e.g. calls.example)' },
      { name: 'TURN_STATIC_AUTH_SECRET', required: true, secret: true, description: 'Shared TURN REST secret (node-local)' },
      { name: 'TURN_EXTERNAL_IP', required: false, secret: false, description: 'Public relay IP when behind NAT' },
    ],
    actions: [...nodeModuleActions],
  },
  {
    id: 'sip',
    kind: 'sip',
    name: 'SIP gateway',
    description:
      'LiveKit gateway for dial-in and dial-out calls. Deploy and maintain it with the node Compose configuration.',
    image: 'livekit/sip:v1.24',
    repository: 'livekit/sip',
    ports: [5060, 5061],
    env: [
      { name: 'AGIL_NODE_SIP_CONFIG_DIR', required: true, secret: false, description: 'Local directory containing sip.yaml, mounted read-only by Compose' },
      { name: 'AGIL_NODE_SIP_CA_FILE', required: false, secret: false, description: 'Trusted CA file path inside the container' },
    ],
    actions: nodeModuleActions.filter((action) => action !== 'install'),
  },
  {
    id: 'ingress',
    kind: 'ingress',
    name: 'LiveKit Ingress',
    description: 'Operator-provisioned Compose worker for inbound streams. Approved containers support start, stop and restart.',
    image: 'livekit/ingress:v1.6.0',
    repository: 'livekit/ingress',
    ports: [],
    env: [],
    actions: [...customNodeModuleActions],
  },
  {
    id: 'sfu',
    kind: 'sfu',
    name: 'LiveKit SFU',
    description: 'Separate LiveKit Compose service. Approved containers can be started, gracefully stopped or restarted during maintenance.',
    image: 'livekit/livekit-server:v1.13.11',
    repository: 'livekit/livekit-server',
    ports: [],
    env: [],
    actions: ['start', 'stop', 'restart'],
  },
];

// Parse once at import time: a malformed catalog is a programming error and must
// fail fast in tests/CI rather than silently serving a partial allowlist.
const catalogEntries: NodeModuleCatalogEntry[] = CATALOG.map((entry) => nodeModuleCatalogEntrySchema.parse(entry));
const catalogById = new Map<string, NodeModuleCatalogEntry>(catalogEntries.map((entry) => [entry.id, entry]));
const catalogOrder = new Map<string, number>(catalogEntries.map((entry, index) => [entry.id, index]));

/** Actions the catalog supports (union); also the set accepted by the API. */
export const NODE_MODULE_CATALOG_ACTIONS: readonly NodeModuleAction[] = [...nodeModuleActions];

/** Defensive copy: callers never get a mutable reference to the allowlist. */
export function nodeModuleCatalog(): NodeModuleCatalogEntry[] {
  return catalogEntries.map((entry) => ({
    ...entry,
    ports: [...entry.ports],
    env: entry.env.map((hint) => ({ ...hint })),
    actions: [...entry.actions],
  }));
}

export function nodeModuleCatalogEntry(moduleId: string): NodeModuleCatalogEntry | undefined {
  return catalogById.get(moduleId);
}

export function isKnownNodeModule(moduleId: string): moduleId is NodeModuleKind {
  return catalogById.has(moduleId);
}

/**
 * True when `image` is a tag/digest variant of the catalog repository for this
 * module. This is the only image check in the system: the dashboard cannot pass
 * an image at all, and a node report with any other repository is dropped.
 */
export function isAllowlistedModuleImage(moduleId: string, image: string): boolean {
  const entry = catalogById.get(moduleId);
  if (!entry) return false;
  const repository = nodeModuleImageRepository(image).toLowerCase();
  if (moduleId === 'egress' || moduleId === 'sip') {
    return repository === LEGACY_WORKER_REPOSITORIES[moduleId] || isComposeProvisionedNodeModuleImage(moduleId, image);
  }
  return (isOperatorManagedNodeModule(moduleId) ? repository.replace(/^docker\.io\//, '') : repository) === entry.repository.toLowerCase();
}

/**
 * Turns a heartbeat report into a stored inventory entry. Known module ids
 * reserve their catalog repository and cannot be used for unrelated images.
 */
export function sanitizeModuleReport(report: NodeModuleReport, receivedAt: number): NodeModule | null {
  const entry = catalogById.get(report.id);
  if (entry && !isAllowlistedModuleImage(entry.id, report.image)) return null;
  return {
    id: report.id,
    kind: entry?.kind ?? report.kind ?? report.id,
    name: report.name ?? entry?.name ?? report.id,
    version: report.version ?? '',
    image: report.image,
    status: report.status,
    health: report.health ?? 'unknown',
    ...(report.autoStart !== undefined && !isComposeProvisionedNodeModuleImage(report.id, report.image)
      ? { autoStart: report.autoStart } : {}),
    ...((!entry || isOperatorManagedNodeModule(report.id)) && report.lifecycleContainerId
      ? { lifecycleContainerId: report.lifecycleContainerId } : {}),
    ...(report.id === 'sfu' && report.status === 'running' && report.lifecycleContainerId && report.sfuDrainState
      ? { sfuDrainState: report.sfuDrainState } : {}),
    ...(!entry && report.lifecycleContainerId && report.templateRemovable ? { templateRemovable: true as const } : {}),
    ports: report.ports ? [...report.ports] : [],
    // Honest timestamp: the agent's own capture time when it sent one, else the
    // Core receipt time. No state is invented.
    updatedAt: report.updatedAt ?? receivedAt,
    ...(report.lastError ? { lastError: report.lastError } : {}),
  };
}

function compareInventoryModules(left: NodeModule, right: NodeModule): number {
  return (catalogOrder.get(left.id) ?? catalogEntries.length) - (catalogOrder.get(right.id) ?? catalogEntries.length)
    || left.id.localeCompare(right.id);
}

/**
 * Sanitizes a full heartbeat inventory snapshot. Duplicate ids keep the last
 * report; the result is sorted in catalog order so the dashboard is stable.
 */
export function sanitizeModuleReports(reports: readonly NodeModuleReport[], receivedAt: number): NodeModule[] {
  const byId = new Map<string, NodeModule>();
  const conflictingIds = new Set<string>();
  for (const report of reports) {
    const module = sanitizeModuleReport(report, receivedAt);
    if (!module) continue;
    const previous = byId.get(module.id);
    if (previous) conflictingIds.add(module.id);
    if (conflictingIds.has(module.id)) {
      delete module.lifecycleContainerId;
      delete module.templateRemovable;
      delete module.sfuDrainState;
    }
    if (!previous || !isComposeProvisionedNodeModuleImage(previous.id, previous.image) ||
      isComposeProvisionedNodeModuleImage(module.id, module.image)) byId.set(module.id, module);
  }
  return [...byId.values()].sort(compareInventoryModules);
}

/**
 * Validates a persisted inventory snapshot when the registry file is re-read.
 * Malformed entries are dropped (the node keeps its other modules); a
 * non-array value means "never reported" (`null`), not an empty inventory.
 */
export function storedModules(value: unknown): NodeModule[] | null {
  if (!Array.isArray(value)) return null;
  const byId = new Map<string, NodeModule>();
  const conflictingIds = new Set<string>();
  for (const item of value) {
    const parsed = nodeModuleSchema.safeParse(item);
    if (!parsed.success) continue;
    const entry = catalogById.get(parsed.data.id);
    if (entry && (parsed.data.kind !== entry.kind || !isAllowlistedModuleImage(entry.id, parsed.data.image))) continue;
    const { lifecycleContainerId, templateRemovable, sfuDrainState, autoStart, ...module } = parsed.data;
    if (byId.has(module.id)) conflictingIds.add(module.id);
    byId.set(module.id, { ...module, ...((!entry || isOperatorManagedNodeModule(module.id)) &&
      lifecycleContainerId && !conflictingIds.has(module.id) ? { lifecycleContainerId } : {}),
      ...(autoStart !== undefined && !isComposeProvisionedNodeModuleImage(module.id, module.image) ? { autoStart } : {}),
      ...(!entry && lifecycleContainerId && templateRemovable && !conflictingIds.has(module.id) ? { templateRemovable } : {}),
      ...(module.id === 'sfu' && module.status === 'running' && lifecycleContainerId && sfuDrainState && !conflictingIds.has(module.id)
        ? { sfuDrainState } : {}),
      ports: [...module.ports] });
  }
  return [...byId.values()].sort(compareInventoryModules);
}

/** A queued command with its internal delivery marker (never exposed). */
export interface StoredModuleCommand {
  id: string;
  moduleId: string;
  action: NodeModuleAction;
  /** Only `install` carries a preset image or a node-approved digest. */
  image?: string;
  targetContainerId?: string;
  createdAt: number;
  expiresAt: number;
  /** Epoch ms when the command was returned by a heartbeat; `null` = pending. */
  deliveredAt: number | null;
}

/**
 * Validates persisted commands, catalog images and local template digest shape. Expired commands
 * are retained here so the registry can report their outcome before pruning.
 */
export function storedModuleCommands(value: unknown, now: number): StoredModuleCommand[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const commands: StoredModuleCommand[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const { id, moduleId, action, image, targetContainerId, createdAt, expiresAt, deliveredAt } = record;
    if (typeof id !== 'string' || !COMMAND_ID_RE.test(id) || seen.has(id)) continue;
    if (typeof moduleId !== 'string') continue;
    if (!nodeModuleIdSchema.safeParse(moduleId).success) continue;
    const entry = catalogById.get(moduleId);
    if (!nodeModuleActionSchema.safeParse(action).success) continue;
    const actionValue = action as NodeModuleAction;
    if (entry) {
      if (isOperatorManagedNodeModule(moduleId)) {
        if (!entry.actions.includes(actionValue) || !nodeModuleContainerIdSchema.safeParse(targetContainerId).success) continue;
      } else if (targetContainerId !== undefined || (deliveredAt === null && !entry.actions.includes(actionValue))) continue;
    } else if (actionValue === 'install' ? targetContainerId !== undefined && !nodeModuleContainerIdSchema.safeParse(targetContainerId).success :
      !isCustomNodeModuleAction(actionValue) || !nodeModuleContainerIdSchema.safeParse(targetContainerId).success) {
      continue;
    }
    if (
      !Number.isInteger(createdAt) ||
      (createdAt as number) < 0 ||
      !Number.isInteger(expiresAt) ||
      (expiresAt as number) <= (createdAt as number)
    ) {
      continue;
    }
    if (deliveredAt !== null && (!Number.isInteger(deliveredAt) || (deliveredAt as number) < 0 || (deliveredAt as number) > now)) {
      continue;
    }
    if (actionValue === 'install') {
      const legacyReceipt = deliveredAt !== null && (moduleId === 'egress' || moduleId === 'sip') &&
        image === `${LEGACY_WORKER_REPOSITORIES[moduleId]}:0.1.0`;
      if (entry ? image !== entry.image && !legacyReceipt : !nodeTemplateImageSchema.safeParse(image).success) continue;
    } else if (image !== undefined) {
      continue;
    }
    seen.add(id);
    commands.push({
      id,
      moduleId,
      action: actionValue,
      ...(actionValue === 'install' && typeof image === 'string' ? { image } : {}),
      ...(typeof targetContainerId === 'string' ? { targetContainerId } : {}),
      createdAt: createdAt as number,
      expiresAt: expiresAt as number,
      deliveredAt: deliveredAt === null ? null : (deliveredAt as number),
    });
  }
  commands.sort((left, right) => left.createdAt - right.createdAt);
  // Keep the newest commands within the per-node cap.
  return commands.slice(-NODE_MODULE_COMMAND_MAX_QUEUE);
}

/** Builds one server-owned command for an allowlisted module/action. */
export function createModuleCommand(input: {
  moduleId: string;
  action: NodeModuleAction;
  now: number;
  targetContainerId?: string;
  templateImage?: string;
}): StoredModuleCommand {
  const entry = catalogById.get(input.moduleId);
  if (entry && isOperatorManagedNodeModule(input.moduleId) &&
    (!input.targetContainerId || !entry.actions.includes(input.action))) {
    throw new Error(`Invalid scoped lifecycle command for ${input.moduleId}`);
  }
  if (!entry && (input.action === 'install' ? !nodeTemplateImageSchema.safeParse(input.templateImage).success :
    !input.targetContainerId || !isCustomNodeModuleAction(input.action))) {
    throw new Error(`Unknown node module: ${input.moduleId}`);
  }
  return {
    id: `nmc_${randomBytes(8).toString('hex')}`,
    moduleId: input.moduleId,
    action: input.action,
    ...(input.action === 'install' ? { image: entry?.image ?? input.templateImage } : {}),
    ...(input.targetContainerId ? { targetContainerId: input.targetContainerId } : {}),
    createdAt: input.now,
    expiresAt: input.now + NODE_MODULE_COMMAND_TTL_MS,
    deliveredAt: null,
  };
}

/** Public command shape (drops the internal `deliveredAt` marker). */
export function publicModuleCommand(command: StoredModuleCommand): NodeModuleCommand {
  return {
    id: command.id,
    moduleId: command.moduleId,
    action: command.action,
    ...(command.image !== undefined ? { image: command.image } : {}),
    ...(command.targetContainerId !== undefined ? { targetContainerId: command.targetContainerId } : {}),
    createdAt: command.createdAt,
    expiresAt: command.expiresAt,
  };
}
