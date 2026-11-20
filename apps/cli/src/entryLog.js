/**
 * Local structured record log ("outbox") for the CLI.
 *
 * Every translation / grammar check is appended to `outbox.jsonl` as one
 * Entry (see @t-cli/core/entry), alongside the human-readable Markdown
 * history. The sync client (src/sync) pushes these lines to the server and
 * drops the acknowledged ones via `replaceOutboxContent`; entries the server
 * rejects for good are moved to `outbox.rejected.jsonl`.
 *
 * `sync-state.json` records `liveSince`: when the CLI first wrote a live
 * entry. The Markdown backfill only imports records older than that, so a
 * record is never imported twice (once live, once from Markdown).
 *
 * Nothing here writes to stdout/stderr — the Ink TUI owns the terminal.
 * Failures are returned to the caller instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createEntry, serializeEntry, parseEntryLine } from '@t-cli/core/entry';
import { getConfigDir } from './config.js';

/** @typedef {import('@t-cli/core/entry').Entry} Entry */
/** @typedef {{ ok: true } | { ok: false, error: string }} WriteResult */

export function getOutboxPath() {
  return path.join(getConfigDir(), 'outbox.jsonl');
}

export function getSyncStatePath() {
  return path.join(getConfigDir(), 'sync-state.json');
}

export function getRejectedPath() {
  return path.join(getConfigDir(), 'outbox.rejected.jsonl');
}

/**
 * Read sync state. Missing or corrupt files yield an empty state.
 * @returns {{ liveSince?: string }}
 */
export function readSyncState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSyncStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * When the CLI started writing live entries (ISO 8601), or null if never.
 * @returns {string | null}
 */
export function getLiveSince() {
  const { liveSince } = readSyncState();
  return typeof liveSince === 'string' && !Number.isNaN(Date.parse(liveSince)) ? liveSince : null;
}

/**
 * Merge a patch into sync state (written atomically via rename).
 * @param {Record<string, unknown>} patch
 * @returns {WriteResult}
 */
export function updateSyncState(patch) {
  try {
    const next = { ...readSyncState(), ...patch };
    const target = getSyncStatePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Append entries to the outbox in a single write.
 * @param {readonly Entry[]} entries
 * @returns {WriteResult}
 */
export function appendEntries(entries) {
  if (entries.length === 0) return { ok: true };
  try {
    const target = getOutboxPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const payload = entries.map((entry) => `${serializeEntry(entry)}\n`).join('');
    fs.appendFileSync(target, payload, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Read every valid entry in the outbox. Invalid lines are counted, not thrown.
 * A missing file is an empty outbox; any other read failure is returned as
 * `error` so callers never mistake an unreadable outbox for an empty one.
 * @returns {{ entries: Entry[], invalidLines: number, error: string | null }}
 */
export function readOutbox() {
  let raw;
  try {
    raw = fs.readFileSync(getOutboxPath(), 'utf8');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return { entries: [], invalidLines: 0, error: missing ? null : errorMessage(error) };
  }
  const entries = [];
  let invalidLines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseEntryLine(line);
    if (parsed.ok) entries.push(parsed.entry);
    else invalidLines += 1;
  }
  return { entries, invalidLines, error: null };
}

/**
 * Raw outbox content. A missing file is an empty outbox ('').
 * @returns {{ ok: true, content: string } | { ok: false, error: string }}
 */
export function readOutboxContent() {
  try {
    return { ok: true, content: fs.readFileSync(getOutboxPath(), 'utf8') };
  } catch (error) {
    if (isMissingFile(error)) return { ok: true, content: '' };
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Carry over lines appended to the outbox after it was read. The file may
 * only have grown at the end; any other change aborts the write.
 * @param {{ original: string, current: string, rewritten: string }} args
 *   original: content the rewrite was based on; current: content right
 *   before the rename; rewritten: the new content computed from `original`
 * @returns {{ ok: true, content: string, tail: string } | { ok: false, reason: string }}
 */
export function mergeConcurrentTail({ original, current, rewritten }) {
  if (current === original) return { ok: true, content: rewritten, tail: '' };
  if (!current.startsWith(original)) {
    return { ok: false, reason: 'outbox changed other than by appending since it was read' };
  }
  if (original !== '' && !original.endsWith('\n')) {
    return { ok: false, reason: 'outbox grew after a last line without a trailing newline' };
  }
  const tail = current.slice(original.length);
  return { ok: true, content: `${rewritten}${tail}`, tail };
}

/**
 * Atomically replace the outbox with `rewritten` (computed from `original`):
 * optional backup, temp file + rename, keeping the file mode. Lines appended
 * after `original` was read are carried over (`mergeConcurrentTail`); if the
 * file changed in any other way nothing is written.
 *
 * The re-read, write and rename are synchronous, so appends from this process
 * cannot interleave. Bytes another process appends to the old file between
 * the re-read and the rename are copied over after the rename.
 * @param {{ original: string, rewritten: string, backup?: boolean }} args
 * @returns {{ ok: true, backup: string|null, tail: string }
 *         | { ok: false, error: string, backup: string|null }}
 */
export function replaceOutboxContent({ original, rewritten, backup = false }) {
  const target = getOutboxPath();
  let backupPath = null;
  if (backup) {
    backupPath = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.writeFileSync(backupPath, original, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      return { ok: false, error: `backup failed, nothing written: ${errorMessage(error)}`, backup: null };
    }
  }
  const tmp = `${target}.${process.pid}.tmp`;
  let fd = null;
  let renamed = false;
  try {
    fd = fs.openSync(target, 'r');
    const currentBytes = fs.readFileSync(fd);
    const merged = mergeConcurrentTail({ original, current: currentBytes.toString('utf8'), rewritten });
    if (!merged.ok) return { ok: false, error: `aborted, nothing written: ${merged.reason}`, backup: backupPath };
    fs.writeFileSync(tmp, merged.content, { encoding: 'utf8', mode: fs.fstatSync(fd).mode });
    fs.renameSync(tmp, target);
    renamed = true;
    const late = readBytesFrom(fd, currentBytes.length);
    if (late.length > 0) fs.appendFileSync(target, late);
    return { ok: true, backup: backupPath, tail: `${merged.tail}${late.toString('utf8')}` };
  } catch (error) {
    if (renamed) {
      return { ok: false, error: `outbox rewritten, but lines appended during the rewrite may be missing: ${errorMessage(error)}`, backup: backupPath };
    }
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: `write failed, outbox left as it was: ${errorMessage(error)}`, backup: backupPath };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Append raw lines to `outbox.rejected.jsonl` (entries the server will never
 * accept as-is), so they leave the outbox without being lost.
 * @param {readonly string[]} lines JSON lines without trailing newline
 * @returns {WriteResult}
 */
export function appendRejectedLines(lines) {
  if (lines.length === 0) return { ok: true };
  try {
    const target = getRejectedPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, lines.map((line) => `${line}\n`).join(''), 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Number of lines in `outbox.rejected.jsonl` (0 when missing or unreadable).
 * @returns {number}
 */
export function countRejected() {
  try {
    return fs.readFileSync(getRejectedPath(), 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

/**
 * @param {number} fd
 * @param {number} start byte offset
 * @returns {Buffer} bytes from `start` to the current end of the file
 */
function readBytesFrom(fd, start) {
  const size = fs.fstatSync(fd).size;
  if (size <= start) return Buffer.alloc(0);
  const buffer = Buffer.alloc(size - start);
  const read = fs.readSync(fd, buffer, 0, buffer.length, start);
  return buffer.subarray(0, read);
}

/**
 * Record one live CLI result. Sets `liveSince` on the first successful write.
 * @param {{ task: 'translate'|'check', input: string, output: string,
 *           mode: 'simple'|'detail', srcLang?: 'zh'|'en'|null, createdAt?: Date }} fields
 * @returns {WriteResult}
 */
export function recordLiveEntry({ task, input, output, mode, srcLang = null, createdAt = new Date() }) {
  let entry;
  try {
    entry = createEntry({ source: 'cli', task, input, output, mode, srcLang, createdAt });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  const written = appendEntries([entry]);
  if (!written.ok) return written;
  if (getLiveSince() === null) {
    return updateSyncState({ liveSince: entry.createdAt });
  }
  return written;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
