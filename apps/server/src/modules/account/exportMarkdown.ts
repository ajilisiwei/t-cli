import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { toIsoWithOffset } from '../../db/entriesRepo.ts';
import { entries, items } from '../../db/schema.ts';

/**
 * `POST /v1/export` (docs/api-v1.md, "Account"): every record grouped by the
 * local date it was made on (the record's own offset, as the CLI's history
 * files), then the learning units. Produced page by page as a stream of
 * Markdown chunks, so a large account never sits in memory at once.
 *
 * Inputs are quoted (`> `) so a line of user text can never become a heading;
 * outputs are the model's Markdown and are kept as written.
 */

export const EXPORT_PAGE_SIZE = 500;

const TASK_TITLES = { translate: 'Translation', check: 'Grammar Check' } as const;
const SOURCE_LABELS = { cli: 'CLI', mp: 'mini-program' } as const;
const TYPE_TITLES = { word: 'Words', phrase: 'Phrases', grammar: 'Grammar', sentence: 'Sentences' } as const;

const Example = z.object({ en: z.string(), zh: z.string() });
const WordContent = z.object({
  headword: z.string(),
  ipa: z.string().optional(),
  meanings: z.array(z.object({ pos: z.string(), zh: z.string() })).default([]),
  examples: z.array(Example).default([]),
  collocations: z.array(z.string()).default([]),
  synonyms: z.array(z.object({ word: z.string(), note: z.string() })).default([]),
  family: z.array(z.string()).default([]),
});
const PhraseContent = z.object({
  phrase: z.string(),
  zh: z.string(),
  register: z.string().optional(),
  alternatives: z.array(z.object({ en: z.string(), note: z.string() })).default([]),
  examples: z.array(Example).default([]),
});
const GrammarContent = z.object({
  title: z.string(),
  rule: z.string(),
  wrong: z.string(),
  right: z.string(),
  exercises: z.array(z.object({ wrong: z.string(), right: z.string() })).default([]),
});

export interface ExportSummary {
  entries: number;
  items: number;
}

/** Collapse line breaks so a value fits on one Markdown line. */
const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim();
const quote = (text: string): string => text.split(/\r?\n/).map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
const bullet = (lines: readonly string[]): string => lines.map((line) => `- ${oneLine(line)}`).join('\n');

type EntryRow = typeof entries.$inferSelect;
type ItemRow = Pick<typeof items.$inferSelect, 'id' | 'type' | 'display' | 'content' | 'lookupCount' | 'errorCount'>;

function renderEntry(row: EntryRow): { date: string; text: string } {
  const iso = toIsoWithOffset(row.createdAt, row.utcOffsetMinutes);
  const parts = [
    `#### [${iso.slice(11, 16)}] ${TASK_TITLES[row.task]} · ${SOURCE_LABELS[row.source]}`,
    '',
    '**Input:**',
    '',
    quote(row.input),
    '',
  ];
  if (row.correctedInput) parts.push(`**Corrected:** ${oneLine(row.correctedInput)}`, '');
  parts.push(row.output.trim(), '', '---', '', '');
  return { date: iso.slice(0, 10), text: parts.join('\n') };
}

function renderContent(type: ItemRow['type'], content: unknown): string[] {
  if (type === 'word') {
    const parsed = WordContent.safeParse(content);
    if (!parsed.success) return [];
    const c = parsed.data;
    return [
      ...(c.ipa ? [`IPA: ${oneLine(c.ipa)}`, ''] : []),
      bullet(c.meanings.map((m) => `${m.pos} ${m.zh}`)),
      ...(c.examples.length ? ['', '**Examples**', '', bullet(c.examples.map((e) => `${e.en} — ${e.zh}`))] : []),
      ...(c.collocations.length ? ['', `**Collocations:** ${c.collocations.map(oneLine).join('; ')}`] : []),
      ...(c.synonyms.length ? ['', '**Synonyms**', '', bullet(c.synonyms.map((s) => `${s.word}: ${s.note}`))] : []),
      ...(c.family.length ? ['', `**Word family:** ${c.family.map(oneLine).join(', ')}`] : []),
    ];
  }
  if (type === 'phrase') {
    const parsed = PhraseContent.safeParse(content);
    if (!parsed.success) return [];
    const c = parsed.data;
    return [
      `${oneLine(c.zh)}${c.register ? ` (${c.register})` : ''}`,
      ...(c.alternatives.length ? ['', '**Alternatives**', '', bullet(c.alternatives.map((a) => `${a.en} — ${a.note}`))] : []),
      ...(c.examples.length ? ['', '**Examples**', '', bullet(c.examples.map((e) => `${e.en} — ${e.zh}`))] : []),
    ];
  }
  if (type === 'sentence') {
    // v2 sentence notes: { text, translation } (docs/api-v1.md, "v2 → Notes").
    const translation = content && typeof content === 'object' && 'translation' in content ? content.translation : null;
    return typeof translation === 'string' && translation.trim() ? [oneLine(translation)] : [];
  }
  const parsed = GrammarContent.safeParse(content);
  if (!parsed.success) return [];
  const c = parsed.data;
  return [
    oneLine(c.rule),
    '',
    `- ✗ ${oneLine(c.wrong)}`,
    `- ✓ ${oneLine(c.right)}`,
    ...(c.exercises.length ? ['', '**Exercises**', '', bullet(c.exercises.map((e) => `${e.wrong} → ${e.right}`))] : []),
  ];
}

function renderItem(row: ItemRow): string {
  const counts = `Looked up ${row.lookupCount} × · mistakes ${row.errorCount}`;
  return [`#### ${oneLine(row.display)}`, '', `_${counts}_`, '', ...renderContent(row.type, row.content), '', ''].join('\n');
}

async function* entryPages(db: Executor, userId: string): AsyncGenerator<EntryRow[]> {
  for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
    const page = await db
      .select()
      .from(entries)
      .where(eq(entries.userId, userId))
      .orderBy(asc(entries.createdAt), asc(entries.seq))
      .limit(EXPORT_PAGE_SIZE)
      .offset(offset);
    if (page.length === 0) return;
    yield page;
    if (page.length < EXPORT_PAGE_SIZE) return;
  }
}

const TYPE_ORDER = sql`case ${items.type} when 'word' then 0 when 'phrase' then 1 when 'grammar' then 2 else 3 end`;

async function* itemPages(db: Executor, userId: string): AsyncGenerator<ItemRow[]> {
  for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
    const page = await db
      .select({ id: items.id, type: items.type, display: items.display, content: items.content, lookupCount: items.lookupCount, errorCount: items.errorCount })
      .from(items)
      .where(eq(items.userId, userId))
      .orderBy(TYPE_ORDER, asc(sql`lower(${items.display})`), asc(items.id))
      .limit(EXPORT_PAGE_SIZE)
      .offset(offset);
    if (page.length === 0) return;
    yield page;
    if (page.length < EXPORT_PAGE_SIZE) return;
  }
}

/**
 * The export as Markdown chunks. `summary` is filled in as the stream is
 * consumed (for the caller's log line).
 */
export async function* exportMarkdown(
  db: Executor,
  { userId, exportedAt, summary }: { userId: string; exportedAt: string; summary: ExportSummary },
): AsyncGenerator<string> {
  yield `# t-cli export\n\nExported ${exportedAt}.\n\n## Records\n\n`;
  let currentDate: string | null = null;
  for await (const page of entryPages(db, userId)) {
    let chunk = '';
    for (const row of page) {
      const { date, text } = renderEntry(row);
      if (date !== currentDate) {
        chunk += `### ${date}\n\n`;
        currentDate = date;
      }
      chunk += text;
      summary.entries += 1;
    }
    yield chunk;
  }
  if (summary.entries === 0) yield '_No records._\n\n';

  yield '## Learning units\n\n';
  let currentType: ItemRow['type'] | null = null;
  for await (const page of itemPages(db, userId)) {
    let chunk = '';
    for (const row of page) {
      if (row.type !== currentType) {
        chunk += `### ${TYPE_TITLES[row.type]}\n\n`;
        currentType = row.type;
      }
      chunk += renderItem(row);
      summary.items += 1;
    }
    yield chunk;
  }
  if (summary.items === 0) yield '_No learning units yet._\n';
}
