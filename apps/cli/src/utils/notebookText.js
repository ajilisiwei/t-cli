/**
 * Arguments and terminal text for /note and /notebook (docs/api-v1.md,
 * "Notes"). Pure: no I/O, no React. Output is a list of blocks; the REPL
 * appends each as one message.
 */

/** @typedef {import('./noteDraft.js').NoteKind} NoteKind */
/** @typedef {import('../sync/notebook.js').Note} Note */
/** @typedef {{ text: string, bold?: boolean, dim?: boolean }} Block */

export const STARS_MAX = 4;
export const NOTE_KINDS = /** @type {readonly NoteKind[]} */ (Object.freeze(['word', 'phrase', 'sentence']));
const KIND_LABELS = Object.freeze({ word: 'words', phrase: 'phrases', sentence: 'sentences' });
const TEXT_PREVIEW = 60;
const TRANSLATION_PREVIEW = 40;

/**
 * `/note [1-4]`: stars, or null when omitted (a new note gets 1, a saved one keeps its stars).
 * @param {string} arg
 * @returns {{ ok: true, stars: number|null } | { ok: false }}
 */
export function parseStarsArg(arg) {
  const value = (arg || '').trim();
  if (value === '') return { ok: true, stars: null };
  if (/^[1-4]$/.test(value)) return { ok: true, stars: Number(value) };
  return { ok: false };
}

/**
 * `/notebook [word|phrase|sentence]` (plurals accepted): the kind, or null for all.
 * @param {string} arg
 * @returns {{ ok: true, kind: NoteKind|null } | { ok: false }}
 */
export function parseNotebookKind(arg) {
  const value = (arg || '').trim().toLowerCase();
  if (value === '') return { ok: true, kind: null };
  const kind = NOTE_KINDS.find((k) => value === k || value === KIND_LABELS[k]);
  return kind ? { ok: true, kind } : { ok: false };
}

/**
 * "★★☆☆" for 2 of 4 stars (clamped to 1–4).
 * @param {number} stars
 * @returns {string}
 */
export function starMarks(stars) {
  const filled = Math.min(STARS_MAX, Math.max(1, Math.trunc(stars) || 1));
  return '★'.repeat(filled) + '☆'.repeat(STARS_MAX - filled);
}

/**
 * The confirmation after a save.
 * @param {Note} note
 * @param {number|null} previousStars the stars before this save (null: not saved before)
 * @returns {string}
 */
export function formatSavedNote(note, previousStars) {
  const what = `${starMarks(note.stars)}  ${preview(note.text, TEXT_PREVIEW)}`;
  if (previousStars === null) return `Saved to your notebook (${note.kind}): ${what}`;
  if (previousStars === note.stars) return `Already in your notebook (${note.kind}): ${what}`;
  return `Stars updated (${note.kind}): ${what}`;
}

/**
 * The notebook page, newest first; one line per note.
 * @param {{ notes: readonly Note[], hasMore: boolean }} page
 * @param {NoteKind|null} kind the filter, null for every kind
 * @returns {Block[]}
 */
export function formatNotebook({ notes, hasMore }, kind) {
  if (notes.length === 0) {
    return [
      { text: kind ? `No ${kind} notes yet.` : 'Your notebook is empty.' },
      { text: 'Use /note after a translation or /check to save it (/note 1-4 sets its stars).', dim: true },
    ];
  }
  const title = kind ? `Notebook · ${KIND_LABELS[kind]} (newest first)` : 'Notebook (newest first)';
  const rows = notes.map((note) => noteRow(note, kind === null));
  const footer = hasMore
    ? `Showing the newest ${notes.length}. The whole notebook is in the mini-program (笔记本).`
    : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}.`;
  return [{ text: title, bold: true }, { text: rows.join('\n') }, { text: footer, dim: true }];
}

/**
 * @param {Note} note
 * @param {boolean} withKind
 * @returns {string}
 */
function noteRow(note, withKind) {
  const kind = withKind ? `${note.kind.padEnd(8)}  ` : '';
  const translation = note.translation ? `  ${preview(note.translation, TRANSLATION_PREVIEW)}` : '';
  return `${starMarks(note.stars)}  ${kind}${preview(note.text, TEXT_PREVIEW)}${translation}`;
}

/**
 * One line, at most `max` code points (an ellipsis marks a cut).
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function preview(text, max) {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
