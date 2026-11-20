/**
 * Push the outbox to the server in batches (`POST /v1/entries`).
 *
 * Per batch: read the raw outbox, send up to PUSH_BATCH_SIZE valid entries,
 * then rewrite the outbox from the content that was read, dropping exactly
 * the `accepted` ids of that batch and moving `rejected` entries to
 * `outbox.rejected.jsonl`. The rewrite goes through `replaceOutboxContent`,
 * which keeps lines appended while the request was in flight and aborts if
 * the file changed in any other way (then the batch is simply re-sent next
 * time — pushes are idempotent).
 *
 * Locally invalid lines are never sent and never removed; they are counted.
 */
import { parseEntryLine } from '@t-cli/core/entry';
import { appendRejectedLines, readOutboxContent, replaceOutboxContent } from '../entryLog.js';
import { SyncError } from './client.js';

/** @typedef {import('@t-cli/core/entry').Entry} Entry */
/** @typedef {import('./client.js').PushResult} PushResult */
/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/**
 * @typedef {{ lineIndex: number, entry: Entry, raw: string }} BatchItem
 * @typedef {{ items: BatchItem[], pending: number, invalidLines: number }} Batch
 * @typedef {{ attempted: boolean, batches: number, accepted: number, rejected: number,
 *             remaining: number, invalidLines: number, error: SyncError | null }} PushSummary
 */

export const PUSH_BATCH_SIZE = 200;
/** Keep each request well under the server's 8 MiB body limit. */
export const PUSH_BATCH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Pick the next batch from raw outbox content (first valid entries, in file
 * order) and count everything pending.
 * @param {string} content
 * @param {{ maxEntries?: number, maxBytes?: number }} [limits]
 * @returns {Batch}
 */
export function selectBatch(content, { maxEntries = PUSH_BATCH_SIZE, maxBytes = PUSH_BATCH_MAX_BYTES } = {}) {
  /** @type {BatchItem[]} */
  const items = [];
  let pending = 0;
  let invalidLines = 0;
  let bytes = 0;
  let full = false;
  content.split('\n').forEach((line, lineIndex) => {
    if (line.trim() === '') return;
    const parsed = parseEntryLine(line);
    if (!parsed.ok) {
      invalidLines += 1;
      return;
    }
    pending += 1;
    if (full) return;
    const size = Buffer.byteLength(line);
    if (items.length >= maxEntries || (items.length > 0 && bytes + size > maxBytes)) {
      full = true;
      return;
    }
    bytes += size;
    items.push({ lineIndex, entry: parsed.entry, raw: line.endsWith('\r') ? line.slice(0, -1) : line });
  });
  return { items, pending, invalidLines };
}

/**
 * Work out the outbox content after a push. Only ids that were in the batch
 * count as accepted (a confused server cannot delete other lines); every
 * outbox line carrying an accepted id is dropped. Rejected entries are
 * dropped too when `moveRejected`, and returned as rejected-file lines.
 * @param {string} content the content the batch was selected from
 * @param {readonly BatchItem[]} items
 * @param {PushResult} result
 * @param {{ rejectedAt: string, moveRejected?: boolean }} options
 * @returns {{ content: string, accepted: string[], rejectedLines: string[], removed: number }}
 */
export function applyPushResult(content, items, result, { rejectedAt, moveRejected = true }) {
  const batchIds = new Set(items.map((item) => item.entry.id));
  const accepted = new Set(result.accepted.filter((id) => batchIds.has(id)));
  /** @type {Set<number>} */
  const drop = new Set();
  /** @type {string[]} */
  const rejectedLines = [];
  for (const rejection of result.rejected) {
    const item = items[rejection.index];
    if (!item || accepted.has(item.entry.id)) continue;
    if (rejection.id !== null && rejection.id !== item.entry.id) continue; // index/id disagree: keep it
    if (moveRejected) drop.add(item.lineIndex);
    rejectedLines.push(JSON.stringify({ rejectedAt, errors: rejection.errors, entry: JSON.parse(item.raw) }));
  }
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (accepted.size === 0 || drop.has(index)) return;
    const parsed = parseEntryLine(line);
    if (parsed.ok && accepted.has(parsed.entry.id)) drop.add(index);
  });
  return {
    content: lines.filter((_, index) => !drop.has(index)).join('\n'),
    accepted: [...accepted],
    rejectedLines: moveRejected ? rejectedLines : [],
    removed: drop.size,
  };
}

/**
 * Push everything pending, batch by batch. Stops at the first error (the
 * caller decides about retries). Never throws.
 * @param {{ client: SyncClient, signal?: AbortSignal, batchSize?: number, now?: () => Date }} args
 * @returns {Promise<PushSummary>}
 */
export async function pushOutbox({ client, signal, batchSize = PUSH_BATCH_SIZE, now = () => new Date() }) {
  /** @type {PushSummary} */
  let summary = { attempted: false, batches: 0, accepted: 0, rejected: 0, remaining: 0, invalidLines: 0, error: null };
  for (;;) {
    const read = readOutboxContent();
    if (!read.ok) return { ...summary, error: localError(`cannot read outbox: ${read.error}`) };
    const batch = selectBatch(read.content, { maxEntries: batchSize });
    summary = { ...summary, remaining: batch.pending, invalidLines: batch.invalidLines };
    if (batch.items.length === 0 || signal?.aborted) return summary;

    let result;
    try {
      summary = { ...summary, attempted: true };
      result = await client.pushEntries(batch.items.map((item) => item.entry), { signal });
    } catch (error) {
      return { ...summary, error: asSyncError(error) };
    }

    const step = commitBatch(read.content, batch.items, result, now());
    summary = {
      ...summary,
      batches: summary.batches + 1,
      accepted: summary.accepted + step.accepted,
      rejected: summary.rejected + step.rejected,
      remaining: Math.max(0, batch.pending - step.accepted - step.rejected),
    };
    if (step.error) return { ...summary, error: step.error };
    if (step.removed === 0) return summary; // no progress: never loop on the same batch
  }
}

/**
 * Persist one push result: rejected lines first (so nothing is lost if the
 * rewrite fails), then the outbox rewrite.
 * @param {string} original
 * @param {readonly BatchItem[]} items
 * @param {PushResult} result
 * @param {Date} at
 * @returns {{ accepted: number, rejected: number, removed: number, error: SyncError | null }}
 */
function commitBatch(original, items, result, at) {
  const rejectedAt = at.toISOString();
  let applied = applyPushResult(original, items, result, { rejectedAt });
  let rejectError = null;
  if (applied.rejectedLines.length > 0) {
    const moved = appendRejectedLines(applied.rejectedLines);
    if (!moved.ok) {
      rejectError = localError(`cannot write outbox.rejected.jsonl: ${moved.error}`);
      applied = applyPushResult(original, items, result, { rejectedAt, moveRejected: false });
    }
  }
  if (applied.removed === 0) return { accepted: 0, rejected: 0, removed: 0, error: rejectError };
  const replaced = replaceOutboxContent({ original, rewritten: applied.content });
  if (!replaced.ok) return { accepted: 0, rejected: 0, removed: 0, error: localError(`outbox not updated (${replaced.error}); will retry`) };
  return { accepted: applied.accepted.length, rejected: applied.rejectedLines.length, removed: applied.removed, error: rejectError };
}

/** @param {string} message @returns {SyncError} */
function localError(message) {
  return new SyncError({ kind: 'local', code: 'LOCAL_IO', message });
}

/** @param {unknown} error @returns {SyncError} */
function asSyncError(error) {
  if (error instanceof SyncError) return error;
  return new SyncError({ kind: 'protocol', code: 'CLIENT_ERROR', message: error instanceof Error ? error.message : String(error) });
}
