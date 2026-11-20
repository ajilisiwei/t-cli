import type { ItemContent, ItemType } from './schemas.ts';
import { findTarget } from './text.ts';

/**
 * Review cards derived from item content (docs/api-v1.md, "Content shapes",
 * the cardType table). Pure: the same content always gives the same faces,
 * so regeneration can rewrite an existing card's faces in place.
 */

export type CardType = 'recognize' | 'produce' | 'cloze' | 'fix';

/** One shape for every face, so clients render all card types the same way. */
export type CardFace = { text: string; ipa?: string; sub?: string; example?: { en: string; zh: string } };

export interface CardSpec {
  cardType: CardType;
  front: CardFace;
  back: CardFace;
}

export const CARD_TYPES: Readonly<Record<ItemType, readonly CardType[]>> = {
  word: ['recognize', 'produce', 'cloze'],
  phrase: ['cloze'],
  grammar: ['fix'],
};

type Example = { en: string; zh: string };

/** A cloze card from the first example that contains `target` (validation guarantees one does). */
function clozeCard(examples: readonly Example[], target: string): { spec: CardSpec; used: Example } {
  for (const example of examples) {
    const hit = findTarget(example.en, target);
    if (!hit) continue;
    const blanked = `${example.en.slice(0, hit.index)}____${example.en.slice(hit.index + hit.text.length)}`;
    return {
      spec: { cardType: 'cloze', front: { text: blanked, sub: example.zh }, back: { text: example.en, sub: hit.text } },
      used: example,
    };
  }
  throw new Error('no example contains the cloze target');
}

export function cardsFor(item: ItemContent): CardSpec[] {
  if (item.type === 'word') {
    const { headword, ipa, meanings, examples } = item.content;
    const meaningText = meanings.map((meaning) => `${meaning.pos} ${meaning.zh}`).join('\n');
    const cloze = clozeCard(examples, headword);
    // The recognize card shows the other example, so the two cards do not repeat each other.
    const shown = examples.find((example) => example !== cloze.used) ?? cloze.used;
    return [
      {
        cardType: 'recognize',
        front: { text: headword, ipa },
        back: { text: meaningText, example: { en: shown.en, zh: shown.zh } },
      },
      { cardType: 'produce', front: { text: meaningText }, back: { text: headword, ipa } },
      cloze.spec,
    ];
  }
  if (item.type === 'phrase') {
    return [clozeCard(item.content.examples, item.content.phrase).spec];
  }
  const { wrong, right, rule } = item.content;
  return [{ cardType: 'fix', front: { text: wrong }, back: { text: right, sub: rule } }];
}
