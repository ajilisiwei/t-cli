import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createByteLruCache } from '../src/lib/byteLruCache.ts';
import { createEdgeTtsClient, escapeSsmlText } from '../src/modules/tts/edgeTts.ts';
import { TTS_VOICES, voiceFor } from '../src/modules/tts/routes.ts';

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);

describe('byte-bounded LRU cache', () => {
  test('stores, returns and accounts for values and keys', () => {
    const cache = createByteLruCache({ maxBytes: 1000 });
    assert.equal(cache.get('a'), undefined);
    cache.set('a', bytes(100));
    assert.deepEqual(cache.get('a'), bytes(100));
    assert.equal(cache.size, 1);
    assert.equal(cache.bytes, 100 + 2, 'two bytes per key code unit');
  });

  test('evicts the least recently used values once over budget', () => {
    const cache = createByteLruCache({ maxBytes: 310 });
    cache.set('a', bytes(100));
    cache.set('b', bytes(100));
    cache.set('c', bytes(100));
    assert.equal(cache.size, 3);
    cache.get('a'); // a is now the most recent; b is the oldest
    cache.set('d', bytes(100));
    assert.equal(cache.get('b'), undefined);
    assert.ok(cache.get('a') && cache.get('c') && cache.get('d'));
    assert.ok(cache.bytes <= 310);
  });

  test('a large value evicts several small ones; a value over the whole budget is not stored', () => {
    const cache = createByteLruCache({ maxBytes: 300 });
    for (const key of ['a', 'b', 'c']) cache.set(key, bytes(90));
    cache.set('big', bytes(250));
    assert.deepEqual([cache.get('a'), cache.get('b'), cache.get('c')], [undefined, undefined, undefined]);
    assert.equal(cache.size, 1);

    cache.set('huge', bytes(301));
    assert.equal(cache.get('huge'), undefined);
    assert.ok(cache.get('big'), 'an oversized value does not flush the cache');
  });

  test('replacing a key adjusts the accounted bytes', () => {
    const cache = createByteLruCache({ maxBytes: 1000 });
    cache.set('k', bytes(400));
    cache.set('k', bytes(100, 7));
    assert.equal(cache.size, 1);
    assert.equal(cache.bytes, 102);
    assert.equal(cache.get('k')?.[0], 7);
  });

  test('a zero budget caches nothing', () => {
    const cache = createByteLruCache({ maxBytes: 0 });
    cache.set('a', bytes(1));
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.bytes, 0);
  });
});

describe('Edge TTS adapter', () => {
  test('text is escaped as XML character data for the SSML template', () => {
    assert.equal(escapeSsmlText('R&D <b>bold</b> a > b'), 'R&amp;D &lt;b&gt;bold&lt;/b&gt; a &gt; b');
    assert.equal(escapeSsmlText('</prosody><voice name="x">'), '&lt;/prosody&gt;&lt;voice name="x"&gt;');
    assert.equal(escapeSsmlText('a\u0000b\u0007c\td\ne'), 'a b c\td\ne', 'characters XML forbids become spaces');
    assert.equal(escapeSsmlText('你好，世界'), '你好，世界');
  });

  test('an already-aborted signal rejects without connecting', async () => {
    const controller = new AbortController();
    controller.abort(new Error('timed out'));
    await assert.rejects(createEdgeTtsClient().synthesize('hello', TTS_VOICES.en, { signal: controller.signal }), /timed out/);
  });

  test('voice selection: CJK → Chinese voice, otherwise American English (as the CLI)', () => {
    assert.equal(TTS_VOICES.zh, 'zh-CN-XiaoxiaoNeural');
    assert.equal(TTS_VOICES.en, 'en-US-AriaNeural');
    assert.equal(voiceFor('谢谢'), TTS_VOICES.zh);
    assert.equal(voiceFor('It works 很好'), TTS_VOICES.zh);
    assert.equal(voiceFor('It works.'), TTS_VOICES.en);
  });
});
