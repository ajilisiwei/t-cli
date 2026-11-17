import test from 'node:test';
import assert from 'node:assert/strict';
import { toQuizEntries, parseQuizResponse } from '../src/utils/quiz.js';

process.env.TZ = 'Asia/Shanghai';

const FILE = `# t-cli Learning History — 2026-11-16

---

## [10:32] Translation

**Input:** 这个情况确实有点不一样

This situation is indeed a bit different.

---

## [14:02] Grammar Check

**Input:** She don't like it.

She doesn't like it.

---

## [15:05] Translation

**Input:** prioritiz

prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑

---

## [15:07] Translation

**Input:** leverage

leverage /ˈlev.ɚ.ɪdʒ/

---

杠杆；利用

---
`;

test('toQuizEntries: real "Translation" headings are recognised (regression: quiz found 0 entries)', () => {
  const entries = toQuizEntries('2026-11-16', FILE);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { date: '2026-11-16', source: '这个情况确实有点不一样', target: 'This situation is indeed a bit different.' });
});

test('toQuizEntries: grammar checks are excluded', () => {
  assert.ok(toQuizEntries('2026-11-16', FILE).every((e) => e.source !== "She don't like it."));
});

test('toQuizEntries: a misspelled lookup is quizzed by its corrected spelling', () => {
  const sources = toQuizEntries('2026-11-16', FILE).map((e) => e.source);
  assert.ok(sources.includes('prioritize'));
  assert.ok(!sources.includes('prioritiz'));
});

test('toQuizEntries: a "---" inside a response does not split the entry', () => {
  const leverage = toQuizEntries('2026-11-16', FILE).find((e) => e.source === 'leverage');
  assert.equal(leverage.target, 'leverage /ˈlev.ɚ.ɪdʒ/\n\n---\n\n杠杆；利用');
});

test('parseQuizResponse: tolerates prose around the JSON object', () => {
  assert.deepEqual(parseQuizResponse('ok {"correct": true, "explanation": " fine "} done'), { correct: true, explanation: 'fine' });
  assert.deepEqual(parseQuizResponse('no json'), { correct: false, explanation: '' });
});
