import test from 'node:test';
import assert from 'node:assert/strict';
import { pushHistory, navigateHistory } from '../src/utils/inputHistory.js';

test('pushHistory appends trimmed entries without mutating', () => {
  const original = ['a'];
  const next = pushHistory(original, ' b ');
  assert.deepEqual(next, ['a', 'b']);
  assert.deepEqual(original, ['a']);
});

test('pushHistory skips blanks and consecutive duplicates', () => {
  assert.deepEqual(pushHistory([], '   '), []);
  assert.deepEqual(pushHistory(['a'], 'a'), ['a']);
  assert.deepEqual(pushHistory(['a', 'b'], 'a'), ['a', 'b', 'a']);
});

test('pushHistory caps entries at the limit', () => {
  assert.deepEqual(pushHistory(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);
});

test('navigateHistory walks up through history and clamps at oldest', () => {
  const entries = ['one', 'two', 'three'];
  const first = navigateHistory(entries, null, 'up');
  assert.deepEqual(first, { index: 2, text: 'three' });
  assert.deepEqual(navigateHistory(entries, first.index, 'up'), { index: 1, text: 'two' });
  assert.deepEqual(navigateHistory(entries, 1, 'up'), { index: 0, text: 'one' });
  assert.equal(navigateHistory(entries, 0, 'up'), null);
});

test('navigateHistory walks down and restores the draft past the newest', () => {
  const entries = ['one', 'two'];
  assert.deepEqual(navigateHistory(entries, 0, 'down'), { index: 1, text: 'two' });
  assert.deepEqual(navigateHistory(entries, 1, 'down', 'draft'), { index: null, text: 'draft' });
  assert.equal(navigateHistory(entries, null, 'down', 'draft'), null);
});

test('navigateHistory ignores up on empty history', () => {
  assert.equal(navigateHistory([], null, 'up'), null);
});
