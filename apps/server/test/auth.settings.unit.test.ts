import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCENTS, MATERIAL_PARTS, SettingsPatch, toSettings, USER_EXTEND_TOPICS } from '../src/modules/auth/settings.ts';
import { DEFAULT_PLAN, learnPlanOf, mutedTopicsOn } from '../src/modules/learn/plan.ts';
import { EXTEND_TOPICS } from '../src/modules/pipeline/learnContent.ts';

describe('v3 settings and the learning plan (pure)', () => {
  test('every v3 key accepts its documented values', () => {
    const valid: Record<string, unknown>[] = [
      { materialFrequency: 'daily' },
      { materialFrequency: 'weekly' },
      { materialFrequency: 'off' },
      { materialWeekday: 0 },
      { materialWeekday: 6 },
      { materialParts: [...MATERIAL_PARTS] },
      { materialParts: ['story'] },
      { extendEnabled: true },
      { extendTopics: [] },
      { extendTopics: [...USER_EXTEND_TOPICS] },
      { extendMuted: [] },
      { extendMuted: [{ topic: 'other', until: '2026-12-31' }] },
      { studyLevel: 'auto' },
      { studyLevel: 'C1' },
    ];
    for (const patch of valid) assert.deepEqual(SettingsPatch.parse(patch), patch, JSON.stringify(patch));
    assert.deepEqual([...MATERIAL_PARTS], ['words', 'phrases', 'grammar', 'story', 'exercises']);
    assert.deepEqual([...USER_EXTEND_TOPICS], EXTEND_TOPICS.filter((topic) => topic !== 'other'));
  });

  test('lists are bounded, without duplicates; muted entries are strict', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ topic: EXTEND_TOPICS[i % EXTEND_TOPICS.length], until: '2026-12-01' }));
    const invalid: Record<string, unknown>[] = [
      { materialParts: [] },
      { materialParts: [...MATERIAL_PARTS, 'words'] },
      { extendTopics: ['work', 'work'] },
      { extendTopics: ['other'] },
      { extendMuted: nine },
      { extendMuted: [{ topic: 'work' }] },
      { extendMuted: [{ topic: 'work', until: '2026-1-01' }] },
      { materialWeekday: 2.5 },
    ];
    for (const patch of invalid) assert.equal(SettingsPatch.safeParse(patch).success, false, JSON.stringify(patch));
  });

  test('learnPlanOf applies the defaults and ignores invalid stored values', () => {
    assert.deepEqual(learnPlanOf({}), DEFAULT_PLAN);
    assert.deepEqual(DEFAULT_PLAN, {
      materialFrequency: 'daily',
      materialWeekday: 1,
      materialParts: ['words', 'phrases', 'grammar', 'story', 'exercises'],
      extendEnabled: true,
      extendTopics: [],
      extendMuted: [],
      studyLevel: 'auto',
    });
    const plan = learnPlanOf({ materialFrequency: 'weekly', materialWeekday: 9, studyLevel: 'B2', extendTopics: ['tech'] });
    assert.equal(plan.materialFrequency, 'weekly');
    assert.equal(plan.materialWeekday, 1, 'an invalid weekday falls back to Monday');
    assert.equal(plan.studyLevel, 'B2');
    assert.deepEqual(plan.extendTopics, ['tech']);
  });

  test('a topic is muted while its until day is later than today', () => {
    const plan = learnPlanOf({ extendMuted: [{ topic: 'work', until: '2026-12-01' }, { topic: 'travel', until: '2026-11-30' }] });
    assert.deepEqual(mutedTopicsOn(plan, '2026-11-29'), ['work', 'travel']);
    assert.deepEqual(mutedTopicsOn(plan, '2026-11-30'), ['work']);
    assert.deepEqual(mutedTopicsOn(plan, '2026-12-01'), []);
  });
});

describe('settings schema (pure)', () => {
  test('every v2 key accepts its documented values', () => {
    const valid: Record<string, unknown>[] = [
      ...ACCENTS.map((accent) => ({ accent })),
      { themeMode: 'system' },
      { themeMode: 'time' },
      { themeMode: 'fixed' },
      { themeFixed: 'light' },
      { themeFixed: 'dark' },
      { themeDayStart: '00:00' },
      { themeNightStart: '23:59' },
      { readingFontStep: 0 },
      { readingFontStep: 3 },
      { showDirection: false },
      { readingMode: false },
      { importanceReview: true },
    ];
    for (const patch of valid) assert.deepEqual(SettingsPatch.parse(patch), patch, JSON.stringify(patch));
    assert.deepEqual([...ACCENTS], ['indigo', 'pine', 'plum', 'ochre', 'ink']);
  });

  test('times are HH:MM with two-digit hours and minutes in range', () => {
    for (const value of ['7:00', '07:0', '24:00', '12:60', '07:00:00', ' 07:00', '']) {
      assert.equal(SettingsPatch.safeParse({ themeDayStart: value }).success, false, value);
    }
  });

  test('toSettings shows only known keys with valid values', () => {
    const stored = {
      explanationLang: 'en',
      accent: 'plum',
      themeMode: 'night',
      readingFontStep: 9,
      importanceReview: false,
      legacy: { a: 1 },
    };
    assert.deepEqual(toSettings(stored), { explanationLang: 'en', accent: 'plum', importanceReview: false });
    assert.deepEqual(toSettings(null), {});
    assert.deepEqual(toSettings([1, 2]), {});
  });
});
