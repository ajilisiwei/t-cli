import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExtendAnswer, type ExtendCheckInput } from '../src/modules/pipeline/extend.ts';
import { composeReasons, type ReasonInput } from '../src/modules/pipeline/extendReasons.ts';
import { givenLemmas, mergeCounts, type ExtendSignals } from '../src/modules/pipeline/extendSignals.ts';
import { ExtendContentSchema } from '../src/modules/pipeline/learnContent.ts';
import { cannedExtend, type SourcePayload } from './helpers/pipeline.ts';

const signals: ExtendSignals = {
  lemmas: [
    { text: 'deadline', count: 4 },
    { text: 'Agenda', count: 2 },
    { text: 'invoice', count: 1 },
  ],
  grammar: [{ title: '冠词', errors: 4 }],
  forgotten: [{ text: 'postpone', lapses: 2 }],
  starred: ['negotiate'],
};

const levelAuto = { setting: 'auto' as const, effective: 'B2' as const, retention30: 0.8234, reviews30: 200 };

const answerFor = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...cannedExtend({ task: 'extend', lemmas: signals.lemmas, forgotten: signals.forgotten, starred: signals.starred } as SourcePayload),
  ...overrides,
});

const input = (overrides: Partial<ExtendCheckInput> = {}): ExtendCheckInput => ({
  lang: 'zh',
  signals,
  mutedTopics: [],
  level: levelAuto,
  ...overrides,
});

describe('extension signals (pure)', () => {
  test('mergeCounts sums by key, keeps the first display, sorts by count then text, caps', () => {
    assert.deepEqual(
      mergeCounts(
        [
          [
            { text: 'Deadline', count: 1 },
            { text: 'agenda', count: 2 },
          ],
          [
            { text: 'deadline', count: 2 },
            { text: 'budget', count: 2 },
          ],
        ],
        2,
      ),
      [
        { text: 'Deadline', count: 3 },
        { text: 'agenda', count: 2 },
      ],
    );
  });

  test('givenLemmas: lemmas, forgotten and starred by key, the first display wins', () => {
    const given = givenLemmas({ ...signals, starred: ['negotiate', 'DEADLINE'] });
    assert.deepEqual([...given.entries()].sort(), [
      ['agenda', 'Agenda'],
      ['deadline', 'deadline'],
      ['invoice', 'invoice'],
      ['negotiate', 'negotiate'],
      ['postpone', 'postpone'],
    ]);
  });
});

describe('composeReasons (pure)', () => {
  const base: ReasonInput = { lang: 'zh', topic: 'work', evidence: ['deadline', 'Agenda', 'invoice'], signals, grammarPoint: null, level: levelAuto };

  test('lookups, forgetting, grammar and stars, then the level; at most four', () => {
    assert.deepEqual(composeReasons(base), ['最近 14 天你查了 deadline、Agenda 等 3 个职场用词', '按你最近 82% 的记住率，难度定在 B2']);
    const all = composeReasons({
      ...base,
      evidence: ['deadline', 'postpone', 'negotiate'],
      grammarPoint: { title: '冠词', errors: 4 },
    });
    assert.deepEqual(all, ['最近 14 天你查了 deadline', 'postpone 在复习时忘了 2 次', '纠错里「冠词」出现了 4 次', '按你最近 82% 的记住率，难度定在 B2']);
    assert.ok(!all.some((reason) => reason.includes('标成了重要')), 'the fourth evidence reason gives way to the level');
    assert.deepEqual(composeReasons({ ...base, evidence: ['negotiate', 'postpone'] }), [
      'postpone 在复习时忘了 2 次',
      '你把 negotiate 标成了重要',
      '按你最近 82% 的记住率，难度定在 B2',
    ]);
  });

  test('English, two names, a fixed level and a level without data', () => {
    assert.deepEqual(composeReasons({ ...base, lang: 'en', evidence: ['deadline', 'Agenda'], level: { setting: 'C1', effective: 'C1', retention30: 0.9, reviews30: 10 } }), [
      'In the last 14 days you looked up deadline and Agenda',
      'The level is C1, as you set it',
    ]);
    assert.deepEqual(composeReasons({ ...base, lang: 'en', topic: 'other', level: { setting: 'auto', effective: 'B1', retention30: null, reviews30: 0 } }), [
      'In the last 14 days you looked up deadline, Agenda and 1 more related words',
      'The level starts at B1 and adjusts as you review',
    ]);
    assert.deepEqual(composeReasons({ ...base, evidence: [], level: { setting: 'auto', effective: 'B1', retention30: 0, reviews30: 1 } }), [
      '难度先定在 B1，复习多了会自动调整',
    ], 'too few reviews: the rate does not explain the level');
    assert.deepEqual(composeReasons({ ...base, lang: 'en', evidence: ['postpone'], signals: { ...signals, forgotten: [{ text: 'postpone', lapses: 1 }] } }), [
      'You forgot postpone 1 time in review',
      'At your recent 82% recall rate, the level is B2',
    ]);
  });

  test('long names are clipped so every reason fits the schema (≤ 120)', () => {
    const long = 'a'.repeat(80);
    const reasons = composeReasons({
      ...base,
      evidence: [long, `${long}b`, `${long}c`],
      signals: { ...signals, lemmas: [{ text: long, count: 1 }, { text: `${long}b`, count: 1 }, { text: `${long}c`, count: 1 }] },
      grammarPoint: { title: 'g'.repeat(80), errors: 2 },
    });
    assert.ok(reasons.every((reason) => reason.length <= 120));
  });
});

describe('checkExtendAnswer (pure)', () => {
  test('a valid answer becomes the stored material: server level and reasons, evidence by the given display', () => {
    const check = checkExtendAnswer(answerFor({ evidence: ['DEADLINE', 'agenda', 'invoice'] }), input());
    assert.ok(check.ok);
    assert.equal(ExtendContentSchema.safeParse(check.value).success, true);
    assert.equal(check.value.level, 'B2');
    assert.deepEqual(check.value.evidence, ['deadline', 'Agenda', 'invoice']);
    assert.deepEqual(check.value.reasons, ['最近 14 天你查了 deadline、Agenda 等 3 个职场用词', '按你最近 82% 的记住率，难度定在 B2']);
    assert.equal('grammarPoint' in check.value, false);
    assert.equal(check.value.items.length, 6);
  });

  test('evidence not in the given lemmas is dropped; fewer than two left → evidence', () => {
    const check = checkExtendAnswer(answerFor({ evidence: ['deadline', 'blockchain', 'synergy'] }), input());
    assert.deepEqual(check, { ok: false, reason: 'evidence' });
    const two = checkExtendAnswer(answerFor({ evidence: ['deadline', 'blockchain', 'postpone'] }), input());
    assert.ok(two.ok);
    assert.deepEqual(two.value.evidence, ['deadline', 'postpone']);
  });

  test('schema, muted topic, language and item checks', () => {
    assert.deepEqual(checkExtendAnswer({ focus: 'topic' }, input()), { ok: false, reason: 'schema' });
    assert.deepEqual(checkExtendAnswer(answerFor({ reasons: ['model reason'] }), input()).ok, true, 'model reasons are ignored, not refused');
    assert.deepEqual(checkExtendAnswer(answerFor({ topic: 'travel' }), input({ mutedTopics: ['travel'] })), { ok: false, reason: 'muted_topic' });
    assert.equal(checkExtendAnswer(answerFor({ topic: 'other' }), input({ mutedTopics: ['other'] })).ok, true, 'other is never muted');
    assert.deepEqual(checkExtendAnswer(answerFor({ title: 'Work words' }), input()), { ok: false, reason: 'explanation_lang' });
    assert.equal(checkExtendAnswer(answerFor({ title: 'Work words' }), input({ lang: 'en' })).ok, true);

    const items = (answerFor().items as { text: string; kind: string; gloss: string; example: { en: string; zh: string } }[]).map((item, i) =>
      i === 0 ? { ...item, example: { ...item.example, en: 'No target here.' } } : i === 1 ? { ...item, gloss: 'meaning' } : item,
    );
    assert.deepEqual(checkExtendAnswer(answerFor({ items }), input()), { ok: false, reason: 'items' }, 'two unusable items leave four');
    const duplicated = [...(answerFor().items as unknown[]).slice(0, 5), (answerFor().items as unknown[])[0]];
    assert.deepEqual(checkExtendAnswer(answerFor({ items: duplicated }), input()), { ok: false, reason: 'items' });
  });

  test('the grammar point the model names must be one of the signals to make a reason', () => {
    const grammar = { rule: '可数名词单数前要用冠词。', examples: [{ wrong: 'I have meeting.', right: 'I have a meeting.' }] };
    const named = checkExtendAnswer(answerFor({ focus: 'grammar', grammar, grammarPoint: '冠词' }), input());
    assert.ok(named.ok);
    assert.ok(named.value.reasons.includes('纠错里「冠词」出现了 4 次'));
    const invented = checkExtendAnswer(answerFor({ focus: 'grammar', grammar, grammarPoint: '时态' }), input());
    assert.ok(invented.ok);
    assert.ok(!invented.value.reasons.some((reason) => reason.includes('纠错')));
  });
});
