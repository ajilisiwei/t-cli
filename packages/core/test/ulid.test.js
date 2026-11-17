import test from 'node:test';
import assert from 'node:assert/strict';
import { ulid, ulidTime, ULID_RE } from '../src/ulid.js';

test('ulid: 26 Crockford base32 chars', () => {
  assert.match(ulid(), ULID_RE);
});

test('ulid: time round-trips through ulidTime', () => {
  const time = Date.UTC(2026, 10, 16, 1, 12, 3);
  assert.equal(ulidTime(ulid({ time })), time);
});

test('ulid: same time + same entropy is deterministic', () => {
  const entropy = new Uint8Array(10).fill(7);
  const time = 1_700_000_000_000;
  assert.equal(ulid({ time, entropy }), ulid({ time, entropy }));
});

test('ulid: random entropy differs between calls', () => {
  const time = 1_700_000_000_000;
  assert.notEqual(ulid({ time }), ulid({ time }));
});

test('ulid: later time sorts after earlier time', () => {
  const a = ulid({ time: 1_700_000_000_000 });
  const b = ulid({ time: 1_700_000_000_001 });
  assert.ok(a < b);
});

test('ulid: known vector — zero entropy', () => {
  const id = ulid({ time: 0, entropy: new Uint8Array(10) });
  assert.equal(id, '0'.repeat(26));
});

test('ulid: rejects bad time and short entropy', () => {
  assert.throws(() => ulid({ time: -1 }), RangeError);
  assert.throws(() => ulid({ time: 2 ** 48 }), RangeError);
  assert.throws(() => ulid({ entropy: new Uint8Array(9) }), RangeError);
});

test('ulidTime: rejects non-ULID strings', () => {
  assert.throws(() => ulidTime('not-a-ulid'), TypeError);
});
