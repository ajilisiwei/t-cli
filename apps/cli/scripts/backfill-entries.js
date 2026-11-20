#!/usr/bin/env node
/**
 * One-off backfill: import the Markdown history (<config>/t-cli/history/
 * YYYY-MM-DD.md) into the structured outbox (<config>/t-cli/outbox.jsonl).
 *
 * Safe to re-run: IDs are derived from the Markdown content, IDs already in
 * the outbox are skipped, and records from the minute live logging started
 * (sync-state `liveSince`) onwards are left to the live writer.
 *
 * This is a plain Node script, not the Ink TUI, so it reports via console.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getHistoryDir } from '../src/history.js';
import { appendEntries, getLiveSince, getOutboxPath, readOutbox } from '../src/entryLog.js';
import {
  HISTORY_FILE_RE,
  compareWithMeta,
  parseHistoryFile,
  planBackfill,
  recordToEntry,
} from '../src/utils/historyParser.js';

/** @typedef {import('../src/utils/historyParser.js').HistoryRecord} HistoryRecord */
/** @typedef {import('../src/utils/historyParser.js').ParseFailure} ParseFailure */
/** @typedef {import('@t-cli/core/entry').Entry} Entry */

const USAGE = `Usage: node scripts/backfill-entries.js [--dry-run] [--history-dir <dir>]

Import Markdown history into the structured outbox (outbox.jsonl). Safe to re-run.

  --dry-run            parse and report, write nothing
  --history-dir <dir>  history directory (default: the CLI's history dir)
  -h, --help           show this help`;

const MAX_LISTED = 20;

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, historyDir: string, help: boolean }}
 * @throws {TypeError} on unknown or malformed flags
 */
function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'history-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const historyDir = values['history-dir'] ? path.resolve(values['history-dir']) : getHistoryDir();
  return { dryRun: Boolean(values['dry-run']), historyDir, help: Boolean(values.help) };
}

/**
 * Read and parse one history file. Read errors are returned, not thrown.
 * @param {string} historyDir
 * @param {string} name
 */
function scanFile(historyDir, name) {
  const fileDate = /** @type {RegExpExecArray} */ (HISTORY_FILE_RE.exec(name))[1];
  let content;
  try {
    content = fs.readFileSync(path.join(historyDir, name), 'utf8');
  } catch (error) {
    return { headings: 0, records: [], failures: [], readError: `${name}: ${errorMessage(error)}` };
  }
  return { ...parseHistoryFile(content, fileDate), readError: null };
}

/**
 * @param {string} historyDir
 * @throws when the directory itself cannot be listed
 */
function scanHistory(historyDir) {
  const names = fs.readdirSync(historyDir).filter((name) => HISTORY_FILE_RE.test(name)).sort();
  const scans = names.map((name) => scanFile(historyDir, name));
  return {
    files: names.length,
    headings: scans.reduce((total, scan) => total + scan.headings, 0),
    records: scans.flatMap((scan) => scan.records),
    parseFailures: scans.flatMap((scan) => scan.failures),
    readErrors: scans.flatMap((scan) => (scan.readError ? [scan.readError] : [])),
  };
}

/**
 * @param {readonly HistoryRecord[]} records
 * @returns {{ entries: Entry[], failures: ParseFailure[], timestampFallbacks: number }}
 */
function mapEntries(records) {
  const results = records.map((record) => ({ record, result: recordToEntry(record) }));
  return {
    entries: results.flatMap(({ result }) => (result.ok ? [result.entry] : [])),
    failures: results.flatMap(({ record, result }) => (result.ok
      ? []
      : [{ fileDate: record.fileDate, index: record.index, time: record.time, error: result.error }])),
    timestampFallbacks: results.filter(({ result }) => result.ok && !result.dateMatched).length,
  };
}

/**
 * Read meta.json. A missing file is not an error; a corrupt one is reported.
 * @param {string} historyDir
 * @returns {{ meta: unknown, error: string | null }}
 */
function readMeta(historyDir) {
  const metaPath = path.join(historyDir, 'meta.json');
  try {
    return { meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')), error: null };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return { meta: null, error: missing ? null : errorMessage(error) };
  }
}

/**
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} keyOf
 * @returns {Record<string, number>}
 */
function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return Object.fromEntries(counts);
}

const formatCounts = (counts) => Object.entries(counts).map(([key, n]) => `${key} ${n}`).join(', ') || '-';
const line = (label, value) => console.log(`  ${`${label}:`.padEnd(22)}${value}`);

/** @param {string} title @param {readonly (ParseFailure|string)[]} items */
function printList(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title} (${items.length}):`);
  for (const item of items.slice(0, MAX_LISTED)) {
    console.log(typeof item === 'string' ? `  ${item}` : `  ${item.fileDate}.md #${item.index} [${item.time}]: ${item.error}`);
  }
  if (items.length > MAX_LISTED) console.log(`  … and ${items.length - MAX_LISTED} more`);
}

function printSummary({ options, scan, mapped, liveSince, outbox, plan, write }) {
  const lfInputs = scan.records.filter((r) => r.input.includes('\n')).length;
  const crInputs = scan.records.filter((r) => r.input.includes('\r')).length;
  const multiLine = scan.records.filter((r) => r.multiLineInput).length;
  console.log(`t-cli history backfill${options.dryRun ? ' (DRY RUN: nothing written)' : ''}`);
  line('history dir', options.historyDir);
  line('outbox', `${getOutboxPath()} (${outbox.entries.length} entries, ${outbox.invalidLines} invalid lines)`);
  line('live since', liveSince ?? 'never (no cutoff, importing everything)');
  console.log('');
  line('files scanned', scan.files);
  line('headings found', scan.headings);
  line('entries parsed', mapped.entries.length);
  line('parse failures', scan.parseFailures.length + mapped.failures.length);
  line('file read errors', scan.readErrors.length);
  line('multi-line inputs', `${multiLine} (LF line breaks: ${lfInputs}, embedded CR: ${crInputs})`);
  line('timestamp fallbacks', mapped.timestampFallbacks);
  line('skipped by cutoff', plan.skippedByCutoff);
  line('duplicates skipped', plan.duplicates);
  line(options.dryRun ? 'would write' : 'written', write.ok ? plan.toWrite.length : `0 (write failed: ${write.error})`);
  console.log('');
  line('task', formatCounts(countBy(mapped.entries, (e) => e.task)));
  line('mode (inferred)', formatCounts(countBy(mapped.entries, (e) => e.mode)));
  line('kind', formatCounts(countBy(mapped.entries, (e) => e.kind)));
  line('srcLang', formatCounts(countBy(mapped.entries, (e) => String(e.srcLang))));
  line('file date basis', formatCounts(countBy(scan.records, (r) => r.dateBasis)));
  if (plan.toWrite.length > 0) {
    line('range to write', `${plan.toWrite[0].createdAt} .. ${plan.toWrite[plan.toWrite.length - 1].createdAt}`);
  }
  printList('Parse failures', [...scan.parseFailures, ...mapped.failures]);
  printList('File read errors', scan.readErrors);
}

function printMetaComparison(historyDir, records) {
  const { meta, error } = readMeta(historyDir);
  console.log('\nmeta.json comparison (meta.json is a best-effort cache and may be stale):');
  if (error) return console.log(`  could not read meta.json: ${error}`);
  if (meta === null) return console.log('  no meta.json found');
  const result = compareWithMeta(countBy(records, (r) => r.fileDate), meta);
  line('dates covered', result.covered);
  line('mismatched dates', result.mismatches.length);
  for (const { date, meta: expected, parsed } of result.mismatches) {
    console.log(`  ${date}  meta=${expected}  parsed=${parsed}  (diff ${parsed - expected >= 0 ? '+' : ''}${parsed - expected})`);
  }
  if (result.invalidKeys.length > 0) line('invalid meta keys', result.invalidKeys.join(', '));
}

/**
 * @param {string[]} argv
 * @returns {number} process exit code
 */
function main(argv) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(`${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const scan = scanHistory(options.historyDir);
    const mapped = mapEntries(scan.records);
    const liveSince = getLiveSince();
    const outbox = readOutbox();
    // An unreadable outbox would make every ID look new and duplicate them all.
    if (outbox.error) throw new Error(`cannot read outbox ${getOutboxPath()}: ${outbox.error}`);
    const plan = planBackfill({ entries: mapped.entries, liveSince, existingIds: outbox.entries.map((e) => e.id) });
    const write = options.dryRun ? { ok: true } : appendEntries(plan.toWrite);
    printSummary({ options, scan, mapped, liveSince, outbox, plan, write });
    printMetaComparison(options.historyDir, scan.records);
    return write.ok ? 0 : 1;
  } catch (error) {
    console.error(`Backfill aborted: ${errorMessage(error)}`);
    return 1;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

process.exitCode = main(process.argv.slice(2));
