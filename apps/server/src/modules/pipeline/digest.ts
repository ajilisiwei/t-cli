import { addDays, localDayRange } from './dates.ts';
import { DIGEST_CAPS, type DigestMaterial, type ReviewRecap } from './learnContent.ts';
import type { RunContext } from './llmJson.ts';
import { forgottenInRange, materialExists, saveMaterial, type ReadyItem } from './materialData.ts';
import { composeMaterial, type MaterialOptions, type MaterialOutcome } from './materials.ts';
import { clip } from './text.ts';

/**
 * 每周模式的 7 天合集 (docs/api-v1.md, "v3 → Materials" and "v3 →
 * Pipeline", step 3 `weekly`): a daily material over the seven local days
 * ending on `date` (DIGEST_CAPS), plus `review` — the units forgotten (忘记)
 * in review during the range. Always built for an active account; a week
 * without new units consists of its `review`.
 */

export const DIGEST_DAYS = 7;
const GLOSS_MAX = 120;

/** The first meaning in the explanation language: a word's first sense, a phrase's meaning, a grammar point's rule. */
export function glossOf(item: ReadyItem): string {
  const { parsed } = item;
  if (parsed.type === 'word') return parsed.content.meanings[0]?.zh ?? '';
  if (parsed.type === 'phrase') return clip(parsed.content.zh, GLOSS_MAX);
  return clip(parsed.content.rule, GLOSS_MAX);
}

/** The digest ending on `date` (its last day), unless it exists. */
export async function buildDigest(ctx: RunContext, date: string, options: MaterialOptions): Promise<MaterialOutcome> {
  const { db, userId, utcOffsetMinutes } = ctx;
  if (await materialExists(db, userId, 'digest', date)) return 'exists';
  const start = addDays(date, 1 - DIGEST_DAYS);
  const range = localDayRange(start, utcOffsetMinutes, DIGEST_DAYS);
  const material = await composeMaterial(ctx, { date, range, caps: DIGEST_CAPS, options });
  const review: ReviewRecap[] = (await forgottenInRange(db, userId, range, DIGEST_CAPS.review)).map(({ item, lapses }) => ({
    itemId: item.id,
    display: item.display,
    gloss: glossOf(item),
    lapses,
  }));
  const digest: DigestMaterial = { ...material, range: { start, end: date }, review };
  await saveMaterial(ctx, 'digest', date, digest);
  return 'created';
}
