import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { parseStoredContent } from '../pipeline/schemas.ts';
import { parseMaterial, type LoadedMaterial } from './content.ts';
import type { ChecklistRow } from './document.ts';
import { glossOfMeanings, oneLine } from './format.ts';
import type { MaterialRef } from './request.ts';
import { MATERIAL_PARTS, type MaterialPart, type WordNote } from './sections.ts';

/**
 * Read-only queries of the PDF export. Every query filters on the caller's
 * user_id. `materials` is read with plain SQL: its `kind` column is text,
 * and `digest` / `extend` rows come from migration 0003 of the v3 pipeline.
 */

const DAY_MS = 86_400_000;
/** "Forgotten" window of the checklist and of the word notes. */
const LAPSE_WINDOW_DAYS = 30;
/** Checklist without materials: units forgotten at least this often in the window. */
const CHECKLIST_MIN_LAPSES = 2;
export const CHECKLIST_MAX_ROWS = 24;

/** The requested materials in request order, or the refs that do not exist (another account's included). */
export async function loadMaterials(
  db: Executor,
  userId: string,
  refs: readonly MaterialRef[],
): Promise<{ ok: true; materials: LoadedMaterial[] } | { ok: false; missing: MaterialRef[] }> {
  const wanted = sql.join(
    refs.map((ref) => sql`(kind = ${ref.kind} and date = ${ref.date}::date)`),
    sql` or `,
  );
  const rows = await db.execute<{ kind: string; date: string; content: unknown }>(sql`
    select kind, to_char(date, 'YYYY-MM-DD') as date, content
      from materials
     where user_id = ${userId} and (${wanted})`);
  const byKey = new Map(rows.map((row) => [`${row.kind}:${row.date}`, row.content]));
  const loaded = refs.map((ref) => ({ ref, material: parseMaterial(ref.kind, ref.date, byKey.get(`${ref.kind}:${ref.date}`)) }));
  const missing = loaded.filter((entry) => entry.material === null).map((entry) => entry.ref);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, materials: loaded.flatMap((entry) => (entry.material ? [entry.material] : [])) };
}

const PartsSetting = z.array(z.enum(MATERIAL_PARTS)).min(1);

/** settings.materialParts (docs/api-v1.md, "Settings (v3 keys)"); absent or invalid → all five. */
export async function materialParts(db: Executor, userId: string): Promise<ReadonlySet<MaterialPart>> {
  const [row] = await db
    .select({ settings: users.settings })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  const parsed = PartsSetting.safeParse(row?.settings.materialParts);
  return new Set(parsed.success ? parsed.data : MATERIAL_PARTS);
}

/** Why each item is in a material: its stars, lookups and 忘记 ratings in the last 30 days. */
export async function wordNotes(db: Executor, userId: string, itemIds: readonly string[], now: Date): Promise<Map<string, WordNote>> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return new Map();
  const since = new Date(now.getTime() - LAPSE_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await db.execute<{ id: string; stars: number; lookup_count: number; lapses: number }>(sql`
    select i.id, i.stars, i.lookup_count,
           (select count(*)::int from review_logs l
              join cards c on c.user_id = l.user_id and c.id = l.card_id
             where l.user_id = i.user_id and c.item_id = i.id
               and l.rating = 1 and l.reviewed_at >= ${since}::timestamptz) as lapses
      from items i
     where i.user_id = ${userId} and i.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  return new Map(rows.map((row) => [row.id, { stars: Number(row.stars), lookupCount: Number(row.lookup_count), lapses: Number(row.lapses) }]));
}

/**
 * 自测清单 without materials: the account's words and phrases with a
 * non-new card due before the end of the local day, and those rated 忘记 at
 * least twice in the last 30 days; most forgotten first, then earliest due;
 * at most 24. Suspended and mastered cards do not count as due.
 */
export async function checklistUnits(
  db: Executor,
  userId: string,
  { now, endOfToday }: { now: Date; endOfToday: Date },
): Promise<ChecklistRow[]> {
  const since = new Date(now.getTime() - LAPSE_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await db.execute<{ type: 'word' | 'phrase'; content: unknown; lapses: number }>(sql`
    with forgotten as (
      select c.item_id, count(*)::int as lapses
        from review_logs l join cards c on c.user_id = l.user_id and c.id = l.card_id
       where l.user_id = ${userId} and l.rating = 1 and l.reviewed_at >= ${since}::timestamptz
       group by c.item_id
    ), due as (
      select item_id, min(due) as due
        from cards
       where user_id = ${userId} and state <> 0 and not mastered and not suspended
         and due < ${endOfToday.toISOString()}::timestamptz
       group by item_id
    )
    select i.type, i.content, coalesce(f.lapses, 0) as lapses
      from items i
      left join forgotten f on f.item_id = i.id
      left join due d on d.item_id = i.id
     where i.user_id = ${userId} and i.type in ('word', 'phrase') and i.status = 'ready'
       and (d.item_id is not null or coalesce(f.lapses, 0) >= ${CHECKLIST_MIN_LAPSES})
     order by coalesce(f.lapses, 0) desc, d.due asc nulls last, i.display asc
     limit ${CHECKLIST_MAX_ROWS}`);
  return rows.flatMap((row): ChecklistRow[] => {
    const parsed = parseStoredContent(row.type, row.content);
    if (parsed?.type === 'word') {
      return [{ term: oneLine(parsed.content.headword), ipa: oneLine(parsed.content.ipa), gloss: glossOfMeanings(parsed.content.meanings) }];
    }
    if (parsed?.type === 'phrase') return [{ term: oneLine(parsed.content.phrase), ipa: '', gloss: oneLine(parsed.content.zh) }];
    return [];
  });
}
