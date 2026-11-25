import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { materialDocument } from '../src/modules/export/assemble.ts';
import { parseMaterial } from '../src/modules/export/content.ts';
import { createTypstRenderer } from '../src/modules/export/renderer.ts';
import { MATERIAL_PARTS, type WordNote } from '../src/modules/export/sections.ts';
import { estimatePages } from '../src/modules/library/materialPages.ts';
import { exercisesOf } from '../src/modules/library/materialView.ts';
import { skipWithoutTypst, TYPST_BIN, TYPST_FONT_PATH } from './helpers/exportFixtures.ts';
import { renderedSizes } from './helpers/materialSizes.ts';

/**
 * The list's page estimate against the real templates through Typst
 * (skipped without TYPST_BIN and TYPST_FONT_PATH): each size renders at the
 * page count recorded in helpers/materialSizes.ts, and the estimate says so.
 * A template change that moves them apart fails here; refit the heights in
 * library/materialPages.ts then.
 */

describe('material page estimates vs Typst renders', { skip: skipWithoutTypst }, () => {
  const renderer = createTypstRenderer({ bin: TYPST_BIN, fontPath: TYPST_FONT_PATH });
  const options = { layout: 'practice', ipa: true, large: false, today: '2026-11-25', parts: new Set(MATERIAL_PARTS) } as const;

  for (const size of renderedSizes()) {
    test(size.name, async () => {
      const material = parseMaterial(size.kind, '2026-11-24', size.content);
      assert.ok(material, 'the fixture parses');
      // Words in a material usually carry a note (查过 2 次); it does not change the count.
      const units = material.kind === 'extend' ? [] : [...material.content.words, ...material.content.phrases];
      const notes = new Map<string, WordNote>(units.map((unit) => [unit.itemId, { stars: 0, lookupCount: 2, lapses: 0 }]));
      const { pages } = await renderer.render(materialDocument([material], { ...options, notes }));
      assert.equal(pages, size.pages, 'rendered pages');
      assert.equal(estimatePages(size.kind, size.content, exercisesOf({ kind: size.kind, content: size.content })), pages, 'estimate');
    });
  }
});
