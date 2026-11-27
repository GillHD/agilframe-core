#!/usr/bin/env node
/**
 * AgilFrame dev orchestrator: signaling server + demo app + visual editor.
 * Usage: npm run dev
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const root = process.cwd();
const children = new Set();

function run(label, args) {
  const child = spawn(npm, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.add(child);
  child.on('exit', (code) => {
    children.delete(child);
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${label} exited with code ${code}`);
    }
  });
  child.on('error', (err) => {
    console.error(`[dev] failed to start ${label}:`, err.message);
  });
  console.log(`[dev] started ${label}`);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const needProtocolBuild = !existsSync(path.join(root, 'agil', 'core', 'packages', 'protocol', 'dist', 'index.js'));
if (needProtocolBuild) {
  console.log('[dev] building @agil/protocol first...');
  const build = spawn(npm, ['run', 'build:protocol'], { cwd: root, stdio: 'inherit', shell: isWin });
  build.on('exit', (code) => {
    if (code !== 0) {
      console.error('[dev] protocol build failed');
      process.exit(1);
    }
    startAll();
  });
} else {
  startAll();
}

function startAll() {
  run('server', ['run', 'dev', '-w', '@agil/calls-server']);
  run('demo', ['run', 'dev', '-w', '@agil/demo']);
  run('editor', ['run', 'dev', '-w', '@agil/editor']);
  run('dashboard', ['run', 'dev', '-w', '@agil/dashboard']);
  console.log('[dev] demo      : http://localhost:5173');
  console.log('[dev] editor    : http://localhost:5174/editor/');
  console.log('[dev] dashboard : http://localhost:5175/dashboard/');
  console.log('[dev] server    : http://localhost:8787');
}
