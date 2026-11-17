/**
 * Raw record ("Entry") schema shared by the CLI, the history backfill and,
 * later, the sync server. An entry is one translation or grammar check: its
 * input and the raw model output. Entries are immutable once created.
 */
import { isWordLookup } from './detect.js';
import { ulid, ULID_RE } from './ulid.js';
import { detectSpellingCorrection } from './spelling.js';

export const ENTRY_SCHEMA_VERSION = 1;
export const ENTRY_SOURCES = Object.freeze(['cli', 'mp']);
export const ENTRY_TASKS = Object.freeze(['translate', 'check']);
export const ENTRY_KINDS = Object.freeze(['word', 'sentence', 'paragraph']);
export const ENTRY_MODES = Object.freeze(['simple', 'detail']);
export const ENTRY_SRC_LANGS = Object.freeze(['zh', 'en']);

/** Inputs longer than this (in code points) are paragraphs, not sentences. */
export const SENTENCE_MAX_CHARS = 120;

// ISO 8601 with an explicit offset, second precision: 2026-11-16T09:12:03+08:00
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @typedef {'cli'|'mp'} EntrySource
 * @typedef {'translate'|'check'} EntryTask
 * @typedef {'word'|'sentence'|'paragraph'} EntryKind
 * @typedef {'simple'|'detail'} EntryMode
 *
 * @typedef {Object} Entry
 * @property {number} v              schema version (ENTRY_SCHEMA_VERSION)
 * @property {string} id             ULID; its time part equals createdAt
 * @property {EntrySource} source
 * @property {EntryTask} task
 * @property {EntryKind} kind
 * @property {string} input          user text, trimmed
 * @property {string} output         raw model response, trimmed
 * @property {'zh'|'en'|null} srcLang detected source language; null if unknown
 * @property {EntryMode} mode
 * @property {string} createdAt      ISO 8601 with local offset, second precision
 * @property {string|null} correctedInput  intended spelling when an English word
 *                                  lookup was misspelled (e.g. "prioritiz" -> "prioritize");
 *                                  null otherwise. Review material must use this, not input.
 */

/**
 * Classify an input as a word lookup, a sentence or a paragraph.
 * @param {string} input
 * @returns {EntryKind}
 */
export function classifyKind(input) {
  const text = (input || '').trim();
  if (isWordLookup(text)) return 'word';
  return [...text].length <= SENTENCE_MAX_CHARS ? 'sentence' : 'paragraph';
}

/**
 * Normalize line breaks and trim. Pasting into a raw-mode terminal turns
 * newlines into bare CRs, so CRLF/CR become LF before the text is stored.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').trim();
}

/**
 * Format a Date as local-time ISO 8601 with offset, second precision.
 * @param {Date} date
 * @returns {string}
 */
export function toLocalIsoString(date) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.trunc(offsetMin / 60))}:${pad(offsetMin % 60)}`;
}

/**
 * Build a validated, frozen Entry.
 * @param {Object} fields
 * @param {EntrySource} fields.source
 * @param {EntryTask} fields.task
 * @param {string} fields.input
 * @param {string} fields.output
 * @param {EntryMode} fields.mode
 * @param {'zh'|'en'|null} [fields.srcLang]
 * @param {Date} [fields.createdAt]   defaults to now; truncated to seconds
 * @param {EntryKind} [fields.kind]   defaults to classifyKind(input)
 * @param {Uint8Array} [fields.entropy] fixed ULID entropy for deterministic IDs
 * @param {string|null} [fields.correctedInput] defaults to detectSpellingCorrection()
 * @returns {Readonly<Entry>}
 * @throws {TypeError} when the fields do not form a valid entry
 */
export function createEntry({ source, task, input, output, mode, srcLang = null, createdAt = new Date(), kind, entropy, correctedInput }) {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new TypeError('createdAt must be a valid Date');
  }
  const seconds = new Date(Math.floor(createdAt.getTime() / 1000) * 1000);
  const trimmedInput = typeof input === 'string' ? normalizeText(input) : input;
  const trimmedOutput = typeof output === 'string' ? normalizeText(output) : output;
  const resolvedKind = kind ?? classifyKind(trimmedInput);
  const candidate = {
    v: ENTRY_SCHEMA_VERSION,
    id: ulid({ time: seconds.getTime(), entropy }),
    source,
    task,
    kind: resolvedKind,
    input: trimmedInput,
    output: trimmedOutput,
    srcLang,
    mode,
    createdAt: toLocalIsoString(seconds),
    correctedInput: correctedInput !== undefined
      ? correctedInput
      : detectSpellingCorrection({ input: trimmedInput, output: trimmedOutput, srcLang, kind: resolvedKind }),
  };
  const result = validateEntry(candidate);
  if (!result.ok) {
    throw new TypeError(`Invalid entry: ${result.errors.join('; ')}`);
  }
  return result.entry;
}

/**
 * Validate an untrusted value (e.g. a parsed JSONL line) as an Entry.
 * @param {unknown} value
 * @returns {{ ok: true, entry: Readonly<Entry> } | { ok: false, errors: string[] }}
 */
export function validateEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['entry must be an object'] };
  }
  const e = /** @type {Record<string, unknown>} */ (value);
  const errors = [];
  if (e.v !== ENTRY_SCHEMA_VERSION) errors.push(`v must be ${ENTRY_SCHEMA_VERSION}`);
  if (typeof e.id !== 'string' || !ULID_RE.test(e.id)) errors.push('id must be a ULID');
  if (!ENTRY_SOURCES.includes(/** @type {string} */ (e.source))) errors.push(`source must be one of ${ENTRY_SOURCES.join('/')}`);
  if (!ENTRY_TASKS.includes(/** @type {string} */ (e.task))) errors.push(`task must be one of ${ENTRY_TASKS.join('/')}`);
  if (!ENTRY_KINDS.includes(/** @type {string} */ (e.kind))) errors.push(`kind must be one of ${ENTRY_KINDS.join('/')}`);
  if (!ENTRY_MODES.includes(/** @type {string} */ (e.mode))) errors.push(`mode must be one of ${ENTRY_MODES.join('/')}`);
  if (typeof e.input !== 'string' || e.input.trim() === '') errors.push('input must be a non-empty string');
  if (typeof e.output !== 'string') errors.push('output must be a string');
  if (e.srcLang !== null && !ENTRY_SRC_LANGS.includes(/** @type {string} */ (e.srcLang))) errors.push('srcLang must be zh, en or null');
  if (typeof e.createdAt !== 'string' || !ISO_WITH_OFFSET_RE.test(e.createdAt) || Number.isNaN(Date.parse(e.createdAt))) {
    errors.push('createdAt must be ISO 8601 with offset, second precision');
  }
  // Optional since lines written before the field existed lack it.
  const correctedInput = e.correctedInput ?? null;
  if (correctedInput !== null && (typeof correctedInput !== 'string' || correctedInput.trim() === '')) {
    errors.push('correctedInput must be a non-empty string or null');
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    entry: Object.freeze({
      v: ENTRY_SCHEMA_VERSION,
      id: /** @type {string} */ (e.id),
      source: /** @type {EntrySource} */ (e.source),
      task: /** @type {EntryTask} */ (e.task),
      kind: /** @type {EntryKind} */ (e.kind),
      input: /** @type {string} */ (e.input),
      output: /** @type {string} */ (e.output),
      srcLang: /** @type {'zh'|'en'|null} */ (e.srcLang),
      mode: /** @type {EntryMode} */ (e.mode),
      createdAt: /** @type {string} */ (e.createdAt),
      correctedInput: /** @type {string|null} */ (correctedInput),
    }),
  };
}

/**
 * Serialize an entry as one JSONL line (no trailing newline).
 * @param {Entry} entry
 * @returns {string}
 */
export function serializeEntry(entry) {
  return JSON.stringify(entry);
}

/**
 * Parse and validate one JSONL line.
 * @param {string} line
 * @returns {{ ok: true, entry: Readonly<Entry> } | { ok: false, errors: string[] }}
 */
export function parseEntryLine(line) {
  try {
    return validateEntry(JSON.parse(line));
  } catch (error) {
    return { ok: false, errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
