/**
 * Notebook endpoints (docs/api-v1.md, "v2" → "Notes"): save or update a note
 * (`PUT /v1/notes/:id`, id = a client ULID, so a retry never creates a second
 * note) and read the notebook (`GET /v1/notes`). Calls go through the sync
 * client's authorized `request`.
 *
 * Responses are external data: they are shape-checked here, and anything
 * malformed becomes a `BAD_RESPONSE` SyncError. Nothing here prints.
 */
import { ULID_RE } from '@t-cli/core/ulid';
import { SyncError } from './client.js';
import { NOTE_KINDS } from '../utils/notebookText.js';

/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/** @typedef {import('../utils/noteDraft.js').NoteKind} NoteKind */
/** @typedef {import('../utils/noteDraft.js').NoteDraft} NoteDraft */
/**
 * @typedef {{ id: string, kind: NoteKind, text: string, translation: string|null, stars: number,
 *             lemma: string|null, entryId: string|null, createdAt: string, updatedAt: string }} Note
 * @typedef {{ notes: Note[], nextBefore: string|null, hasMore: boolean }} NotesPage
 */

/** Notes per /notebook page. */
export const NOTEBOOK_PAGE_SIZE = 20;

/**
 * Save a note, or update the stars of the note with this id.
 * @param {SyncClient} client
 * @param {string} id client ULID
 * @param {NoteDraft & { stars: number, entryId?: string|null }} fields
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Note>} the stored note
 */
export async function saveNote(client, id, { kind, text, translation, stars, entryId }, { signal } = {}) {
  if (!ULID_RE.test(id)) throw new TypeError(`note id must be a ULID: ${id}`);
  /** @type {Record<string, unknown>} */
  const body = { kind, text, lang: 'en', stars };
  if (translation) body.translation = translation;
  if (entryId && ULID_RE.test(entryId)) body.entryId = entryId;
  const data = await client.request('PUT', `/v1/notes/${id}`, { body, signal });
  const note = isRecord(data) ? toNote(data.note) : null;
  if (!note) throw badResponse('malformed note');
  return note;
}

/**
 * The newest notes first (live notes only).
 * @param {SyncClient} client
 * @param {{ kind?: NoteKind|null, before?: string|null, limit?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<NotesPage>}
 */
export async function fetchNotes(client, { kind = null, before = null, limit = NOTEBOOK_PAGE_SIZE, signal } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (kind) query.set('kind', kind);
  if (before) query.set('before', before);
  const data = await client.request('GET', `/v1/notes?${query}`, { signal });
  if (!isRecord(data) || !Array.isArray(data.notes)) throw badResponse('malformed notebook');
  const notes = data.notes.map(toNote).filter((note) => note !== null);
  const hasMore = data.hasMore === true;
  return { notes, hasMore, nextBefore: hasMore && typeof data.nextBefore === 'string' ? data.nextBefore : null };
}

/**
 * @param {unknown} value
 * @returns {Note | null}
 */
export function toNote(value) {
  if (!isRecord(value)) return null;
  const { id, kind, text, stars } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof kind !== 'string' || !NOTE_KINDS.includes(/** @type {NoteKind} */ (kind))) return null;
  if (typeof text !== 'string' || text.trim() === '') return null;
  if (!Number.isInteger(stars) || stars < 1 || stars > 4) return null;
  return Object.freeze({
    id,
    kind: /** @type {NoteKind} */ (kind),
    text,
    translation: nonEmpty(value.translation),
    stars: /** @type {number} */ (stars),
    lemma: nonEmpty(value.lemma),
    entryId: nonEmpty(value.entryId),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  });
}

/** @param {unknown} value @returns {string|null} */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** @param {string} message @returns {SyncError} */
function badResponse(message) {
  return new SyncError({ kind: 'protocol', code: 'BAD_RESPONSE', message });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
