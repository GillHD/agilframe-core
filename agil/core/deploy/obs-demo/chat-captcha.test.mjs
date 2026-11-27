import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatCaptcha } from './chat-captcha.mjs';

test('CAPTCHA validates hostname and action and issues a scoped expiring pass', async () => {
  let now = 1000;
  let checks = 0;
  const captcha = createChatCaptcha({
    siteKey: 'site-key', secret: 'server-secret', hostnames: new Set(['chat.example.test']), clock: () => now,
    fetcher: async (url, { body }) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(body.get('secret'), 'server-secret');
      checks += 1;
      const token = body.get('response');
      if (token === 'outage') return new Response(null, { status: 503 });
      return Response.json({ success: true, hostname: token === 'wrong-host' ? 'other.example.test' : 'chat.example.test',
        action: token === 'wrong-action' ? 'something_else' : 'obs_chat' });
    },
  });
  const binding = ['stream', '192.0.2.1'];
  assert.equal((await captcha.verify(undefined, binding)).status, 'required');
  assert.equal((await captcha.verify('wrong-host', binding)).status, 'invalid');
  assert.equal((await captcha.verify('wrong-action', binding)).status, 'invalid');
  assert.equal((await captcha.verify('outage', binding)).status, 'unavailable');
  const [granted, replay] = await Promise.all([captcha.verify('good', binding), captcha.verify('good', binding)]);
  assert.equal(granted.status, 'verified');
  assert.equal(replay.status, 'invalid');
  assert.equal(checks, 4);
  assert.equal(captcha.accepts(granted.pass, binding), true);
  assert.equal(captcha.accepts(granted.pass, ['different', binding[1]]), false);
  assert.equal(captcha.accepts(granted.pass, [binding[0], '192.0.2.2']), false);
  assert.equal(captcha.accepts('9999999999999999.' + granted.pass.split('.')[1], binding), false);
  now += 600_000;
  assert.equal(captcha.accepts(granted.pass, binding), false);
});
