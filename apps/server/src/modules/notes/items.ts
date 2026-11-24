import { and, eq, isNull, sql } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import type { Executor } from '../../db/client.ts';
import { items, lexicon, notes } from '../../db/schema.ts';
import { LEARNING_LANG, LEXICON_VERSION, lexiconKey } from '../lookup/lexicon.ts';
import { parseSentenceContent } from '../pipeline/cards.ts';
import { writeContent, type ItemRow } from '../pipeline/repo.ts';
import type { ExplanationLang } from '../pipeline/schemas.ts';
import { phraseKey } from '../pipeline/text.ts';
import { rescheduleItems } from '../review/cards.ts';
import { retentionFor } from '../review/fsrs.ts';
import { sentenceKey, wordContentFromLexicon } from './content.ts';
import type { NoteKind } from './schemas.ts';

/**
 * The learning unit behind a note (docs/api-v1.md, "v2 → Notes"), always in
 * the note's transaction. Lock order per item: the item row, then its cards
 * (as the pipeline's content writes), after the account row the note write
 * already holds.
 *
 * Notes write no item_sources row and never touch lookupCount: records are
 * linked by the nightly pipeline as before.
 */

/** What of a note decides its item. */
export interface NoteForItem {
  kind: NoteKind;
  text: string;
  translation: string | null;
  lemma: string | null;
}

export interface LinkContext {
  userId: string;
  explanationLang: ExplanationLang;
  now: Date;
}

/** The (user, type, normKey) item, created `pending` when missing; locks its row either way. */
async function upsertItem(
  tx: Executor,
  { userId, now }: LinkContext,
  { type, normKey, display }: { type: NoteKind; normKey: string; display: string },
): Promise<ItemRow> {
  const [row] = await tx
    .insert(items)
    .values({ userId, id: ulid(), type, normKey, display, status: 'pending', firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now })
    // A no-op update, so the existing row comes back (and is locked) too.
    .onConflictDoUpdate({ target: [items.userId, items.type, items.normKey], set: { updatedAt: sql`${items.updatedAt}` } })
    .returning();
  if (!row) throw new Error('item upsert returned nothing');
  return row;
}

/**
 * A word item without content yet gets it from the lexicon entry of its key
 * (the account's explanation language, the current version), and its cards
 * now. No entry, or one that does not make valid content → it stays as it is
 * for the nightly pipeline. The lexicon is shared and has no user_id.
 */
async function fillWordFromLexicon(tx: Executor, ctx: LinkContext, item: ItemRow): Promise<void> {
  if (item.content !== null) return;
  const [entry] = await tx
    .select({ content: lexicon.content, model: lexicon.model })
    .from(lexicon)
    .where(
      and(
        eq(lexicon.lang, LEARNING_LANG),
        eq(lexicon.explainLang, ctx.explanationLang),
        eq(lexicon.lemma, item.normKey),
        eq(lexicon.version, LEXICON_VERSION),
      ),
    );
  const content = entry ? wordContentFromLexicon(entry.content) : null;
  if (!entry || !content) return;
  await writeContent(tx, ctx.userId, item, { type: 'word', content }, { model: entry.model, now: ctx.now });
}

/**
 * A sentence item: content `{ text, translation }` from the note, `ready`,
 * one recall card when there is a translation. A later translation replaces
 * the stored one and rewrites the card's faces (same card, progress kept).
 */
async function linkSentence(tx: Executor, ctx: LinkContext, note: NoteForItem): Promise<string> {
  const item = await upsertItem(tx, ctx, { type: 'sentence', normKey: sentenceKey(note.text), display: note.text });
  const stored = parseSentenceContent(item.content);
  const content = { text: stored?.text ?? note.text, translation: note.translation ?? stored?.translation ?? null };
  if (item.status !== 'ready' || stored?.text !== content.text || stored.translation !== content.translation) {
    await writeContent(tx, ctx.userId, item, { type: 'sentence', content }, { model: null, now: ctx.now });
  }
  return item.id;
}

/**
 * Find or create the note's item and return its id: a word item keyed by the
 * lemma key of `lemma ?? text` (the key the pipeline and the lexicon use), a
 * phrase item by the pipeline's phrase key, a sentence item by the hash of
 * its text.
 */
export async function linkItem(tx: Executor, ctx: LinkContext, note: NoteForItem): Promise<string> {
  if (note.kind === 'sentence') return linkSentence(tx, ctx, note);
  const term = note.lemma ?? note.text;
  const normKey = note.kind === 'word' ? lexiconKey(term) : phraseKey(term);
  const item = await upsertItem(tx, ctx, { type: note.kind, normKey, display: term });
  if (note.kind === 'word') await fillWordFromLexicon(tx, ctx, item);
  return item.id;
}

/**
 * Set `items.stars` to the highest stars of the item's live notes (0 when
 * none is left). When that changes the cards' retention, their stored
 * schedule is re-derived from their logs (progress kept).
 */
export async function refreshStars(
  tx: Executor,
  { userId, now, importanceReview, masteredDays }: { userId: string; now: Date; importanceReview: boolean; masteredDays: number },
  itemId: string,
): Promise<void> {
  const thisItem = and(eq(items.userId, userId), eq(items.id, itemId));
  const [current] = await tx.select({ stars: items.stars }).from(items).where(thisItem).for('update');
  if (!current) return;
  const [highest] = await tx
    .select({ stars: sql<number>`coalesce(max(${notes.stars}), 0)::int` })
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.itemId, itemId), isNull(notes.deletedAt)));
  const stars = highest?.stars ?? 0;
  if (stars === current.stars) return;
  await tx.update(items).set({ stars, updatedAt: now }).where(thisItem);
  if (retentionFor(current.stars, importanceReview) !== retentionFor(stars, importanceReview)) {
    await rescheduleItems(tx, userId, [itemId], masteredDays);
  }
}
