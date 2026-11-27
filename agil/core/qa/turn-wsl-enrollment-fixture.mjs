import { execFile, spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function startWslTurnNode({ core, token, key, nodeId, endpoint }) {
  const bind = process.env.AGIL_QA_WSL_CORE_BIND;
  if (!bind) throw new Error('Set AGIL_QA_WSL_CORE_BIND to the Windows WSL interface address');
  const distro = process.env.AGIL_QA_WSL_DISTRO || 'Ubuntu-22.04';
  const wslArgs = ['-d', distro, '-u', 'root', '--exec'];
  const wsl = async (...args) => (await execute('wsl.exe', [...wslArgs, ...args], { timeout: 60000 })).stdout.trim();
  const agentSource = fileURLToPath(new URL('../nodes/all-in-one/agent', import.meta.url));
  const agentMount = await wsl('wslpath', '-a', agentSource.replaceAll('\\', '/'));
  const image = process.env.AGIL_QA_WSL_AGENT_IMAGE || 'agil-node-all-in-one:qa-turn-tls';
  const nodeName = `agil-${nodeId}`;
  const moduleName = `${nodeName}-managed-turn`;
  const allowed = new Set(['/v1/nodes/register', `/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`]);
  // Keep the test Core on loopback. Only the fixture's two node routes cross the WSL interface.
  const bridge = createServer((incoming, response) => {
    if (incoming.method !== 'POST' || !allowed.has(incoming.url) || incoming.socket.remoteAddress !== endpoint.ip) {
      response.writeHead(404).end();
      return;
    }
    const upstream = request(new URL(incoming.url, core.base), { method: 'POST', headers: incoming.headers }, (reply) => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    });
    upstream.on('error', () => response.writeHead(502).end());
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => bridge.once('error', reject).listen(0, bind, resolve));
  const close = async () => {
    await execute('wsl.exe', [...wslArgs, 'docker', 'stop', '-t', '5', nodeName], { timeout: 25000 }).catch(() => {});
    await execute('wsl.exe', [...wslArgs, 'docker', 'rm', '-f', nodeName, moduleName], { timeout: 25000 }).catch(() => {});
    bridge.closeAllConnections();
    await new Promise((resolve) => bridge.close(resolve));
  };
  try {
    await wsl('docker', 'create', '--pull', 'never', '--name', moduleName,
      '--label', 'agil.module=turn', '--label', `agil.node=${nodeId}`, 'coturn/coturn:4.6',
      '--stun-only', '--no-tls', '--no-dtls', '--no-cli', '--log-file=stdout');
    const socketGroup = await wsl('stat', '-c', '%g', '/var/run/docker.sock');
    const auth = {
      AGIL_CORE_URL: `http://${bind}:${bridge.address().port}`, AGIL_NODE_TOKEN: token,
      NODE_ID: nodeId, NODE_FEATURES: 'turn', NODE_MODULES: 'on', NODE_HTTP_HOST: '127.0.0.1',
      NODE_HTTP_PORT: String(endpoint.port + 1), NODE_HEARTBEAT_SEC: '5',
      TURN_AUTO_REGISTER: '1', TURN_ALLOW_PRIVATE_IP: '1', TURN_EXTERNAL_IP: endpoint.ip,
      TURN_LISTEN_IP: endpoint.ip, TURN_PORT: String(endpoint.port), TURN_STATIC_AUTH_SECRET: key,
      TURN_MIN_PORT: String(endpoint.port + 10), TURN_MAX_PORT: String(endpoint.port + 41),
    };
    await new Promise((resolve, reject) => {
      const child = spawn('wsl.exe', [...wslArgs, 'docker', 'run', '-d', '--pull', 'never', '--name', nodeName,
        '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--group-add', socketGroup,
        '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:mode=1777',
        '--tmpfs', '/run/agil:uid=1000,gid=1000,mode=0700', '--tmpfs', '/var/lib/agil-node:uid=1000,gid=1000,mode=0700',
        '--mount', `type=bind,src=${agentMount},dst=/opt/agil-node/agent,readonly`,
        '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
        '--env-file', '/dev/stdin', image], { windowsHide: true, stdio: ['pipe', 'ignore', 'inherit'] });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Docker could not start the TURN node (${code})`)));
      child.stdin.on('error', reject);
      child.stdin.end(Object.entries(auth).map(([k, value]) => `${k}=${value}\n`).join(''));
    });
    return { close, moduleStatus: () => wsl('docker', 'inspect', '--format', '{{.State.Status}}', moduleName) };
  } catch (error) {
    await close();
    throw error;
  }
}
