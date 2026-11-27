import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatPolicy, createChatIdentities } from './chat-moderation.mjs';

test('viewer credentials are independent and restricted to one live stream', () => {
  const identities = createChatIdentities();
  const first = identities.issue('stream');
  const second = identities.issue('stream');
  assert.notEqual(identities.viewer('stream', first), identities.viewer('stream', second));
  assert.equal(identities.viewer('other-stream', first), undefined);
  assert.equal(identities.viewer('stream', first.split('.')[0]), undefined);
  assert.equal(createChatIdentities().viewer('stream', first), undefined);
});

test('filter normalizes phrases, preserves ordinary text and recognizes unsafe markup', () => {
  const policy = chatPolicy({ allowLinks: false, blockedPhrases: [' Секретный код ', 'foo (bar)'] });
  assert.equal(policy.rejection('здесь СЕКРЕТНЫЙ   КОД!'), 'blocked_content');
  assert.equal(policy.rejection('вот foo (bar)'), 'blocked_content');
  assert.equal(policy.rejection('секретный кодекс'), undefined);
  assert.equal(policy.rejection('Нужен javascript разработчик 👩‍💻'), undefined);
  assert.equal(policy.rejection('Страница example.test'), 'links_disabled');
  assert.equal(policy.rejection('//192.0.2.1/test'), 'links_disabled');
  assert.equal(policy.rejection('<script>'), 'unsafe_content');
  assert.equal(chatPolicy({ allowLinks: true, blockedPhrases: [] }).rejection('https://example.test'), undefined);
  assert.equal(chatPolicy({ allowLinks: true, blockedPhrases: ['xx'] }), undefined);
});
