/**
 * Glue for /note and /notebook. The REPL injects how to talk to the user
 * (`say`, the message log) and how to show a spinner (`withLoading`), and
 * owns the last result; nothing here touches stdin/stdout.
 *
 * Notes live in the account only (no local notebook): sync off and logged
 * out get a short message, and a failed save keeps the note id, so running
 * /note again retries the same note.
 */
import { ulid } from '@t-cli/core/ulid';
import { fetchNotes, saveNote } from './notebook.js';
import { syncOffLines } from './status.js';
import { NOTHING_YET, draftNote } from '../utils/noteDraft.js';
import { formatNotebook, formatSavedNote, parseNotebookKind, parseStarsArg } from '../utils/notebookText.js';

/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/** @typedef {import('./settings.js').ServerSetting} ServerSetting */
/** @typedef {import('../utils/noteDraft.js').LastResult} LastResult */
/** @typedef {(text: string, options?: { color?: string, dim?: boolean, bold?: boolean }) => void} Say */
/** @typedef {<T>(label: string, task: () => Promise<T>) => Promise<T>} WithLoading */

const DEFAULT_STARS = 1;
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {{ client: SyncClient | null, server: ServerSetting, say: Say, withLoading: WithLoading,
 *           mintId?: () => string }} deps
 */
export function createNotebookCommands({ client, server, say, withLoading, mintId = ulid }) {
  const tip = (text) => say(text, { color: 'yellow' });

  /**
   * The client when logged in; otherwise says why not and returns null.
   * @param {string} command what to run again after /login
   * @returns {SyncClient | null}
   */
  function accountClient(command) {
    if (!client) {
      for (const line of syncOffLines(server)) tip(line);
      return null;
    }
    if (!client.getAuth()) {
      tip(`Not logged in. The notebook is kept in your account: run /login first, then ${command} again.`);
      return null;
    }
    return client;
  }

  /**
   * /note [1-4]: save the last result as a note, or set the stars of the note
   * it was saved as. Returns the last result to keep (with its note id and
   * stars); the caller stores it.
   * @param {string} arg
   * @param {LastResult | null} lastResult
   * @returns {Promise<LastResult | null>}
   */
  async function runNote(arg, lastResult) {
    const parsed = parseStarsArg(arg);
    if (!parsed.ok) {
      tip('Tip: Use /note to save the last result (1 star), or /note <1-4> to set its stars.');
      return lastResult;
    }
    const api = accountClient('/note');
    if (!api) return lastResult;
    if (!lastResult) {
      tip(NOTHING_YET);
      return lastResult;
    }
    const draft = draftNote(lastResult);
    if (!draft.ok) {
      tip(draft.reason);
      return lastResult;
    }

    const stars = parsed.stars ?? lastResult.stars ?? DEFAULT_STARS;
    // Minted once per result and kept even when the save fails: a retry or a
    // later star change PUTs the same id, so it never creates a second note.
    const withId = { ...lastResult, noteId: lastResult.noteId ?? mintId() };
    let note;
    try {
      note = await withLoading('Saving to your notebook...', () => saveNote(api, withId.noteId, {
        ...draft.note,
        stars,
        entryId: lastResult.entryId,
      }));
    } catch (error) {
      say(`Could not save the note: ${errorMessage(error)}. Run /note again to retry.`, { color: 'red' });
      return withId;
    }
    say(formatSavedNote(note, lastResult.stars), { color: 'green' });
    return { ...withId, stars: note.stars };
  }

  /**
   * /notebook [word|phrase|sentence]: the newest notes, with their stars.
   * @param {string} arg
   */
  async function runNotebook(arg) {
    const parsed = parseNotebookKind(arg);
    if (!parsed.ok) {
      tip('Tip: Use /notebook, or /notebook word | phrase | sentence.');
      return;
    }
    const api = accountClient('/notebook');
    if (!api) return;
    let page;
    try {
      page = await withLoading('Loading your notebook...', () => fetchNotes(api, { kind: parsed.kind }));
    } catch (error) {
      say(`Could not load the notebook: ${errorMessage(error)}`, { color: 'red' });
      return;
    }
    for (const block of formatNotebook(page, parsed.kind)) {
      say(block.text, { color: 'cyan', bold: Boolean(block.bold), dim: Boolean(block.dim) });
    }
  }

  return { runNote, runNotebook };
}
