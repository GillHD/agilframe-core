import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { SttService } from '../src/stt.js';
import { SecurityError } from '../src/errors.js';

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TestServer {
  url: string;
  lastRequest: () => CapturedRequest | undefined;
  close: () => Promise<void>;
}

/** Starts a local OpenAI-compatible STT stub on port 0. */
function startSttServer(handler: (request: CapturedRequest, res: ServerResponse) => void): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      handler(captured, res);
    });
  });

  return new Promise<TestServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind test server'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        lastRequest: () => requests[requests.length - 1],
        async close() {
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

const json = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

test('isConfigured: false без AGIL_STT_URL', async () => {
  const service = new SttService();
  assert.equal(service.isConfigured(), false);
  assert.equal(new SttService({ url: '' }).isConfigured(), false);
  assert.equal(new SttService({ url: '   ' }).isConfigured(), false);
  assert.equal(new SttService({ url: 'http://127.0.0.1:1/v1' }).isConfigured(), true);
});

test('transcribe: не настроен -> SecurityError(stt_not_configured)', async () => {
  const service = new SttService();
  await assert.rejects(
    service.transcribe(Buffer.from('x'), { mime: 'audio/webm' }),
    (error: unknown) => error instanceof SecurityError && error.code === 'stt_not_configured',
  );
});

test('transcribe: mock-сервер 200 -> SttResponse (multipart, model, language, bearer)', async () => {
  const server = await startSttServer((request, res) => {
    json(res, 200, {
      text: 'привет мир',
      language: 'ru',
      duration: 1.5,
      segments: [
        { start: 0, end: 0.8, text: 'привет' },
        { start: 0.8, end: 1.5, text: 'мир' },
      ],
    });
    void request;
  });
  try {
    const service = new SttService({ url: `${server.url}/`, key: 'test-key', model: 'whisper-1', timeoutMs: 5000 });
    const audio = Buffer.from('fake-webm-audio-bytes');
    const response = await service.transcribe(audio, { mime: 'audio/webm; codecs=opus', language: 'ru' });

    assert.equal(response.text, 'привет мир');
    assert.equal(response.provider, 'server');
    assert.equal(response.language, 'ru');
    assert.equal(response.durationSec, 1.5);
    assert.equal(response.segments?.length, 2);
    assert.deepEqual(response.segments?.[0], { start: 0, end: 0.8, text: 'привет' });

    const captured = server.lastRequest();
    assert.ok(captured);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/audio/transcriptions');
    assert.match(String(captured.headers['content-type']), /^multipart\/form-data; boundary=/);
    assert.equal(captured.headers.authorization, 'Bearer test-key');
    assert.match(captured.body, /name="file"; filename="audio\.webm"/);
    assert.match(captured.body, /fake-webm-audio-bytes/);
    assert.match(captured.body, /name="model"\r\n\r\nwhisper-1/);
    assert.match(captured.body, /name="language"\r\n\r\nru/);
    assert.match(captured.body, /name="response_format"\r\n\r\nverbose_json/);
  } finally {
    await server.close();
  }
});

test('transcribe: language=auto не отправляется; без ключа нет Authorization', async () => {
  const server = await startSttServer((_request, res) => json(res, 200, { text: 'ok' }));
  try {
    const service = new SttService({ url: server.url });
    const response = await service.transcribe(Buffer.from('x'), { mime: 'audio/wav', language: 'auto' });
    assert.equal(response.text, 'ok');
    const captured = server.lastRequest();
    assert.ok(captured);
    assert.equal(captured.headers.authorization, undefined);
    assert.doesNotMatch(captured.body, /name="language"/);
    assert.match(captured.body, /name="file"; filename="audio\.wav"/);
  } finally {
    await server.close();
  }
});

test('transcribe: mock-сервер 500 -> Error с текстом, без утечки ключа', async () => {
  const server = await startSttServer((_request, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('provider exploded');
  });
  try {
    const service = new SttService({ url: server.url, key: 'super-secret-key' });
    await assert.rejects(
      service.transcribe(Buffer.from('x'), { mime: 'audio/webm' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 500/);
        assert.match(error.message, /provider exploded/);
        assert.ok(!error.message.includes('super-secret-key'), 'ключ не должен попадать в ошибку');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('transcribe: провайдер вернул error в JSON -> Error', async () => {
  const server = await startSttServer((_request, res) => json(res, 200, { error: { message: 'bad audio' } }));
  try {
    const service = new SttService({ url: server.url });
    await assert.rejects(
      service.transcribe(Buffer.from('x'), { mime: 'audio/webm' }),
      (error: unknown) => error instanceof Error && /bad audio/.test(error.message),
    );
  } finally {
    await server.close();
  }
});
