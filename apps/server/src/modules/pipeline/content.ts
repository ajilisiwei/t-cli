import {
  GrammarContentSchema,
  PhraseContentSchema,
  WordContentSchema,
  type ExplanationLang,
  type ItemContent,
  type ItemType,
} from './schemas.ts';
import { containsCjk, findTarget, phraseKey, wordKey } from './text.ts';

/**
 * Validation of generated item content beyond its shape: it must be about the
 * requested unit, have a usable cloze sentence, write explanations in the
 * account's language, and only mark examples `fromUser` when the learner's
 * own sentence was provided. Failures are fixed codes (never user text), so
 * they can be logged and counted.
 */

export interface ContentContext {
  type: ItemType;
  /** The item's display: headword, phrase, or grammar title. */
  display: string;
  lang: ExplanationLang;
  /** A sentence from the learner's own (non-paragraph) records was given to the model. */
  hasUserSentence: boolean;
}

export type ContentFailure =
  | 'schema'
  | 'headword_mismatch'
  | 'phrase_mismatch'
  | 'no_example_with_target'
  | 'explanation_lang'
  | 'unchanged_correction';

export type ContentCheck = { ok: true; value: ItemContent } | { ok: false; reason: ContentFailure };

type Example = { en: string; zh: string; fromUser: boolean };

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/** Without the learner's sentence nothing may claim to come from the learner. */
const fromUserAllowed = (examples: readonly Example[], allowed: boolean): Example[] =>
  examples.map((example) => ({ ...example, fromUser: allowed && example.fromUser }));

const inLang = (lang: ExplanationLang, texts: readonly string[]): boolean => lang !== 'zh' || texts.every(containsCjk);

export function validateContent(raw: unknown, ctx: ContentContext): ContentCheck {
  if (ctx.type === 'word') {
    const parsed = WordContentSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'schema' };
    const content = parsed.data;
    if (wordKey(content.headword) !== wordKey(ctx.display)) return { ok: false, reason: 'headword_mismatch' };
    if (!content.examples.some((example) => findTarget(example.en, ctx.display))) return { ok: false, reason: 'no_example_with_target' };
    const explanations = [...content.meanings.map((meaning) => meaning.zh), ...content.examples.map((example) => example.zh)];
    if (!inLang(ctx.lang, explanations)) return { ok: false, reason: 'explanation_lang' };
    return {
      ok: true,
      value: { type: 'word', content: { ...content, headword: ctx.display, examples: fromUserAllowed(content.examples, ctx.hasUserSentence) } },
    };
  }

  if (ctx.type === 'phrase') {
    const parsed = PhraseContentSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'schema' };
    const content = parsed.data;
    if (phraseKey(content.phrase) !== phraseKey(ctx.display)) return { ok: false, reason: 'phrase_mismatch' };
    if (!content.examples.some((example) => findTarget(example.en, ctx.display))) return { ok: false, reason: 'no_example_with_target' };
    if (!inLang(ctx.lang, [content.zh, ...content.examples.map((example) => example.zh)])) return { ok: false, reason: 'explanation_lang' };
    return {
      ok: true,
      value: { type: 'phrase', content: { ...content, phrase: ctx.display, examples: fromUserAllowed(content.examples, ctx.hasUserSentence) } },
    };
  }

  const parsed = GrammarContentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'schema' };
  const content = parsed.data;
  const pairs = [{ wrong: content.wrong, right: content.right }, ...content.exercises];
  if (pairs.some((pair) => sameText(pair.wrong, pair.right))) return { ok: false, reason: 'unchanged_correction' };
  if (!inLang(ctx.lang, [content.rule])) return { ok: false, reason: 'explanation_lang' };
  return { ok: true, value: { type: 'grammar', content } };
}

/** What lists show for an item once it has content (grammar items take the generated title). */
export function displayOf(item: ItemContent, fallback: string): string {
  return item.type === 'grammar' ? item.content.title : fallback;
}
