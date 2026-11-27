/** Execute the node-agent module path against a disposable TURN container in WSL. */
import assert from 'node:assert/strict';
import { createModuleManager } from '../../infra/node-agent/modules.mjs';

const containerName = 'agil-qa-turn-autostart-35459';
const nodeId = 'qa-turn-renewal';
const [encoded] = process.argv.slice(2);
const command = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
const manager = createModuleManager({ nodeId, dockerHost: 'unix:///var/run/docker.sock' });
await manager.init();

async function inspect() {
  const container = await manager.docker.inspectContainer(containerName);
  assert.equal(container.Name, `/${containerName}`);
  assert.equal(container.Config.Labels['agil.node'], nodeId);
  assert.equal(container.Config.Labels['agil.module'], 'turn');
  assert.equal(container.Config.Labels['agil.qa.fixture'], 'turn-autostart');
  assert.equal(container.State.Running, true);
  return { id: container.Id, pid: container.State.Pid, startedAt: container.State.StartedAt };
}

const before = await inspect();
const inventory = await manager.inventory();
assert.equal(inventory.length, 1, 'the disposable container must be the only module for this test node');
assert.equal(inventory[0].id, 'turn');
let result;
if (command) {
  assert.equal(command.moduleId, 'turn');
  assert.ok(['enable-autostart', 'disable-autostart'].includes(command.action));
  result = await manager.executeCommand(command);
  assert.equal(result.ok, true, result.error);
}
const after = await inspect();
assert.deepEqual(after, before);
const modules = await manager.inventory();
console.log(JSON.stringify({ container: after, modules, result }));
