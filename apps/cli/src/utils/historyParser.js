/**
 * Pure parsing / mapping logic for the one-off Markdown history backfill
 * (scripts/backfill-entries.js). No file system access: the script reads the
 * files and hands their contents to these helpers.
 *
 * Markdown layout written by history.js `saveHistory`:
 *
 *   # t-cli Learning History — 2026-11-16 (local date)   <- file header
 *
 *   ---
 *
 *   ## [07:30] Translation                     <- one block per heading
 *
 *   **Input:** <user text>
 *
 *   <raw model response, may itself contain `---` and `## ...` lines>
 *
 *   ---
 *
 * File dates ("date basis"): files are named by the local calendar date and
 * their header carries the "(local date)" marker. Files created before that
 * rule have a bare header (`# t-cli Learning History — 2026-11-16`) and are
 * named by the UTC date, while their [HH:MM] is still local time. Existing
 * files are never renamed, so the header decides how a file is read.
 *
 * Known edge: on the day of the switch, the new rule may append to a file the
 * old rule started that day; it keeps its bare header. East of UTC (e.g.
 * UTC+8) those appended times read the same under both rules. West of UTC,
 * evening entries appended that one day (local hour >= 24 - |offset|) read
 * as the previous day.
 */
import { createHash } from 'node:crypto';
import { createEntry, classifyKind } from '@t-cli/core/entry';
import { detectSourceLang } from '@t-cli/core/detect';
import { localDateString } from './localDate.js';

/** @typedef {import('@t-cli/core/entry').Entry} Entry */
/** @typedef {'Translation'|'Grammar Check'} HistoryType */
/** @typedef {'local'|'utc'} DateBasis  calendar the file name follows */

/**
 * @typedef {Object} HistoryBlock
 * @property {number} index        0-based position of the heading in its file
 * @property {string} time         local wall-clock time, HH:MM
 * @property {HistoryType} type
 * @property {readonly string[]} lines  lines between this heading and the next
 */

/**
 * @typedef {Object} HistoryRecord
 * @property {string} fileDate     YYYY-MM-DD from the file name
 * @property {DateBasis} dateBasis  'local' for marked files, 'utc' for older ones
 * @property {number} index
 * @property {string} time
 * @property {HistoryType} type
 * @property {string} input        trimmed user text
 * @property {string} output       raw model response, trimmed
 * @property {boolean} multiLineInput  input contains a line break (LF or CR)
 * @property {number} occurrence   n-th identical (time, type, input) in the file
 */

/**
 * @typedef {Object} ParseFailure
 * @property {string} fileDate
 * @property {number} index
 * @property {string} time
 * @property {string} error
 */

/** Entry headings. Splitting on `---` is unsafe: detail responses contain it. */
export const HEADING_RE = /^## \[(\d{2}:\d{2})\] (Translation|Grammar Check)\s*$/;
/** History file names: one file per date (see "File dates" above). */
export const HISTORY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
/** Header line of a file named by the local date. */
const LOCAL_DATE_HEADER_RE = /^# t-cli Learning History — \d{4}-\d{2}-\d{2} \(local date\)\s*$/;

const INPUT_PREFIX = '**Input:**';
const SEPARATOR = '---';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const LINE_BREAK_RE = /\r\n|\r|\n/;
const ENTROPY_BYTES = 10;
const MS_PER_MINUTE = 60_000;

const isBlank = (line) => line.trim() === '';

/**
 * Header saveHistory writes at the top of a new file.
 * @param {string} date  YYYY-MM-DD local date
 * @returns {string}
 */
export function formatHistoryHeader(date) {
  return `# t-cli Learning History — ${date} (local date)\n\n---\n`;
}

/**
 * Which calendar a file's name follows: 'local' when the header (the text
 * before the first entry heading) has the "(local date)" marker, else 'utc'.
 * @param {string} content
 * @returns {DateBasis}
 */
export function detectDateBasis(content) {
  const lines = content.split('\n');
  const firstHeading = lines.findIndex((line) => HEADING_RE.test(line));
  const header = firstHeading === -1 ? lines : lines.slice(0, firstHeading);
  return header.some((line) => LOCAL_DATE_HEADER_RE.test(line)) ? 'local' : 'utc';
}

/**
 * Split a history file into heading blocks. Text before the first heading
 * (the file header) is dropped.
 * @param {string} content
 * @returns {HistoryBlock[]}
 */
export function splitBlocks(content) {
  const lines = content.split('\n');
  const starts = lines.flatMap((line, i) => (HEADING_RE.test(line) ? [i] : []));
  return starts.map((start, n) => {
    const [, time, type] = /** @type {RegExpExecArray} */ (HEADING_RE.exec(lines[start]));
    const end = n + 1 < starts.length ? starts[n + 1] : lines.length;
    return Object.freeze({
      index: n,
      time,
      type: /** @type {HistoryType} */ (type),
      lines: Object.freeze(lines.slice(start + 1, end)),
    });
  });
}

/**
 * Drop leading and trailing blank lines.
 * @param {readonly string[]} lines
 * @returns {string[]}
 */
function trimBlankEdges(lines) {
  const first = lines.findIndex((line) => !isBlank(line));
  if (first === -1) return [];
  const last = lines.findLastIndex((line) => !isBlank(line));
  return lines.slice(first, last + 1);
}

/**
 * Output = everything after the input paragraph, minus the one trailing `---`
 * separator that saveHistory appends after every entry.
 * @param {readonly string[]} lines
 * @returns {string}
 */
function extractOutput(lines) {
  const trimmed = trimBlankEdges(lines);
  const hasSeparator = trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === SEPARATOR;
  return trimBlankEdges(hasSeparator ? trimmed.slice(0, -1) : trimmed).join('\n');
}

/**
 * Parse one heading block into input/output. The `**Input:**` line must be the
 * first non-blank line; the input runs until the first blank line (pasted
 * multi-line text), the rest is the model output.
 * @param {HistoryBlock} block
 * @returns {{ ok: true, input: string, output: string } | { ok: false, error: string }}
 */
export function parseBlock(block) {
  const { lines } = block;
  const inputStart = lines.findIndex((line) => !isBlank(line));
  if (inputStart === -1 || !lines[inputStart].startsWith(INPUT_PREFIX)) {
    return { ok: false, error: `no "${INPUT_PREFIX}" line after heading` };
  }
  const blankOffset = lines.slice(inputStart).findIndex(isBlank);
  const inputEnd = blankOffset === -1 ? lines.length : inputStart + blankOffset;
  const firstLine = lines[inputStart].slice(INPUT_PREFIX.length).replace(/^ /, '');
  const input = [firstLine, ...lines.slice(inputStart + 1, inputEnd)].join('\n').trim();
  if (input === '') {
    return { ok: false, error: 'empty input' };
  }
  return { ok: true, input, output: extractOutput(lines.slice(inputEnd)) };
}

/**
 * Number identical (time, type, input) records in file order, so the identity
 * key stays stable even if unrelated entries are later removed from the file.
 * @param {Omit<HistoryRecord, 'occurrence'>[]} records
 * @returns {HistoryRecord[]}
 */
function withOccurrence(records) {
  const seen = new Map();
  return records.map((record) => {
    const key = `${record.time}|${record.type}|${record.input}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return Object.freeze({ ...record, occurrence });
  });
}

/**
 * Parse a whole history file.
 * @param {string} content
 * @param {string} fileDate  YYYY-MM-DD taken from the file name
 * @returns {{ headings: number, records: HistoryRecord[], failures: ParseFailure[] }}
 */
export function parseHistoryFile(content, fileDate) {
  const dateBasis = detectDateBasis(content);
  const blocks = splitBlocks(content);
  const results = blocks.map((block) => ({ block, result: parseBlock(block) }));
  const failures = results
    .filter(({ result }) => !result.ok)
    .map(({ block, result }) => ({ fileDate, index: block.index, time: block.time, error: /** @type {{ error: string }} */ (result).error }));
  const records = results
    .filter(({ result }) => result.ok)
    .map(({ block, result }) => {
      const { input, output } = /** @type {{ input: string, output: string }} */ (result);
      return { fileDate, dateBasis, index: block.index, time: block.time, type: block.type, input, output, multiLineInput: LINE_BREAK_RE.test(input) };
    });
  return { headings: blocks.length, records: withOccurrence(records), failures };
}

/**
 * Parse a YYYY-MM-DD string, rejecting impossible dates like 2026-02-31.
 * @param {string} fileDate
 * @returns {[number, number, number]} year, month (1-12), day
 * @throws {TypeError}
 */
function parseFileDate(fileDate) {
  const match = DATE_RE.exec(fileDate);
  const parts = match ? /** @type {[number, number, number]} */ (match.slice(1).map(Number)) : null;
  if (!parts || new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).toISOString().slice(0, 10) !== fileDate) {
    throw new TypeError(`Invalid file date: ${fileDate}`);
  }
  return parts;
}

/**
 * Reconstruct the real local datetime of an entry. `[HH:MM]` is always local
 * wall-clock time (process time zone); what the file date means depends on
 * the file's date basis.
 *
 * 'local' (current files): the file date is the local date, so the entry is
 * simply fileDate HH:MM. `dateMatched` is false only for a wall-clock time a
 * DST jump skipped, which Date shifts by the jump.
 *
 * 'utc' (files from before the local-date rule): the file was named after the
 * UTC date (`toISOString().slice(0,10)`). In UTC+8 an entry made at local 07:30
 * on Nov 17 lands in `2026-11-16.md` as `[07:30]`. So try HH:MM on local dates
 * fileDate, fileDate+1 and fileDate-1 and pick the one whose UTC calendar date
 * equals the file date. With a fixed offset at most one candidate matches; if
 * none does (DST edge), fall back to fileDate. This path must keep returning
 * the same instants: backfilled IDs embed them.
 *
 * @param {string} fileDate  YYYY-MM-DD
 * @param {string} time      HH:MM (local time)
 * @param {DateBasis} [dateBasis]
 * @returns {{ createdAt: Date, dateMatched: boolean }}
 * @throws {TypeError} on a malformed date, time or date basis
 */
export function reconstructCreatedAt(fileDate, time, dateBasis = 'utc') {
  const [year, month, day] = parseFileDate(fileDate);
  const timeMatch = TIME_RE.exec(time);
  const [hours, minutes] = timeMatch ? timeMatch.slice(1).map(Number) : [NaN, NaN];
  if (!(hours <= 23 && minutes <= 59)) {
    throw new TypeError(`Invalid time: ${time}`);
  }
  const onLocalDay = (offset) => new Date(year, month - 1, day + offset, hours, minutes, 0, 0);
  if (dateBasis === 'local') {
    const createdAt = onLocalDay(0);
    const dateMatched = localDateString(createdAt) === fileDate
      && createdAt.getHours() === hours && createdAt.getMinutes() === minutes;
    return { createdAt, dateMatched };
  }
  if (dateBasis !== 'utc') {
    throw new TypeError(`Invalid date basis: ${dateBasis}`);
  }
  const candidates = [0, 1, -1].map(onLocalDay);
  const match = candidates.find((date) => date.toISOString().slice(0, 10) === fileDate);
  return { createdAt: match ?? candidates[0], dateMatched: match !== undefined };
}

const countNonEmptyLines = (text) => text.split(LINE_BREAK_RE).filter((line) => !isBlank(line)).length;

/**
 * Infer the output mode, which Markdown history does not record.
 *
 * Heuristic: simple-mode prompts demand a single line ("Output ONLY the single
 * best translation"), while detail mode always adds alternatives, IPA or
 * explanations on further lines. So more than one non-empty output line means
 * 'detail', otherwise 'simple'.
 *
 * Refinement for pasted multi-line input: a simple-mode translation keeps the
 * source's line structure (N input lines -> about N output lines), so the
 * threshold is the input's non-empty line count rather than 1. For single-line
 * input (the vast majority) this is exactly the "more than one line" rule.
 * Known miss: a detail answer to a long paste that the model condenses into
 * no more lines than the source is labelled 'simple'.
 *
 * @param {string} output
 * @param {string} [input]
 * @returns {'simple'|'detail'}
 */
export function inferMode(output, input = '') {
  const threshold = Math.max(1, countNonEmptyLines(input));
  return countNonEmptyLines(output) > threshold ? 'detail' : 'simple';
}

/**
 * Stable identity of a Markdown record; hashed into the ULID entropy so a
 * re-run reproduces the same ID.
 * @param {HistoryRecord} record
 * @returns {string}
 */
export function identityKey(record) {
  return `${record.fileDate}|${record.time}|${record.type}|${record.occurrence}|${record.input}`;
}

/**
 * First 10 bytes of SHA-256(key), used as deterministic ULID entropy.
 * @param {string} key
 * @returns {Uint8Array}
 */
export function entropyFor(key) {
  return Uint8Array.from(createHash('sha256').update(key, 'utf8').digest().subarray(0, ENTROPY_BYTES));
}

/**
 * Map a parsed Markdown record to an Entry.
 * @param {HistoryRecord} record
 * @returns {{ ok: true, entry: Readonly<Entry>, dateMatched: boolean } | { ok: false, error: string }}
 */
export function recordToEntry(record) {
  try {
    const { createdAt, dateMatched } = reconstructCreatedAt(record.fileDate, record.time, record.dateBasis);
    const isCheck = record.type === 'Grammar Check';
    const entry = createEntry({
      source: 'cli',
      task: isCheck ? 'check' : 'translate',
      kind: classifyKind(record.input),
      input: record.input,
      output: record.output,
      mode: inferMode(record.output, record.input),
      srcLang: isCheck ? 'en' : detectSourceLang(record.input),
      createdAt,
      entropy: entropyFor(identityKey(record)),
    });
    return { ok: true, entry, dateMatched };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether a backfilled entry predates live logging. Markdown has minute
 * precision, so only minutes strictly before liveSince's minute qualify: live
 * entries from that same minute are already in the outbox.
 * @param {Pick<Entry, 'createdAt'>} entry
 * @param {string | null} liveSince  ISO 8601, or null when never live
 * @returns {boolean}
 * @throws {TypeError} when liveSince is not a parseable date
 */
export function isBeforeLiveCutoff(entry, liveSince) {
  if (liveSince === null) return true;
  const liveMs = Date.parse(liveSince);
  if (Number.isNaN(liveMs)) throw new TypeError(`Invalid liveSince: ${liveSince}`);
  const minuteOf = (ms) => Math.floor(ms / MS_PER_MINUTE);
  return minuteOf(Date.parse(entry.createdAt)) < minuteOf(liveMs);
}

/**
 * Decide which entries to write: drop those at/after the live cutoff, then
 * those whose ID is already in the outbox (or repeated within this batch).
 * The result is in chronological order (stable, so same-minute entries keep
 * their file order).
 * @param {{ entries: readonly Entry[], liveSince: string | null, existingIds: Iterable<string> }} params
 * @returns {{ toWrite: Entry[], skippedByCutoff: number, duplicates: number }}
 */
export function planBackfill({ entries, liveSince, existingIds }) {
  const eligible = entries.filter((entry) => isBeforeLiveCutoff(entry, liveSince));
  const seen = new Set(existingIds);
  const toWrite = eligible.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  return {
    toWrite: toWrite.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    skippedByCutoff: entries.length - eligible.length,
    duplicates: eligible.length - toWrite.length,
  };
}

/**
 * Compare parsed per-date counts with the meta.json cache, for the dates the
 * cache covers. Keys that are not dates or values that are not counts are
 * reported as invalid rather than ignored.
 * @param {Readonly<Record<string, number>>} parsedCounts  date -> parsed entries
 * @param {unknown} meta  parsed meta.json
 * @returns {{ covered: number, mismatches: { date: string, meta: number, parsed: number }[], invalidKeys: string[] }}
 */
export function compareWithMeta(parsedCounts, meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { covered: 0, mismatches: [], invalidKeys: [] };
  }
  const pairs = Object.entries(meta).sort(([a], [b]) => a.localeCompare(b));
  const isValid = ([date, count]) => DATE_RE.test(date) && Number.isInteger(count) && count >= 0;
  const valid = pairs.filter(isValid);
  const mismatches = valid
    .map(([date, count]) => ({ date, meta: count, parsed: parsedCounts[date] ?? 0 }))
    .filter(({ meta: expected, parsed }) => expected !== parsed);
  return {
    covered: valid.length,
    mismatches,
    invalidKeys: pairs.filter((pair) => !isValid(pair)).map(([date]) => date),
  };
}
