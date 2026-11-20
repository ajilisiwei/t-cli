import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeSsmlText } from '../src/ssml.js';

test('escapeSsmlText escapes markup so it is read as text', () => {
  assert.equal(escapeSsmlText('R&D <b>bold</b> a > b'), 'R&amp;D &lt;b&gt;bold&lt;/b&gt; a &gt; b');
  assert.equal(escapeSsmlText('</prosody><voice name="x">'), '&lt;/prosody&gt;&lt;voice name="x"&gt;');
});

test('escapeSsmlText replaces characters XML forbids with spaces', () => {
  assert.equal(escapeSsmlText('a\u0000b\u0007c\td\ne'), 'a b c\td\ne');
  assert.equal(escapeSsmlText('x￾y￿z'), 'x y z');
});

test('escapeSsmlText leaves plain Chinese and English unchanged', () => {
  assert.equal(escapeSsmlText('你好，世界'), '你好，世界');
  assert.equal(escapeSsmlText("It's fine."), "It's fine.");
});
