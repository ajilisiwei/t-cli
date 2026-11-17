import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/modules/ai/sse.ts';
import { parseStreamEvent } from '../src/modules/ai/llm.ts';
import { AppError } from '../src/http/errors.ts';

const encoder = new TextEncoder();

function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

function parseAll(chunks: readonly Uint8Array[]): string[] {
  const parser = createSseParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
}

const contentEvent = (content: string) => JSON.stringify({ choices: [{ index: 0, delta: { content } }] });

describe('SSE parser', () => {
  test('reassembles events split at every possible chunk size, incl. inside lines and multi-byte characters', () => {
    const payloads = [contentEvent('prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑 🙂'), contentEvent('第二段'), '[DONE]'];
    const bytes = encoder.encode(payloads.map((p) => `data: ${p}\n\n`).join(''));
    for (const size of [1, 2, 3, 4, 5, 7, 11, 64]) {
      assert.deepEqual(parseAll(chunked(bytes, size)), payloads, `chunk size ${size}`);
    }
  });

  test('a chunk boundary inside a 3-byte and a 4-byte character decodes correctly', () => {
    const text = 'data: 优🙂\n\n';
    const bytes = encoder.encode(text);
    const zhStart = encoder.encode('data: ').length; // '优' = e4 bc 98
    const emojiStart = zhStart + 3; // '🙂' = f0 9f 99 82
    const parts = [bytes.subarray(0, zhStart + 1), bytes.subarray(zhStart + 1, emojiStart + 2), bytes.subarray(emojiStart + 2)];
    const parser = createSseParser();
    assert.deepEqual(parser.push(parts[0]!), []);
    assert.deepEqual(parser.push(parts[1]!), []);
    assert.deepEqual(parser.push(parts[2]!), ['优🙂']);
    assert.deepEqual(parser.end(), []);
  });

  test('nothing is emitted until the blank line that ends the event arrives', () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push(encoder.encode('data: {"a"')), []);
    assert.deepEqual(parser.push(encoder.encode(':1}\n')), []);
    assert.deepEqual(parser.push(encoder.encode('\n')), ['{"a":1}']);
  });

  test('handles LF, CRLF and CR line endings, incl. a CRLF split across chunks', () => {
    assert.deepEqual(parseAll([encoder.encode('data: a\r\n\r\ndata: b\r\rdata: c\n\n')]), ['a', 'b', 'c']);
    const parser = createSseParser();
    assert.deepEqual(parser.push(encoder.encode('data: x\r')), []);
    assert.deepEqual(parser.push(encoder.encode('\n\r')), []);
    assert.deepEqual(parser.push(encoder.encode('\ndata: y\n\n')), ['x', 'y'], 'the split CRLF is one line ending, not two');
  });

  test('ignores keep-alive comments and non-data fields; joins multi-line data', () => {
    const stream = ': keep-alive\n\nevent: message\nid: 7\nretry: 1000\ndata:first\ndata: second\n\n: ping\n\n';
    assert.deepEqual(parseAll([encoder.encode(stream)]), ['first\nsecond']);
  });

  test('end() flushes a final event that lacks its blank line; an empty stream yields nothing', () => {
    assert.deepEqual(parseAll([encoder.encode('data: [DONE]')]), ['[DONE]']);
    assert.deepEqual(parseAll([encoder.encode('data: last\n')]), ['last']);
    assert.deepEqual(parseAll([]), []);
    assert.deepEqual(parseAll([encoder.encode(': only a comment\n\n')]), []);
  });
});

describe('chat stream events', () => {
  test('content, role-only and finish chunks', () => {
    assert.deepEqual(parseStreamEvent(contentEvent('Hi')), { kind: 'chunk', content: 'Hi', finished: false });
    assert.deepEqual(parseStreamEvent(JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })), {
      kind: 'chunk',
      content: '',
      finished: false,
    });
    assert.deepEqual(parseStreamEvent(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: {} })), {
      kind: 'chunk',
      content: '',
      finished: true,
    });
    assert.deepEqual(parseStreamEvent(JSON.stringify({ choices: [], usage: { total_tokens: 3 } })), {
      kind: 'chunk',
      content: '',
      finished: false,
    });
    assert.deepEqual(parseStreamEvent('[DONE]'), { kind: 'done' });
  });

  test('malformed payloads and in-band errors are upstream errors', () => {
    for (const data of ['{"choices": [', '{"error":{"message":"overloaded"}}', '{"choices":"nope"}']) {
      assert.throws(
        () => parseStreamEvent(data),
        (error: unknown) => error instanceof AppError && error.statusCode === 502 && error.code === 'AI_UPSTREAM',
        data,
      );
    }
  });
});
