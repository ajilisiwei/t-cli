import { validateContent, type ContentFailure } from './content.ts';
import { askInBatches, byRef, type RunContext } from './llmJson.ts';
import { generationMessages, type GenerationRequest } from './prompts.ts';
import {
  markNeedsRegen,
  saveContent,
  userCheckForGrammar,
  userSentenceForPhrase,
  userSentenceWithWord,
  type ItemRow,
} from './repo.ts';
import { GeneratedItemSchema, GenerationEnvelopeSchema, type ItemContent, type ItemType } from './schemas.ts';

/**
 * Step 2: content for items (new, or `needs_regen`), validated against the
 * contract's content shapes, then their cards. An item whose content stays
 * invalid after every attempt becomes `needs_regen`. Work is saved per batch,
 * so a run stopped by the token cap keeps what it finished.
 */

/** Items per call: a word's content is ~400 tokens; reasoning comes on top. */
const BATCH_SIZE: Readonly<Record<ItemType, number>> = { word: 6, phrase: 6, grammar: 4 };
const TYPES: readonly ItemType[] = ['word', 'phrase', 'grammar'];

export interface GenerationSummary {
  generated: number;
  /** Ids of items that are `needs_regen` after this run. */
  failedIds: string[];
  cardsCreated: number;
  cardsUpdated: number;
  /** Why answers were rejected (fixed codes), for the run log. */
  rejected: Partial<Record<ContentFailure | 'malformed', number>>;
}

interface Request {
  ref: string;
  item: ItemRow;
  payload: GenerationRequest;
  hasUserSentence: boolean;
}

async function buildRequest(ctx: RunContext, item: ItemRow, ref: string): Promise<Request> {
  if (item.type === 'word') {
    const userSentence = await userSentenceWithWord(ctx.db, ctx.userId, item.display);
    return { ref, item, payload: { ref, headword: item.display, ...(userSentence ? { userSentence } : {}) }, hasUserSentence: Boolean(userSentence) };
  }
  if (item.type === 'phrase') {
    const userSentence = await userSentenceForPhrase(ctx.db, ctx.userId, item.id);
    return { ref, item, payload: { ref, phrase: item.display, ...(userSentence ? { userSentence } : {}) }, hasUserSentence: Boolean(userSentence) };
  }
  const userCheck = await userCheckForGrammar(ctx.db, ctx.userId, item.id);
  return { ref, item, payload: { ref, key: item.normKey, title: item.display, ...(userCheck ? { userCheck } : {}) }, hasUserSentence: Boolean(userCheck) };
}

export async function generateItems(ctx: RunContext, rows: readonly ItemRow[]): Promise<GenerationSummary> {
  let summary: GenerationSummary = { generated: 0, failedIds: [], cardsCreated: 0, cardsUpdated: 0, rejected: {} };
  const reject = (reason: ContentFailure | 'malformed'): null => {
    summary = { ...summary, rejected: { ...summary.rejected, [reason]: (summary.rejected[reason] ?? 0) + 1 } };
    return null;
  };

  for (const type of TYPES) {
    const typed = rows.filter((row) => row.type === type);
    const requests: Request[] = [];
    for (const [i, row] of typed.entries()) requests.push(await buildRequest(ctx, row, `i${i + 1}`));

    await askInBatches<Request, ItemContent>(ctx, {
      requests,
      batchSize: BATCH_SIZE[type],
      messagesFor: (batch) => generationMessages(type, batch.map((request) => request.payload), ctx.lang),
      entriesOf: (answer) => {
        const envelope = GenerationEnvelopeSchema.safeParse(answer);
        return envelope.success ? byRef(envelope.data.items) : new Map();
      },
      validate: (request, raw) => {
        const entry = GeneratedItemSchema.safeParse(raw);
        if (!entry.success) return reject('malformed');
        const check = validateContent(entry.data.content, {
          type,
          display: request.item.display,
          lang: ctx.lang,
          hasUserSentence: request.hasUserSentence,
        });
        return check.ok ? check.value : reject(check.reason);
      },
      onBatch: async ({ done, failed }) => {
        for (const { request, value } of done) {
          const cards = await saveContent(ctx.db, ctx.userId, request.item, value, { model: ctx.model, now: ctx.now });
          summary = {
            ...summary,
            generated: summary.generated + 1,
            cardsCreated: summary.cardsCreated + cards.cardsCreated,
            cardsUpdated: summary.cardsUpdated + cards.cardsUpdated,
          };
        }
        const failedIds = failed.map((request) => request.item.id);
        await markNeedsRegen(ctx.db, ctx.userId, failedIds, ctx.now);
        summary = { ...summary, failedIds: [...summary.failedIds, ...failedIds] };
      },
    });
  }
  return summary;
}
