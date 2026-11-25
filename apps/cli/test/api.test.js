import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStreamPayload } from '../src/api.js';

describe('buildStreamPayload', () => {
  test('thinking false and true become the DeepSeek switch; omitted, nothing is sent', () => {
    assert.deepEqual(buildStreamPayload('sys', 'user', { thinking: false }).thinking, { type: 'disabled' });
    assert.deepEqual(buildStreamPayload('sys', 'user', { thinking: true }).thinking, { type: 'enabled' });
    assert.equal('thinking' in buildStreamPayload('sys', 'user'), false);
  });

  test('keeps the streamed chat request shape', () => {
    const payload = buildStreamPayload('sys', 'user', { thinking: false });
    assert.deepEqual(payload.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' }
    ]);
    assert.equal(payload.temperature, 0.3);
    assert.equal(payload.stream, true);
  });
});
