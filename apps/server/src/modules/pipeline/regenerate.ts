import { AppError, loggableError, notFound } from '../../http/errors.ts';
import type { ItemRegenerator } from '../../ports.ts';
import { localDateOf } from './dates.ts';
import { generateItems } from './generate.ts';
import { createTokenBudget, type RunContext } from './llmJson.ts';
import { accountSettings, getItem, markNeedsRegen } from './repo.ts';
import type { PipelineDeps } from './run.ts';

/**
 * "内容有误" (docs/api-v1.md, `POST /v1/cards/:id/report`): regenerate one
 * item's content and rewrite the faces of its existing cards in place (same
 * ids, FSRS fields untouched), then mark it ready and unsuspend the cards.
 * On failure the item stays `needs_regen`, its cards stay suspended, an alert
 * goes out and the promise rejects. Tokens count as pipeline tokens.
 */
export function createRegenerator(deps: Omit<PipelineDeps, 'log'>): ItemRegenerator {
  return {
    async regenerate(userId, itemId) {
      const item = await getItem(deps.db, userId, itemId);
      const settings = item ? await accountSettings(deps.db, userId) : null;
      if (!item || !settings) throw notFound('item');
      const now = deps.clock();
      const ctx: RunContext = {
        db: deps.db,
        llm: deps.llm,
        model: deps.config.DEEPSEEK_MODEL,
        userId,
        lang: settings.lang,
        utcOffsetMinutes: settings.utcOffsetMinutes,
        now,
        usageDay: localDateOf(now, settings.utcOffsetMinutes),
        budget: createTokenBudget(deps.config.AI_PIPELINE_TOKENS_PER_RUN),
        signal: new AbortController().signal,
      };

      let failure: string;
      try {
        const result = await generateItems(ctx, [item]);
        if (result.generated === 1) return;
        failure = 'content failed validation';
      } catch (error) {
        await markNeedsRegen(deps.db, userId, [itemId], deps.clock());
        failure = error instanceof AppError ? `AppError:${error.code}` : loggableError(error).errName;
      }
      await deps.alerter
        .alert('item_needs_regen', `regeneration of item ${itemId} (account ${userId}) failed: ${failure}`)
        .catch(() => undefined);
      throw new Error(`item regeneration failed: ${failure}`);
    },
  };
}
