/** AV engines: clamd INSTREAM framing, EICAR detection, YARA CLI and composite scans. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClamAvScanner,
  CompositeAvScanner,
  EICAR_TEST_STRING,
  YaraScanner,
  frameClamAvInstream,
  parseClamAvResponse,
  type AvScanner,
} from '../src/av.js';

const EICAR = Buffer.from(EICAR_TEST_STRING, 'utf8');

/** Minimal clamd `INSTREAM` server: replies FOUND when the payload matches. */
interface FakeClamd {
  port: number;
  server: Server;
  connections(): number;
}

function startFakeClamd(options: { infectOn?: string; delayMs?: number; reply?: string } = {}): Promise<FakeClamd> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    let buffer = Buffer.alloc(0);
    let payload = Buffer.alloc(0);
    let commandSeen = false;
    socket.on('error', () => {
      /* client aborted (timeout tests) */
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!commandSeen) {
        const marker = buffer.indexOf('zINSTREAM\0', 0, 'ascii');
        if (marker < 0) return;
        buffer = buffer.subarray(marker + 'zINSTREAM\0'.length);
        commandSeen = true;
      }
      for (;;) {
        if (buffer.length < 4) return;
        const size = buffer.readUInt32BE(0);
        if (buffer.length < 4 + size) return;
        if (size === 0) {
          buffer = buffer.subarray(4);
          const infected = options.infectOn ? payload.toString('utf8').includes(options.infectOn) : false;
          const reply = options.reply ?? (infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          const send = (): void => {
            if (!socket.destroyed) socket.end(reply, 'utf8');
          };
          if (options.delayMs) setTimeout(send, options.delayMs);
          else send();
          return;
        }
        payload = Buffer.concat([payload, buffer.subarray(4, 4 + size)]);
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ port, server, connections: () => connections });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('frameClamAvInstream: command, length-prefixed chunks and zero terminator', () => {
  const payload = Buffer.from('hello-clamd');
  const frame = frameClamAvInstream(payload);
  assert.equal(frame.subarray(0, 10).toString('latin1'), 'zINSTREAM\0');
  const size = frame.readUInt32BE(10);
  assert.equal(size, payload.length);
  assert.equal(frame.subarray(14, 14 + size).toString('utf8'), 'hello-clamd');
  assert.equal(frame.readUInt32BE(14 + size), 0);
  assert.equal(frame.length, 10 + 4 + payload.length + 4);
});

test('frameClamAvInstream: large payloads split into 64 KiB frames', () => {
  const payload = Buffer.alloc(70_000, 0x41);
  const frame = frameClamAvInstream(payload);
  const first = frame.readUInt32BE(10);
  assert.equal(first, 64 * 1024);
  const secondOffset = 10 + 4 + first;
  assert.equal(frame.readUInt32BE(secondOffset), 70_000 - 64 * 1024);
  assert.equal(frame.readUInt32BE(secondOffset + 4 + (70_000 - 64 * 1024)), 0);
});

test('parseClamAvResponse: OK, FOUND and ERROR replies', () => {
  assert.deepEqual(parseClamAvResponse('stream: OK\0'), { status: 'clean' });
  assert.deepEqual(parseClamAvResponse('stream: Eicar-Test-Signature FOUND\0'), {
    status: 'infected',
    signature: 'Eicar-Test-Signature',
  });
  const error = parseClamAvResponse('stream: INSTREAM size limit exceeded. ERROR\0');
  assert.equal(error.status, 'error');
  assert.ok(error.detail?.includes('INSTREAM size limit'));
  assert.equal(parseClamAvResponse('\0').status, 'error');
});

test('ClamAvScanner: clean stream through the real INSTREAM protocol', async () => {
  const fake = await startFakeClamd({ infectOn: EICAR_TEST_STRING });
  const scanner = new ClamAvScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: 2000 });
  try {
    assert.equal(scanner.isConfigured(), true);
    const result = await scanner.scan({ data: Buffer.from('hello'), tenantId: 'demo' });
    assert.equal(result.status, 'clean');
    assert.equal(result.engine, 'clamav');
  } finally {
    await closeServer(fake.server);
  }
});

test('ClamAvScanner: EICAR test payload is reported infected with its signature', async () => {
  const fake = await startFakeClamd({ infectOn: EICAR_TEST_STRING });
  const scanner = new ClamAvScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: 2000 });
  try {
    const result = await scanner.scan({ data: EICAR, tenantId: 'demo', fileId: 'f1' });
    assert.equal(result.status, 'infected');
    assert.equal(result.signature, 'Eicar-Test-Signature');
    assert.equal(result.bytes, EICAR.length);
  } finally {
    await closeServer(fake.server);
  }
});

test('ClamAvScanner: timeout and unreachable daemon are scanner errors, never throws', async () => {
  const slow = await startFakeClamd({ delayMs: 500 });
  const scanner = new ClamAvScanner({ host: '127.0.0.1', port: slow.port, timeoutMs: 100 });
  try {
    const result = await scanner.scan({ data: Buffer.from('slow'), tenantId: 'demo' });
    assert.equal(result.status, 'error');
    assert.match(result.detail ?? '', /timeout/i);
  } finally {
    await closeServer(slow.server);
  }

  const closed = await startFakeClamd();
  const port = closed.port;
  await closeServer(closed.server);
  const unreachable = new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 300 });
  const failed = await unreachable.scan({ data: Buffer.from('x'), tenantId: 'demo' });
  assert.equal(failed.status, 'error');
});

test('ClamAvScanner: not configured and oversized payloads are explicit', async () => {
  const scanner = new ClamAvScanner({});
  assert.equal(scanner.isConfigured(), false);
  const notConfigured = await scanner.scan({ data: Buffer.from('x'), tenantId: 'demo' });
  assert.equal(notConfigured.status, 'error');

  const limited = new ClamAvScanner({ host: '127.0.0.1', port: 1, maxBytes: 4 });
  const skipped = await limited.scan({ data: Buffer.alloc(10), tenantId: 'demo' });
  assert.equal(skipped.status, 'skipped');
});

test('YaraScanner: CLI match, clean run and CLI error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agil-yara-test-'));
  const fakeYara = join(dir, 'fake-yara.mjs');
  // Emulates `yara <rules> <target>`: exit 1 + stdout line when the rule matches.
  writeFileSync(
    fakeYara,
    [
      "import { readFileSync } from 'node:fs';",
      'const target = process.argv[3];',
      'const content = readFileSync(target, "utf8");',
      'if (process.env.FAKE_YARA_ERROR === "1") { console.error("bad rules"); process.exit(2); }',
      'if (content.includes("EICAR")) { console.log("EICAR_Test_File " + target); process.exit(1); }',
      'process.exit(0);',
    ].join('\n'),
    'utf8',
  );
  const scanner = new YaraScanner({
    rulesPath: join(dir, 'rules.yar'),
    command: process.execPath,
    argsPrefix: [fakeYara],
    timeoutMs: 5000,
  });
  try {
    assert.equal(scanner.isConfigured(), true);
    const clean = await scanner.scan({ data: Buffer.from('harmless'), tenantId: 'demo' });
    assert.equal(clean.status, 'clean');

    const infected = await scanner.scan({ data: EICAR, tenantId: 'demo' });
    assert.equal(infected.status, 'infected');
    assert.equal(infected.signature, 'EICAR_Test_File');
    assert.equal(infected.engine, 'yara');

    process.env.FAKE_YARA_ERROR = '1';
    const broken = await scanner.scan({ data: Buffer.from('x'), tenantId: 'demo' });
    assert.equal(broken.status, 'error');
  } finally {
    delete process.env.FAKE_YARA_ERROR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CompositeAvScanner: infection wins, otherwise any engine error is surfaced', async () => {
  const clean: AvScanner = {
    name: 'clean',
    isConfigured: () => true,
    scan: async () => ({ status: 'clean', engine: 'clean', durationMs: 0, scannedAt: Date.now(), bytes: 0 }),
  };
  const infected: AvScanner = {
    name: 'infected',
    isConfigured: () => true,
    scan: async () => ({
      status: 'infected',
      engine: 'infected',
      signature: 'Eicar-Test-Signature',
      durationMs: 0,
      scannedAt: Date.now(),
      bytes: 0,
    }),
  };
  const broken: AvScanner = {
    name: 'broken',
    isConfigured: () => true,
    scan: async () => ({ status: 'error', engine: 'broken', detail: 'down', durationMs: 0, scannedAt: Date.now(), bytes: 0 }),
  };
  const off: AvScanner = {
    name: 'off',
    isConfigured: () => false,
    scan: async () => ({ status: 'clean', engine: 'off', durationMs: 0, scannedAt: Date.now(), bytes: 0 }),
  };

  const infectedFirst = new CompositeAvScanner([clean, infected]);
  assert.equal((await infectedFirst.scan({ data: Buffer.from('x'), tenantId: 'demo' })).status, 'infected');

  const cleanOnly = new CompositeAvScanner([clean, off]);
  assert.equal((await cleanOnly.scan({ data: Buffer.from('x'), tenantId: 'demo' })).status, 'clean');

  const withError = new CompositeAvScanner([clean, broken]);
  const error = await withError.scan({ data: Buffer.from('x'), tenantId: 'demo' });
  assert.equal(error.status, 'error');
  assert.match(error.detail ?? '', /broken: down/);

  const noneConfigured = new CompositeAvScanner([off]);
  assert.equal(noneConfigured.isConfigured(), false);
});
