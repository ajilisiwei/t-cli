import { prototypeDaily, prototypeDigest, prototypeExtend } from './exportFixtures.ts';

/**
 * Materials of a given size, built from the export fixtures' realistic
 * elements, with the page counts the export renders them at (practice
 * layout, normal type, every part; Typst 0.13.1). The list's page estimate
 * (library/materialPages.ts) is checked against them without Typst
 * (materials.view.unit.test.ts) and against fresh renders with it
 * (materials.pages.render.test.ts).
 */

type Content = Record<string, unknown>;
const listOf = (content: Content, key: string): Content[] => content[key] as Content[];

/** A daily material with `words`, `phrases`, `grammar` and `mistakes` entries (cycling the fixture's), with or without its story. */
export function sizedDaily({ words, phrases, grammar, story, mistakes }: { words: number; phrases: number; grammar: number; story: boolean; mistakes: number }): Content {
  const base = prototypeDaily();
  const take = (key: string, n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ ...listOf(base, key)[i % listOf(base, key).length], itemId: `${prefix}${i}` }));
  return {
    ...base,
    words: take('words', words, 'w'),
    phrases: take('phrases', phrases, 'p'),
    grammar: take('grammar', grammar, 'g'),
    story: story ? base.story : null,
    mistakes: take('mistakes', mistakes, 'm'),
  };
}

/** A digest of that size with `review` units forgotten in its range. */
export function sizedDigest(size: Parameters<typeof sizedDaily>[0] & { review: number }): Content {
  const recap = listOf(prototypeDigest(), 'review');
  return {
    ...sizedDaily(size),
    range: { start: '2026-11-18', end: '2026-11-24' },
    review: Array.from({ length: size.review }, (_, i) => ({ ...recap[i % recap.length], itemId: `r${i}` })),
  };
}

export interface RenderedSize {
  name: string;
  kind: 'daily' | 'digest' | 'extend';
  content: Content;
  pages: number;
}

/** Typical and edge sizes, away from page boundaries, with their rendered page counts. */
export function renderedSizes(): RenderedSize[] {
  return [
    { name: 'the prototype daily material', kind: 'daily', content: prototypeDaily(), pages: 3 },
    { name: 'the prototype digest', kind: 'digest', content: prototypeDigest(), pages: 3 },
    { name: 'the prototype extension', kind: 'extend', content: prototypeExtend(), pages: 2 },
    { name: 'a light day (3 words and a story)', kind: 'daily', content: sizedDaily({ words: 3, phrases: 0, grammar: 0, story: true, mistakes: 0 }), pages: 2 },
    { name: 'one word', kind: 'daily', content: sizedDaily({ words: 1, phrases: 0, grammar: 0, story: false, mistakes: 0 }), pages: 1 },
    { name: 'a busy day (9 words, 4 phrases, 2 grammar points)', kind: 'daily', content: sizedDaily({ words: 9, phrases: 4, grammar: 2, story: true, mistakes: 2 }), pages: 4 },
    { name: 'a full day (the daily caps)', kind: 'daily', content: sizedDaily({ words: 12, phrases: 6, grammar: 4, story: true, mistakes: 5 }), pages: 5 },
    { name: 'a digest of only forgotten units', kind: 'digest', content: sizedDigest({ words: 0, phrases: 0, grammar: 0, story: false, mistakes: 0, review: 6 }), pages: 1 },
    { name: 'a busy week', kind: 'digest', content: sizedDigest({ words: 12, phrases: 4, grammar: 3, story: true, mistakes: 4, review: 6 }), pages: 5 },
    { name: 'a short extension (no passage, no grammar)', kind: 'extend', content: { ...prototypeExtend(), passage: null, grammar: null }, pages: 1 },
  ];
}
