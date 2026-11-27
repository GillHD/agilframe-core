import { nodeModuleContainerIdSchema, nodeModuleIdSchema, nodeModuleKindSchema, nodeTemplateImageSchema,
  nodeTemplateResourceDefaults, nodeTemplateResourcesSchema, type NodeCustomModuleTemplate } from '@agil/protocol';
import type { AppContext } from '../context.js';
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { button, checkboxField, field, formGrid, selectInput, textInput, textareaInput } from '../ui/controls.js';
import { copyText } from '../ui/copy-button.js';
import { openModal } from '../ui/modal.js';

const templateFileLimit = 16 * 1024;
const utf8 = new TextEncoder();
const healthcheckTimings = [
  { name: 'intervalSec', min: 1, max: 30, initial: 2, label: 'infra.module.healthcheck.interval' },
  { name: 'timeoutSec', min: 1, max: 10, initial: 1, label: 'infra.module.healthcheck.timeout' },
  { name: 'retries', min: 1, max: 5, initial: 3, label: 'infra.module.healthcheck.retries' },
  { name: 'startupTimeoutSec', min: 2, max: 90, initial: 20, label: 'infra.module.healthcheck.startup' },
] as const;

/** Use the same argument bounds as the node agent. JSON preserves spaces and empty arguments. */
function templateArguments(raw: string): string[] | undefined {
  try {
    const command: unknown = JSON.parse(raw);
    if (!Array.isArray(command) || !command.length || command.length > 16) return undefined;
    return command.every((arg) => typeof arg === 'string' && !arg.includes('\0') && utf8.encode(arg).length <= 512)
      ? command : undefined;
  } catch {
    return undefined;
  }
}

function environmentNames(raw: string): string[] | undefined {
  const names = raw.split(/[\s,]+/).filter(Boolean);
  return names.length <= 16 && new Set(names).size === names.length &&
    names.every((name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name)) ? names : undefined;
}

function validVolume(raw: string): boolean {
  return !raw || /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(raw);
}

function previousHealthcheck(raw: string) {
  try {
    const healthcheck = JSON.parse(raw) as Record<string, unknown> | null;
    if (!healthcheck || typeof healthcheck !== 'object' || Array.isArray(healthcheck)) return undefined;
    const command = templateArguments(JSON.stringify(healthcheck.command) ?? '');
    const effective: Record<string, unknown> = { command };
    if (!command?.[0] || Object.keys(healthcheck).some((key) => key !== 'command' &&
      !healthcheckTimings.some(({ name }) => key === name))) return undefined;
    for (const { name, min, max, initial } of healthcheckTimings) {
      const value = Object.hasOwn(healthcheck, name) ? healthcheck[name] : initial;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return undefined;
      effective[name] = value;
    }
    if (Number(effective.startupTimeoutSec) <= Number(effective.intervalSec)) return undefined;
    return { raw: healthcheck, effective };
  } catch {
    return undefined;
  }
}

function privatePortList(raw: string): NonNullable<NodeCustomModuleTemplate['privatePorts']> | undefined {
  const entries = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (!entries.length || entries.length > 8) return undefined;
  const ports: NonNullable<NodeCustomModuleTemplate['privatePorts']> = [];
  const keys = new Set<string>();
  for (const entry of entries) {
    const match = /^(\d{1,5})\/(tcp|udp)$/.exec(entry.toLowerCase());
    const port = Number(match?.[1]);
    const protocol = match?.[2];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (protocol !== 'tcp' && protocol !== 'udp')) return undefined;
    const key = `${port}/${protocol}`;
    if (keys.has(key)) return undefined;
    keys.add(key);
    ports.push({ port, protocol });
  }
  return ports.sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
}

/** Compose a file for review by the operator of this node. The form has no API mutation. */
export function openModuleTemplateDraft(
  ctx: AppContext,
  nodeId: string,
  source: { reservedIds: ReadonlySet<string> } | { template: NodeCustomModuleTemplate },
  onClose: () => void,
): void {
  const template = 'template' in source ? source.template : undefined;
  const originalResources = template?.resources ?? nodeTemplateResourceDefaults;
  const id = textInput({ name: 'module-id', placeholder: 'video-worker', spellcheck: false, autocomplete: 'off', value: template?.id });
  id.readOnly = !!template;
  const image = textInput({ name: 'image', spellcheck: false, autocomplete: 'off', value: template?.image });
  (template ? image : id).setAttribute('data-autofocus', '');
  const volume = textInput({ name: 'storage-volume', placeholder: 'agil-model-data', spellcheck: false, autocomplete: 'off' });
  const envRefsInput = textInput({ name: 'env-refs', placeholder: 'CACHE_AUTH_TOKEN', spellcheck: false, autocomplete: 'off' });
  function patchSelect(name: string) {
    const select = selectInput([
      { value: '', label: t('infra.module.review.keep') },
      { value: 'set', label: t('infra.module.review.set') },
      { value: 'remove', label: t('infra.module.review.remove') },
    ]);
    select.name = name;
    select.addEventListener('change', render);
    return select;
  }
  const volumeAction = patchSelect('storage-action');
  const envAction = patchSelect('env-action');
  const healthAction = patchSelect('healthcheck-action');
  const oldVolume = textInput({ name: 'current-storage-volume', spellcheck: false, autocomplete: 'off' });
  const oldEnv = textInput({ name: 'current-env-refs', spellcheck: false, autocomplete: 'off' });
  const currentHealthcheck = textareaInput({ rows: 3, className: 'mono' });
  currentHealthcheck.name = 'current-healthcheck';
  currentHealthcheck.spellcheck = false;
  const volumeField = field(t('infra.module.draft.volume'), volume, { hint: t('infra.module.draft.volumeHint') });
  const envField = field(t('infra.module.draft.env'), envRefsInput, { hint: t('infra.module.draft.envHint') });
  const oldVolumeField = field(t('infra.module.review.currentStorage'), oldVolume, { hint: t('infra.module.review.currentHint') });
  const oldEnvField = field(t('infra.module.review.currentEnv'), oldEnv, { hint: t('infra.module.review.currentEnvHint') });
  const currentHealthcheckField = field(t('infra.module.review.currentHealthcheck'), currentHealthcheck, {
    hint: t('infra.module.review.currentHealthcheckHint'),
  });
  const cpu = textInput({ name: 'cpu', type: 'number', value: String(originalResources.cpuMillicores), min: 100, max: 8000 });
  const memory = textInput({ name: 'memory', type: 'number', value: String(originalResources.memoryMiB), min: 64, max: 8192 });
  const pids = textInput({ name: 'pids', type: 'number', value: String(originalResources.pidsLimit), min: 16, max: 512 });
  const restartOptions = [
    { value: 'no', label: t('infra.module.draft.restartOff') },
    { value: 'on-failure', label: t('infra.module.draft.restartOnFailure') },
  ];
  const restartPolicy = selectInput(template
    ? [{ value: '', label: t('infra.module.review.restartUnchanged') }, ...restartOptions]
    : restartOptions);
  restartPolicy.name = 'restart-policy';
  const currentRestartPolicy = selectInput([
    { value: '', label: t('infra.module.review.restartSelectCurrent') },
    ...restartOptions,
  ]);
  currentRestartPolicy.name = 'current-restart-policy';
  const currentRestartField = field(t('infra.module.review.restartCurrent'), currentRestartPolicy, {
    hint: t('infra.module.review.restartCurrentHint'),
  });
  let install = false;
  const approval = checkboxField({ label: t('infra.module.draft.install'), onChange: (checked) => {
    install = checked;
    render();
  } });
  approval.querySelector('input')?.setAttribute('name', 'allow-install');
  let healthcheckEnabled = false;
  const healthcheckToggle = checkboxField({ label: t('infra.module.healthcheck.enable'), onChange: (checked) => {
    healthcheckEnabled = checked;
    render();
  } });
  healthcheckToggle.querySelector('input')?.setAttribute('name', 'enable-healthcheck');
  const healthcheckCommand = textareaInput({ rows: 2, placeholder: '["/bin/check-ready"]', className: 'mono' });
  healthcheckCommand.name = 'healthcheck-command';
  healthcheckCommand.spellcheck = false;
  const timingControls = healthcheckTimings.map((timing) => ({
    ...timing,
    input: textInput({ type: 'number', name: timing.name, min: timing.min, max: timing.max,
      step: 1, value: String(timing.initial) }),
  }));
  const healthcheckFields = h('div', { class: 'stack' },
    field(t('infra.module.healthcheck.command'), healthcheckCommand, { hint: t('infra.module.healthcheck.commandHint') }),
    formGrid(...timingControls.map(({ label, input }) => field(t(label), input))),
  );
  let changeCommandArgs = false;
  const commandArgsToggle = checkboxField({
    label: t('infra.module.commandArgs.change'),
    onChange: (checked) => {
      changeCommandArgs = checked;
      render();
    },
  });
  commandArgsToggle.querySelector('input')?.setAttribute('name', 'change-command-args');
  const commandArgsInput = textareaInput({ rows: 2, placeholder: '["--port", "8080"]', className: 'mono' });
  commandArgsInput.name = 'command-args';
  commandArgsInput.spellcheck = false;
  const currentCommandArgsInput = textareaInput({ rows: 2, className: 'mono' });
  currentCommandArgsInput.name = 'current-command-args';
  currentCommandArgsInput.spellcheck = false;
  const commandArgsFields = h('div', { class: 'stack' },
    field(t('infra.module.commandArgs.new'), commandArgsInput, { hint: t('infra.module.commandArgs.newHint') }),
    template ? field(t('infra.module.commandArgs.current'), currentCommandArgsInput,
      { hint: t('infra.module.commandArgs.currentHint') }) : null,
  );
  let privateNetworkEnabled = false;
  const networkToggle = checkboxField({
    label: t(template ? 'infra.module.network.change' : 'infra.module.network.enable'),
    onChange: (checked) => {
      privateNetworkEnabled = checked;
      render();
    },
  });
  networkToggle.querySelector('input')?.setAttribute('name', 'enable-private-network');
  const networkId = textInput({ name: 'network-id', autocomplete: 'off', spellcheck: false });
  const ports = textInput({ name: 'private-ports', placeholder: '8080/tcp, 5353/udp', autocomplete: 'off', spellcheck: false });
  const currentNetwork = selectInput([
    { value: '', label: t('infra.module.network.selectCurrent') },
    { value: 'none', label: t('infra.module.network.absent') },
    { value: 'configured', label: t('infra.module.network.configured') },
  ]);
  currentNetwork.name = 'current-network';
  const currentNetworkId = textInput({ name: 'current-network-id', autocomplete: 'off', spellcheck: false });
  const currentPorts = textInput({ name: 'current-private-ports', autocomplete: 'off', spellcheck: false });
  const currentNetworkFields = h('div', { class: 'stack' },
    field(t('infra.module.network.currentId'), currentNetworkId),
    field(t('infra.module.network.currentPorts'), currentPorts, { hint: t('infra.module.network.portsHint') }),
  );
  const networkFields = h('div', { class: 'stack' },
    field(t('infra.module.network.id'), networkId, { hint: t('infra.module.network.idHint') }),
    field(t('infra.module.network.ports'), ports, { hint: t('infra.module.network.portsHint') }),
    template ? field(t('infra.module.network.current'), currentNetwork, { hint: t('infra.module.network.currentHint') }) : null,
    template ? currentNetworkFields : null,
  );
  const preview = textareaInput({ rows: 7, className: 'mono' });
  preview.name = 'module-template-json';
  preview.readOnly = true;
  preview.spellcheck = false;
  const error = h('p', { class: 'muted small', attrs: { role: 'status' } });
  const copy = button(t('infra.module.draft.copy'), {
    icon: 'copy',
    onClick: async () => {
      if (preview.value) {
        const ok = await copyText(preview.value);
        ctx.toast(t(ok ? 'infra.module.draft.copied' : 'infra.module.draft.copyFailed'), ok ? 'success' : 'error');
      }
    },
  });
  const download = button(t('infra.module.draft.download'), {
    onClick: () => {
      if (!preview.value) return;
      const url = URL.createObjectURL(new Blob([preview.value], { type: 'application/json' }));
      const name = template ? `module-template-${template.id}-changes.json` : `module-template-${id.value.trim()}.json`;
      const anchor = h('a', { attrs: { href: url, download: name } });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
    },
  });

  function render(): void {
    const moduleId = id.value.trim();
    const imageDigest = image.value.trim();
    const patchVolume = volumeAction.value;
    const patchEnv = envAction.value;
    const patchHealth = healthAction.value;
    volumeField.hidden = !!template && patchVolume !== 'set';
    envField.hidden = !!template && patchEnv !== 'set';
    oldVolumeField.hidden = !patchVolume;
    oldEnvField.hidden = !patchEnv;
    currentHealthcheckField.hidden = !patchHealth;
    const storageVolume = volumeField.hidden ? '' : volume.value.trim();
    const oldStorageVolume = patchVolume ? oldVolume.value.trim() : '';
    const envRefs = environmentNames(envField.hidden ? '' : envRefsInput.value.trim());
    const oldEnvRefs = environmentNames(patchEnv ? oldEnv.value.trim() : '');
    const oldHealthRaw = patchHealth ? currentHealthcheck.value.trim() : '';
    const oldHealth = oldHealthRaw ? previousHealthcheck(oldHealthRaw) : undefined;
    const changeRestartPolicy = !!template && restartPolicy.value !== '';
    currentRestartField.hidden = !changeRestartPolicy;
    const setHealthcheck = template ? patchHealth === 'set' : healthcheckEnabled;
    healthcheckFields.hidden = !setHealthcheck;
    commandArgsFields.hidden = !!template && !changeCommandArgs;
    const commandArgsText = template && !changeCommandArgs ? '' : commandArgsInput.value.trim();
    const commandArgs = commandArgsText ? templateArguments(commandArgsText) : undefined;
    const currentCommandArgsText = changeCommandArgs ? currentCommandArgsInput.value.trim() : '';
    const currentCommandArgs = currentCommandArgsText ? templateArguments(currentCommandArgsText) : undefined;
    networkFields.hidden = !privateNetworkEnabled;
    currentNetworkFields.hidden = currentNetwork.value !== 'configured';
    const newNetworkId = privateNetworkEnabled ? nodeModuleContainerIdSchema.safeParse(networkId.value.trim()).data : undefined;
    const newPorts = privateNetworkEnabled ? privatePortList(ports.value) : undefined;
    const verifyCurrentNetwork = privateNetworkEnabled && !!template && currentNetwork.value === 'configured';
    const oldNetworkId = verifyCurrentNetwork ? nodeModuleContainerIdSchema.safeParse(currentNetworkId.value.trim()).data : undefined;
    const oldPorts = verifyCurrentNetwork ? privatePortList(currentPorts.value) : undefined;
    const healthCommand = setHealthcheck ? templateArguments(healthcheckCommand.value) : undefined;
    const healthTimings = Object.fromEntries(timingControls.map(({ name, input, initial }) =>
      [name, input.value === '' && !input.validity.badInput ? initial : input.valueAsNumber])) as
      Record<typeof healthcheckTimings[number]['name'], number>;
    const healthcheck = healthCommand ? { command: healthCommand, ...healthTimings } : undefined;
    const resources = nodeTemplateResourcesSchema.safeParse({
      cpuMillicores: cpu.valueAsNumber,
      memoryMiB: memory.valueAsNumber,
      pidsLimit: pids.valueAsNumber,
    });
    let issue = '';
    if (!nodeModuleIdSchema.safeParse(moduleId).success || nodeModuleKindSchema.safeParse(moduleId).success) {
      issue = t('infra.module.draft.invalidId');
    } else if ('reservedIds' in source && source.reservedIds.has(moduleId)) {
      issue = t('infra.module.draft.duplicateId');
    } else if (!nodeTemplateImageSchema.safeParse(imageDigest).success) {
      issue = t('infra.module.draft.invalidImage');
    } else if (!validVolume(storageVolume) || !validVolume(oldStorageVolume) || (patchVolume === 'set' && !storageVolume)) {
      issue = t('infra.module.draft.invalidVolume');
    } else if (!envRefs || !oldEnvRefs || (patchEnv === 'set' && !envRefs.length)) {
      issue = t('infra.module.draft.invalidEnv');
    } else if (patchVolume && storageVolume === oldStorageVolume) {
      issue = t('infra.module.review.sameStorage');
    } else if (patchEnv && envRefs.length === oldEnvRefs.length && envRefs.every((name) => oldEnvRefs.includes(name))) {
      issue = t('infra.module.review.sameEnv');
    } else if (!resources.success) {
      issue = t('infra.module.draft.invalidLimits');
    } else if (changeRestartPolicy && !currentRestartPolicy.value) {
      issue = t('infra.module.review.restartMissingCurrent');
    } else if (changeRestartPolicy && currentRestartPolicy.value === restartPolicy.value) {
      issue = t('infra.module.review.restartSamePolicy');
    } else if ((changeCommandArgs || commandArgsText) && !commandArgs) {
      issue = t('infra.module.commandArgs.invalid');
    } else if (currentCommandArgsText && !currentCommandArgs) {
      issue = t('infra.module.commandArgs.invalidCurrent');
    } else if (changeCommandArgs && JSON.stringify(commandArgs) === JSON.stringify(currentCommandArgs)) {
      issue = t('infra.module.commandArgs.same');
    } else if (oldHealthRaw && !oldHealth) {
      issue = t('infra.module.review.invalidCurrentHealthcheck');
    } else if (setHealthcheck && !healthCommand?.[0]) {
      issue = t('infra.module.healthcheck.invalidCommand');
    } else if (setHealthcheck && timingControls.some(({ name, min, max }) =>
      !Number.isInteger(healthTimings[name]) || healthTimings[name] < min || healthTimings[name] > max)) {
      issue = t('infra.module.healthcheck.invalidTimings');
    } else if (setHealthcheck && healthTimings.startupTimeoutSec <= healthTimings.intervalSec) {
      issue = t('infra.module.healthcheck.invalidDeadline');
    } else if (patchHealth && JSON.stringify(healthcheck) === JSON.stringify(oldHealth?.effective)) {
      issue = t('infra.module.review.sameHealthcheck');
    } else if (privateNetworkEnabled && !newNetworkId) {
      issue = t('infra.module.network.invalidId');
    } else if (privateNetworkEnabled && !newPorts) {
      issue = t('infra.module.network.invalidPorts');
    } else if ((privateNetworkEnabled && template && !currentNetwork.value) ||
      (verifyCurrentNetwork && (!oldNetworkId || !oldPorts))) {
      issue = t('infra.module.network.missingCurrent');
    } else if (newNetworkId && newNetworkId === oldNetworkId && newPorts && oldPorts &&
      newPorts.length === oldPorts.length && newPorts.every(({ port, protocol }) =>
        oldPorts.some((entry) => entry.port === port && entry.protocol === protocol))) {
      issue = t('infra.module.network.same');
    }
    let output: unknown;
    if (!issue && resources.success) {
      const network = newNetworkId && newPorts ? { networkId: newNetworkId, ports: newPorts } : undefined;
      if (template) {
        const limitsChanged = resources.data.cpuMillicores !== originalResources.cpuMillicores ||
          resources.data.memoryMiB !== originalResources.memoryMiB || resources.data.pidsLimit !== originalResources.pidsLimit;
        const changes = {
          ...(imageDigest !== template.image ? { image: imageDigest } : {}),
          ...(limitsChanged ? { resources: resources.data } : {}),
          ...(changeRestartPolicy ? { restartPolicy: restartPolicy.value } : {}),
          ...(commandArgs ? { commandArgs } : {}),
          ...(patchVolume ? { storageVolume: storageVolume || null } : {}),
          ...(patchEnv ? { envRefs: envRefs?.length ? envRefs : null } : {}),
          ...(patchHealth ? { healthcheck: healthcheck ?? null } : {}),
          ...network,
        };
        if (Object.keys(changes).length) {
          const expected = {
            image: template.image, resources: originalResources,
            ...(changeRestartPolicy ? { restartPolicy: currentRestartPolicy.value } : {}),
            ...(commandArgs ? { commandArgs: currentCommandArgs ?? null } : {}),
            ...(patchVolume ? { storageVolume: oldStorageVolume || null } : {}),
            ...(patchEnv ? { envRefs: oldEnvRefs ?? [] } : {}),
            ...(patchHealth ? { healthcheck: oldHealth?.raw ?? null } : {}),
            ...(network ? { networkId: oldNetworkId ?? null, ports: oldPorts ?? null } : {}),
          };
          output = { nodeId, id: template.id, expected, changes };
        } else issue = t('infra.module.review.noChanges');
      } else {
        output = [{
          id: moduleId, image: imageDigest, install, resources: resources.data, restartPolicy: restartPolicy.value,
          ...(storageVolume ? { storageVolume } : {}),
          ...(envRefs?.length ? { envRefs } : {}),
          ...(commandArgs ? { commandArgs } : {}),
          ...(healthcheck ? { healthcheck } : {}),
          ...network,
        }];
      }
    }
    const json = output ? JSON.stringify(output, null, 2) + '\n' : '';
    if (!template && utf8.encode(json).length > templateFileLimit) issue = t('infra.module.healthcheck.fileLimit');
    error.textContent = issue;
    error.hidden = !issue;
    preview.value = issue ? '' : json;
    copy.disabled = download.disabled = !preview.value;
  }

  for (const control of [id, image, volume, oldVolume, envRefsInput, oldEnv, cpu, memory, pids, healthcheckCommand, currentHealthcheck,
    commandArgsInput, currentCommandArgsInput, networkId, ports, currentNetworkId, currentPorts,
    ...timingControls.map(({ input }) => input)]) control.addEventListener('input', render);
  restartPolicy.addEventListener('change', render);
  currentRestartPolicy.addEventListener('change', render);
  currentNetwork.addEventListener('change', render);
  render();
  openModal({
    title: t(template ? 'infra.module.review.title' : 'infra.module.draft.title'),
    body: h('div', { class: 'stack', dataset: { moduleDraft: nodeId } },
      h('p', { class: 'muted small', text: t(template ? 'infra.module.review.handoff' : 'infra.module.draft.handoff', { node: nodeId }) }),
      template ? h('div', { class: 'stack' },
        h('p', { class: 'cell-sub', text: t(template.blockedReason ? `infra.module.templateBlocked.${template.blockedReason}` :
          template.cached ? 'infra.module.templateCached' : 'infra.module.templateMissing') }),
        template.storage ? h('p', { class: 'cell-sub', text: t('infra.module.templateStorage') }) : null,
      ) : null,
      field(t('infra.module.draft.id'), id, { required: !template }),
      field(t('infra.module.draft.image'), image, { required: true, hint: 'registry.example/worker@sha256:…' }),
      formGrid(field(t('infra.module.draft.cpu'), cpu), field(t('infra.module.draft.memory'), memory), field(t('infra.module.draft.pids'), pids)),
      template ? field(t('infra.module.review.storageAction'), volumeAction) : null,
      template ? oldVolumeField : null,
      volumeField,
      template ? field(t('infra.module.review.envAction'), envAction) : null,
      template ? oldEnvField : null,
      envField,
      field(t(template ? 'infra.module.review.restartTarget' : 'infra.module.draft.restart'), restartPolicy),
      template ? currentRestartField : null,
      template ? field(t('infra.module.review.healthAction'), healthAction) : healthcheckToggle,
      template ? currentHealthcheckField : null,
      healthcheckFields,
      template ? commandArgsToggle : null,
      commandArgsFields,
      networkToggle,
      networkFields,
      template ? null : approval,
      error,
      field(t(template ? 'infra.module.review.preview' : 'infra.module.draft.preview'), preview),
    ),
    footer: [copy, download],
    onClose,
  });
}
