#!/usr/bin/env node
/**
 * Audit historical English word lookups for misspelled inputs and record the
 * intended spelling as `correctedInput` in the outbox (outbox.jsonl), so
 * review material never teaches a misspelling.
 *
 * Dry-run by default. `--apply` rewrites only the affected lines (backup
 * first, temp file + rename, lines appended concurrently are carried over).
 *
 * This is a plain Node script, not the Ink TUI, so it reports via console.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { getOutboxPath, replaceOutboxContent } from '../src/entryLog.js';
import {
  MAX_REQUESTS,
  MAX_WORDS_PER_REQUEST,
  buildAuditRequest,
  buildCorrections,
  buildPlan,
  collectDistinctWords,
  collectUnknownWords,
  extractCompletionContent,
  findDeterministicCorrections,
  groupCorrections,
  parseOutboxContent,
  planBatches,
  rewriteOutbox,
  selectCandidates,
  validateAuditResponse,
  validatePlan,
} from '../src/utils/spellingAudit.js';

/** @typedef {import('../src/utils/spellingAudit.js').EntryCorrection} EntryCorrection */
/** @typedef {import('../src/utils/spellingAudit.js').CorrectionGroup} CorrectionGroup */
/** @typedef {import('../src/utils/spellingAudit.js').Verdict} Verdict */
/** @typedef {import('../src/utils/spellingAudit.js').AuditError} AuditError */

const USAGE = `Usage: node scripts/audit-spelling.js [--apply] [--no-llm] [--save-plan <file>] [--from-plan <file>]

Find English word lookups whose input was misspelled and record the intended
spelling (correctedInput) in the outbox. Dry-run unless --apply is given.

  --apply             rewrite the outbox (backup written first)
  --no-llm            deterministic pass only (no API calls)
  --save-plan <file>  write the corrections found as a reviewable JSON plan
  --from-plan <file>  use a (reviewed, possibly edited) plan instead of auditing
  -h, --help          show this help

Env: DEEPSEEK_API_KEY (required for the LLM pass), DEEPSEEK_MODEL, DEEPSEEK_API_URL.`;

const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_ERROR_BODY = 300;

/**
 * @param {string[]} argv
 * @returns {{ apply: boolean, llm: boolean, savePlan: string|null, fromPlan: string|null, help: boolean }}
 * @throws {TypeError} on unknown, malformed or conflicting flags
 */
function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: 'boolean', default: false },
      'no-llm': { type: 'boolean', default: false },
      'save-plan': { type: 'string' },
      'from-plan': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values['from-plan'] && values['save-plan']) throw new TypeError('--from-plan and --save-plan are exclusive');
  return {
    apply: Boolean(values.apply),
    llm: !values['no-llm'] && !values['from-plan'],
    savePlan: values['save-plan'] ? path.resolve(values['save-plan']) : null,
    fromPlan: values['from-plan'] ? path.resolve(values['from-plan']) : null,
    help: Boolean(values.help),
  };
}

/**
 * Read the outbox. A missing file is an error here: there is nothing to audit
 * and it most likely means the wrong config dir.
 * @param {string} outboxPath
 * @returns {string}
 * @throws when the file cannot be read
 */
function readOutboxRaw(outboxPath) {
  try {
    return fs.readFileSync(outboxPath, 'utf8');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    throw new Error(missing ? `outbox not found: ${outboxPath}` : `cannot read outbox ${outboxPath}: ${errorMessage(error)}`);
  }
}

/**
 * One non-streaming chat completion. Errors carry status and the API's own
 * message only, never request headers (the key).
 * @param {readonly string[]} words
 * @param {{ apiUrl: string, apiKey: string, model: string }} api
 * @returns {Promise<string>} assistant message content
 */
async function requestBatch(words, { apiUrl, apiKey, model }) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(buildAuditRequest(words, model)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${apiErrorMessage(text) ?? response.statusText}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`response body is not JSON: ${errorMessage(error)}`);
  }
  const content = extractCompletionContent(body);
  if (!content.ok) throw new Error(content.error);
  return content.content;
}

/** @param {string} text @returns {string|null} */
function apiErrorMessage(text) {
  try {
    const message = JSON.parse(text)?.error?.message;
    return typeof message === 'string' ? message.slice(0, MAX_ERROR_BODY) : null;
  } catch {
    return text.trim() ? text.trim().slice(0, MAX_ERROR_BODY) : null;
  }
}

/**
 * Run the LLM pass over the given words. Batch failures become AuditErrors.
 * @param {readonly string[]} words
 * @returns {Promise<{ model: string|null, requests: number, verdicts: Verdict[], errors: AuditError[] }>}
 */
async function runLlmPass(words) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  if (words.length === 0) return { model, requests: 0, verdicts: [], errors: [] };
  if (!apiKey) {
    return { model, requests: 0, verdicts: [], errors: [{ word: null, reason: 'DEEPSEEK_API_KEY is not set (use --no-llm to skip the LLM pass)' }] };
  }
  const plan = planBatches(words);
  if (!plan.ok) return { model, requests: 0, verdicts: [], errors: [{ word: null, reason: `LLM pass skipped: ${plan.error}` }] };
  const rejected = plan.rejected.map((word) => ({ word, reason: 'not a single English token, not sent' }));
  const api = { apiUrl: process.env.DEEPSEEK_API_URL || DEFAULT_API_URL, apiKey, model };
  const results = await Promise.all(plan.batches.map(async (batch, index) => {
    try {
      return validateAuditResponse(batch, await requestBatch(batch, api));
    } catch (error) {
      return { verdicts: [], errors: [{ word: null, reason: `batch ${index + 1} (${batch.length} words) failed: ${errorMessage(error)}` }] };
    }
  }));
  return {
    model,
    requests: plan.batches.length,
    verdicts: results.flatMap((r) => r.verdicts),
    errors: [...rejected, ...results.flatMap((r) => r.errors)],
  };
}

/**
 * Corrections from a reviewed plan file.
 * @param {string} planPath
 * @param {import('@t-cli/core/entry').Entry[]} entries
 * @returns {{ corrections: EntryCorrection[], alreadySet: number }}
 * @throws when the plan cannot be read or does not match the outbox
 */
function loadPlan(planPath, entries) {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read plan ${planPath}: ${errorMessage(error)}`);
  }
  const result = validatePlan(plan, entries);
  if (!result.ok) throw new Error(`plan ${planPath} rejected:\n  ${result.errors.join('\n  ')}`);
  return result;
}

/**
 * Rewrite the outbox: backup, rewrite affected lines, carry over lines
 * appended since `original` was read, temp file + rename
 * (`replaceOutboxContent`, shared with the sync client).
 * @param {string} original content the corrections were computed from
 * @param {ReadonlyMap<string, string>} correctionsById
 * @returns {{ ok: true, backup: string, rewrite: ReturnType<typeof rewriteOutbox>, tailBytes: number }
 *         | { ok: false, error: string, backup: string|null }}
 */
function applyCorrections(original, correctionsById) {
  const rewrite = rewriteOutbox(original, correctionsById);
  if (rewrite.updated.length === 0) return { ok: true, backup: '', rewrite, tailBytes: 0 };
  const result = replaceOutboxContent({ original, rewritten: rewrite.content, backup: true });
  if (!result.ok) return { ok: false, error: result.error, backup: result.backup };
  return { ok: true, backup: result.backup ?? '', rewrite, tailBytes: Buffer.byteLength(result.tail) };
}

// ---------------------------------------------------------------- reporting

const OUTPUT_HEAD_LABEL = Object.freeze({ echoed: 'echoed', differs: 'head corrected', none: 'no head term' });
const line = (label, value) => console.log(`  ${`${label}:`.padEnd(26)}${value}`);

/** @param {string} title @param {readonly CorrectionGroup[]} groups */
function printGroups(title, groups) {
  const entries = groups.reduce((n, g) => n + g.entries.length, 0);
  console.log(`\n${title} (${groups.length} words, ${entries} entries):`);
  if (groups.length === 0) console.log('  (none)');
  const width = Math.max(0, ...groups.map((g) => `${g.input} → ${g.correction}`.length));
  for (const g of groups) {
    const dates = g.entries.map((e) => `${e.createdAt.slice(0, 10)} ${OUTPUT_HEAD_LABEL[e.outputHead]}`).join(', ');
    console.log(`  ${`${g.input} → ${g.correction}`.padEnd(width)}  ${g.entries.length}× [${dates}]`);
  }
}

/** @param {readonly EntryCorrection[]} corrections */
function printOutputHeadSummary(corrections) {
  const count = (head) => corrections.filter((c) => c.outputHead === head).length;
  console.log('\nStored output of the misspelled entries:');
  line('echoed the misspelling', `${count('echoed')} (head term == misspelled input)`);
  line('head term already fixed', `${count('differs')}`);
  line('no head term', `${count('none')} (output is a bare translation)`);
}

function printReport({ options, outboxPath, outbox, candidates, words, deterministic, llm, corrections, unknown, alreadySet }) {
  const mode = options.apply ? 'APPLY' : 'DRY RUN: nothing written';
  console.log(`t-cli spelling audit (${mode})`);
  line('outbox', `${outboxPath} (${outbox.entries.length} entries, ${outbox.invalidLines} invalid lines)`);
  line('candidates', `${candidates.length} English word lookups without correctedInput`);
  line('distinct words', words.length);
  if (options.fromPlan) {
    line('plan', options.fromPlan);
    line('plan already applied', alreadySet);
  } else {
    line('deterministic pass', `${deterministic.length} entries corrected`);
    line('llm pass', options.llm
      ? `${llm.model}, ${llm.requests} request(s) for ${llm.wordsSent} words (≤ ${MAX_WORDS_PER_REQUEST}/request, ≤ ${MAX_REQUESTS} requests)`
      : 'skipped (--no-llm)');
    if (options.llm) {
      line('llm verdicts', `${llm.verdicts.length} (correct ${llm.verdicts.filter((v) => v.status === 'correct').length}, `
        + `misspelled ${llm.verdicts.filter((v) => v.status === 'misspelled').length}, unknown ${unknown.length})`);
      line('llm errors', llm.errors.length);
    }
  }
  const bySource = (source) => groupCorrections(corrections.filter((c) => c.source === source));
  if (options.fromPlan) printGroups('Corrections from plan', bySource('plan'));
  else {
    printGroups('Deterministic corrections (output head term differs from input)', bySource('deterministic'));
    if (options.llm) printGroups('LLM corrections', bySource('llm'));
  }
  if (unknown.length > 0) {
    console.log(`\nUnknown words, no correction (${unknown.length}):`);
    for (const u of unknown) console.log(`  ${u.word}  ${u.dates.length}× [${u.dates.join(', ')}]`);
  }
  if (llm.errors.length > 0) {
    console.log(`\nLLM errors, not applied (${llm.errors.length}):`);
    for (const e of llm.errors) console.log(`  ${e.word ? `${e.word}: ` : ''}${e.reason}`);
  }
  printOutputHeadSummary(corrections);
}

function printApplyResult(result) {
  console.log('\nApply:');
  if (!result.ok) {
    line('result', `FAILED, ${result.error}`);
    if (result.backup) line('backup', result.backup);
    return;
  }
  const { rewrite } = result;
  line('entries updated', rewrite.updated.length);
  line('already set (skipped)', rewrite.alreadySet.length);
  if (result.backup) line('backup', result.backup);
  if (result.tailBytes > 0) line('concurrent tail kept', `${result.tailBytes} bytes appended during the run`);
  const problems = [
    ...rewrite.conflicts.map((c) => `${c.id}: has correctedInput ${JSON.stringify(c.existing)}, wanted ${JSON.stringify(c.wanted)}`),
    ...rewrite.invalid.map((i) => `${i.id}: invalid after update: ${i.errors.join('; ')}`),
    ...rewrite.notFound.map((id) => `${id}: not found in outbox`),
  ];
  if (problems.length > 0) {
    console.log(`\nNot applied (${problems.length}):`);
    for (const p of problems) console.log(`  ${p}`);
  }
}

// --------------------------------------------------------------------- main

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
async function main(argv) {
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
    const outboxPath = getOutboxPath();
    const original = readOutboxRaw(outboxPath);
    const outbox = parseOutboxContent(original);
    const candidates = selectCandidates(outbox.entries);
    const words = collectDistinctWords(candidates);

    let deterministic = [];
    let corrections;
    let alreadySet = 0;
    let llm = { model: null, requests: 0, wordsSent: 0, verdicts: [], errors: [] };
    if (options.fromPlan) {
      ({ corrections, alreadySet } = loadPlan(options.fromPlan, outbox.entries));
    } else {
      deterministic = findDeterministicCorrections(candidates);
      const fixedIds = new Set(deterministic.map((c) => c.id));
      const remaining = collectDistinctWords(candidates.filter((e) => !fixedIds.has(e.id)));
      if (options.llm) llm = { ...(await runLlmPass(remaining)), wordsSent: remaining.length };
      corrections = buildCorrections({ candidates, deterministic, verdicts: llm.verdicts });
    }
    const unknown = collectUnknownWords(candidates, llm.verdicts);
    printReport({ options, outboxPath, outbox, candidates, words, deterministic, llm, corrections, unknown, alreadySet });

    if (options.savePlan) {
      const plan = buildPlan(corrections, { generatedAt: new Date().toISOString(), outbox: outboxPath });
      fs.writeFileSync(options.savePlan, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      console.log(`\nPlan written: ${options.savePlan} (${corrections.length} corrections)`);
    }
    if (!options.apply) return llm.errors.length > 0 ? 1 : 0;

    const result = applyCorrections(original, new Map(corrections.map((c) => [c.id, c.correction])));
    printApplyResult(result);
    const rewriteProblems = result.ok
      ? result.rewrite.conflicts.length + result.rewrite.invalid.length + result.rewrite.notFound.length
      : 1;
    return rewriteProblems > 0 || llm.errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Spelling audit aborted: ${errorMessage(error)}`);
    return 1;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

process.exitCode = await main(process.argv.slice(2));
