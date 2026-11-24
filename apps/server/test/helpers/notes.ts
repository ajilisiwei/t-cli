import type { FastifyInstance } from 'fastify';
import { ulid } from '@t-cli/core/ulid';
import type { Database } from '../../src/db/client.ts';
import { lexicon } from '../../src/db/schema.ts';
import { LEXICON_VERSION, type LexiconEntry } from '../../src/modules/lookup/lexicon.ts';
import type { TestAccount } from './fixtures.ts';

/** Test support for the notebook: a valid lexicon entry, seeding it, and the note routes. */

export function lexiconEntry(lemma: string, overrides: Partial<LexiconEntry> = {}): LexiconEntry {
  return {
    lemma,
    ipa: { us: '/dɪˈsɪʒən/', uk: '/dɪˈsɪʒn/' },
    senses: [
      { pos: 'n.', gloss: '决定', def: 'A choice that you make after thinking about it.' },
      { pos: 'n.', gloss: '果断', def: 'The ability to decide things quickly.' },
    ],
    forms: [
      { label: '复数', form: `${lemma}s` },
      { label: '动词', form: 'decide' },
    ],
    collocations: [
      { text: `make a ${lemma}`, gloss: '做出决定' },
      { text: `a final ${lemma}`, gloss: '最终决定' },
    ],
    examples: [
      { text: `It was a hard ${lemma} to make.`, gloss: '这是个艰难的决定。' },
      { text: `We reached the ${lemma} together.`, gloss: '我们一起做出了决定。' },
      { text: `A third ${lemma} example.`, gloss: '第三个例句。' },
    ],
    contrasts: [{ word: 'choice', note: 'choice 强调在选项中挑选' }],
    memory: '',
    ...overrides,
  };
}

/**
 * Store a lexicon row under its lemma's key (lowercased lemma), as the lookup
 * does. The lexicon is site-wide (no user_id), so tests sharing a database
 * may seed the same lemma: the first row wins, as with concurrent lookups.
 */
export async function seedLexicon(
  db: Database,
  entry: LexiconEntry,
  { explainLang = 'zh', version = LEXICON_VERSION, key = entry.lemma.toLowerCase() }: { explainLang?: string; version?: number; key?: string } = {},
): Promise<void> {
  await db
    .insert(lexicon)
    .values({ lang: 'en', explainLang, lemma: key, version, content: { ...entry }, model: 'lexicon-model' })
    .onConflictDoNothing();
}

export interface NoteBody {
  kind: 'word' | 'phrase' | 'sentence';
  text: string;
  translation?: string;
  lang?: string;
  stars?: number;
  entryId?: string;
  lemma?: string;
  [key: string]: unknown;
}

/** A Note as the API returns it. */
export interface NoteJson {
  id: string;
  kind: string;
  text: string;
  translation: string | null;
  lang: string;
  stars: number;
  lemma: string | null;
  entryId: string | null;
  itemId: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  level: 'new' | 'learning' | 'mastered' | null;
  task: 'translate' | 'check' | null;
}

export const putNote = (app: FastifyInstance, account: TestAccount, id: string, body: NoteBody) =>
  app.inject({ method: 'PUT', url: `/v1/notes/${id}`, headers: account.headers, payload: { lang: 'en', stars: 1, ...body } });

/** PUT a note and return it (fails the test on a non-200). */
export async function saveNote(app: FastifyInstance, account: TestAccount, body: NoteBody, id: string = ulid()): Promise<NoteJson> {
  const res = await putNote(app, account, id, body);
  if (res.statusCode !== 200) throw new Error(`PUT /v1/notes failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { data: { note: NoteJson } }).data.note;
}

export const deleteNote = (app: FastifyInstance, account: TestAccount, id: string) =>
  app.inject({ method: 'DELETE', url: `/v1/notes/${id}`, headers: account.headers });
