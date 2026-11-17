/**
 * Local structured record log ("outbox") for the CLI.
 *
 * Every translation / grammar check is appended to `outbox.jsonl` as one
 * Entry (see @t-cli/core/entry), alongside the human-readable Markdown
 * history. In M1 a sync client pushes these lines to the server and drops the
 * acknowledged ones; until then the file only grows.
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
