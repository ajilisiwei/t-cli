import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCENTS, SettingsPatch, toSettings } from '../src/modules/auth/settings.ts';

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
