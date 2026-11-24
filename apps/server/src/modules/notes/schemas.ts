import { ULID_RE } from '@t-cli/core/ulid';
import { z } from 'zod';
import { LEMMA_MAX_CHARS } from '../lookup/lexicon.ts';
import { UtcOffsetMinutes } from '../review/common.ts';

/**
 * Request shapes of the notebook (docs/api-v1.md, "v2 → Notes"). Text is
 * normalised here, so what is compared (409) and stored is always the same
 * form: words and phrases with whitespace collapsed and curly quotes
 * straightened, sentences trimmed.
 */

export const NOTE_KINDS = ['word', 'phrase', 'sentence'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteStars = 1 | 2 | 3 | 4;

/** Word and phrase notes, in code points (after normalising). */
export const TERM_MAX_CHARS = 64;
export const SENTENCE_MAX_CHARS = 2000;
export const TRANSLATION_MAX_CHARS = 2000;
export const LIST_MAX_LIMIT = 100;
export const CHANGES_MAX_LIMIT = 500;

const codePoints = (value: string): number => [...value].length;
const straightQuotes = (value: string): string => value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const collapse = (value: string): string => value.trim().replace(/\s+/g, ' ');
/** A word or phrase as stored: whitespace collapsed, curly quotes straightened. */
export const normalizeTerm = (value: string): string => collapse(straightQuotes(value));

const Ulid = z.string().regex(ULID_RE, 'must be a ULID');

/** `PUT /v1/notes/:id`: the id is the client's ULID. */
export const PutNoteParams = z.object({ id: Ulid });
/** `DELETE /v1/notes/:id`: any id; one that is not the caller's note is simply 404. */
export const DeleteNoteParams = z.object({ id: z.string().min(1).max(64) });

/** A validated note write, normalised. `lemma` is undefined for sentences. */
export interface NoteInput {
  kind: NoteKind;
  text: string;
  translation: string | undefined;
  lang: 'en';
  stars: NoteStars;
  entryId: string | undefined;
  lemma: string | undefined;
}

type Issue = { path: string; message: string };

/** The kind-dependent rules for `text` (null = valid). */
function textIssue(kind: NoteKind, text: string): string | null {
  if (text === '') return 'must not be empty';
  if (kind === 'sentence') return codePoints(text) > SENTENCE_MAX_CHARS ? `must be at most ${SENTENCE_MAX_CHARS} characters` : null;
  if (codePoints(text) > TERM_MAX_CHARS) return `must be at most ${TERM_MAX_CHARS} characters`;
  return /\p{Script=Latin}/u.test(text) ? null : 'must contain a Latin letter';
}

function bodyIssues(input: NoteInput): Issue[] {
  const issues: Issue[] = [];
  const text = textIssue(input.kind, input.text);
  if (text) issues.push({ path: 'text', message: text });
  if (input.translation !== undefined && codePoints(input.translation) > TRANSLATION_MAX_CHARS) {
    issues.push({ path: 'translation', message: `must be at most ${TRANSLATION_MAX_CHARS} characters` });
  }
  if (input.lemma !== undefined && (input.lemma === '' || codePoints(input.lemma) > LEMMA_MAX_CHARS)) {
    issues.push({ path: 'lemma', message: `must be 1–${LEMMA_MAX_CHARS} characters` });
  }
  return issues;
}

/**
 * `PUT /v1/notes/:id` body. Strict (unknown keys → 400). An empty
 * translation counts as absent; `lemma` is ignored for sentences.
 */
export const PutNoteBody = z
  .strictObject({
    kind: z.enum(NOTE_KINDS),
    text: z.string(),
    translation: z.string().optional(),
    lang: z.literal('en'),
    stars: z.number().int().min(1).max(4),
    entryId: Ulid.optional(),
    lemma: z.string().optional(),
  })
  .transform((body, ctx): NoteInput => {
    const isSentence = body.kind === 'sentence';
    const translation = body.translation?.trim();
    const input: NoteInput = {
      kind: body.kind,
      text: isSentence ? body.text.trim() : normalizeTerm(body.text),
      translation: translation ? translation : undefined,
      lang: body.lang,
      stars: body.stars as NoteStars,
      entryId: body.entryId,
      lemma: isSentence || body.lemma === undefined ? undefined : normalizeTerm(body.lemma),
    };
    for (const issue of bodyIssues(input)) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    return input;
  });

/** `GET /v1/notes`: live notes, newest first. */
export const ListNotesQuery = z.object({
  kind: z.enum(NOTE_KINDS).optional(),
  stars: z.coerce.number().int().min(1).max(4).optional(),
  before: Ulid.optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(30),
});
export type ListNotesQuery = z.infer<typeof ListNotesQuery>;

/** `GET /v1/notes/changes`: every change after a seq cursor. */
export const NoteChangesQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(CHANGES_MAX_LIMIT).default(200),
});

/** `GET /v1/notes/summary`: the week starts on the caller's local Monday. */
export const NoteSummaryQuery = z.object({ utcOffsetMinutes: UtcOffsetMinutes });
