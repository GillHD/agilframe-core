import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const idPattern = /^[\w-]{22}$/;
const dayMs = 24 * 60 * 60 * 1000;

export async function createReplayCatalog(directory) {
  if (!directory) return undefined;
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = (id) => path.join(root, id + '.json');
  async function read(id) {
    if (!idPattern.test(id)) return undefined;
    let text;
    try { text = await readFile(target(id), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    const item = JSON.parse(text);
    if (item.id !== id || item.replayUntil <= Date.now()) return undefined;
    return item;
  }
  async function sweep() {
    for (const file of await readdir(root)) {
      const id = file.slice(0, -5);
      if (!file.endsWith('.json') || !idPattern.test(id)) continue;
      if (!await read(id)) await rm(target(id), { force: true });
    }
  }
  await sweep();
  return {
    read,
    sweep,
    async remember({ id, title, listed, expiresAt }) {
      const item = { id, title, listed, replayUntil: expiresAt + dayMs };
      const temporary = path.join(root, id + '.tmp');
      try {
        await writeFile(temporary, JSON.stringify(item), { mode: 0o600 });
        await rename(temporary, target(id));
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

export async function readSmallJson(request, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return { status: 413 };
    chunks.push(chunk);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { status: 400 };
  }
}
