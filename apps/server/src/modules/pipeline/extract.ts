import { askInBatches, byRef, type RunContext } from './llmJson.ts';
import { extractionMessages, type ExtractionRecord } from './prompts.ts';
import type { UnitLink } from './repo.ts';
import { ExtractedRecordSchema, ExtractedUnitSchema, ExtractionEnvelopeSchema } from './schemas.ts';
import {
  checkSides,
  cleanPhrase,
  cleanWord,
  clip,
  findTarget,
  GRAMMAR_SLUG_RE,
  phraseKey,
  sidesOf,
  wordCount,
  wordHeadOf,
  wordKey,
  type RecordFields,
} from './text.ts';

/**
 * Step 1 of the nightly pipeline: records → learning units
 * (docs/api-v1.md, "Nightly pipeline"):
 * - word lookup → one word item (head = correctedInput or the head term;
 *   unrecognizable words are skipped);
 * - sentence → ≤ 2 phrases; check → ≤ 2 grammar points;
 * - paragraph → ≤ 3 units in total, never quoting it (≤ 6 words each).
 * Records with nothing English to learn from (another source language, a
 * lookup without a recognizable head) never reach the model.
 */

export const UNIT_LIMITS = { word: 1, sentence: 2, paragraph: 3, check: 2 } as const;
/** A paragraph unit is a word or a short expression, never a quoted clause. */
const PARAGRAPH_UNIT_MAX_WORDS = 6;
const RECORD_TEXT_MAX = 2000;
const MAX_RECORDS_PER_CALL = 20;
const MAX_CHARS_PER_CALL = 12_000;

/** What the model is asked about one record, with what the server keeps to judge the answer. */
export interface ExtractionPlan {
  record: RecordFields;
  request: ExtractionRecord;
}

/** The model request for a record, or null when the record yields no units without asking. */
export function planRecord(record: RecordFields, ref: string): ExtractionPlan | null {
  if (record.task === 'check') {
    const { original, corrected } = checkSides(record);
    if (!corrected) return null;
    return { record, request: { ref, kind: 'check', original: clip(original, RECORD_TEXT_MAX), corrected: clip(corrected, RECORD_TEXT_MAX) } };
  }
  if (record.kind === 'word') {
    const head = wordHeadOf(record);
    const word = head === null ? null : cleanWord(head);
    return word === null ? null : { record, request: { ref, kind: 'word', head: word } };
  }
  const { en } = sidesOf(record);
  if (!en) return null;
  return { record, request: { ref, kind: record.kind, en: clip(en, RECORD_TEXT_MAX) } };
}

type Unit = { type: 'word' | 'phrase' | 'grammar'; text: string; key?: string | null | undefined };

/** The lemma the model gave when it plausibly belongs to `word` (same first two letters), else the word itself. */
function lemmaKey(word: string, key: string | null | undefined): string {
  const lemma = key ? cleanWord(key) : null;
  return lemma !== null && wordKey(lemma).slice(0, 2) === wordKey(word).slice(0, 2) ? wordKey(lemma) : wordKey(word);
}

function dedup(links: readonly UnitLink[], limit: number): UnitLink[] {
  const seen = new Set<string>();
  const out: UnitLink[] = [];
  for (const link of links) {
    const id = `${link.type}:${link.normKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(link);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * The record's units from the model's answer, after the server's own checks:
 * the unit type fits the record kind, texts are well-formed and actually
 * occur in the record, and the per-kind caps hold. Units that fail are
 * dropped, not retried.
 */
export function unitsFromAnswer(plan: ExtractionPlan, units: readonly Unit[]): UnitLink[] {
  const { record, request } = plan;
  const base = { entryId: record.id, entryCreatedAt: record.createdAt, isCheck: record.task === 'check' };

  if (request.kind === 'word') {
    const unit = units.find((candidate) => candidate.type === 'word');
    if (!unit) return []; // not a recognizable word
    return [{ ...base, type: 'word', normKey: lemmaKey(request.head, unit.key), display: request.head }];
  }

  if (request.kind === 'check') {
    const links = units.flatMap((unit): UnitLink[] => {
      const slug = unit.key?.trim().toLowerCase() ?? '';
      const title = clip(unit.text.trim().replace(/\s+/g, ' '), 80);
      if (unit.type !== 'grammar' || slug.length > 64 || !GRAMMAR_SLUG_RE.test(slug) || !title) return [];
      return [{ ...base, type: 'grammar', normKey: slug, display: title }];
    });
    return dedup(links, UNIT_LIMITS.check);
  }

  const { en } = request;
  const sentenceWords = wordCount(en);
  const isParagraph = request.kind === 'paragraph';
  const links = units.flatMap((unit): UnitLink[] => {
    if (unit.type === 'phrase') {
      const phrase = cleanPhrase(unit.text, isParagraph ? PARAGRAPH_UNIT_MAX_WORDS : 10);
      if (phrase === null || !findTarget(en, phrase)) return [];
      if (!isParagraph && wordCount(phrase) >= sentenceWords) return []; // the whole sentence is not a phrase
      return [{ ...base, type: 'phrase', normKey: phraseKey(phrase), display: phrase }];
    }
    if (unit.type === 'word' && isParagraph) {
      const word = cleanWord(unit.text);
      if (word === null || !findTarget(en, word)) return [];
      const key = lemmaKey(word, unit.key);
      return [{ ...base, type: 'word', normKey: key, display: key === wordKey(word) ? word : key }];
    }
    return [];
  });
  return dedup(links, isParagraph ? UNIT_LIMITS.paragraph : UNIT_LIMITS.sentence);
}

/** Contiguous slices of `records` (seq order) small enough for one extraction call each. */
export function sliceBatches(records: readonly RecordFields[]): RecordFields[][] {
  const batches: RecordFields[][] = [];
  let current: RecordFields[] = [];
  let asked = 0;
  let chars = 0;
  for (const record of records) {
    const plan = planRecord(record, 'r');
    const size = plan ? JSON.stringify(plan.request).length : 0;
    if (plan && current.length > 0 && (asked + 1 > MAX_RECORDS_PER_CALL || chars + size > MAX_CHARS_PER_CALL)) {
      batches.push(current);
      current = [];
      asked = 0;
      chars = 0;
    }
    current.push(record);
    if (plan) {
      asked += 1;
      chars += size;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface ExtractionResult {
  links: UnitLink[];
  /** Records whose answer stayed invalid after every attempt (skipped). */
  failed: number;
}

/** Extract the units of one batch (one model call, plus retries for records whose answers were invalid). */
export async function extractBatch(ctx: RunContext, records: readonly RecordFields[], knownSlugs: readonly string[]): Promise<ExtractionResult> {
  const plans = records.flatMap((record, i) => {
    const plan = planRecord(record, `r${i + 1}`);
    return plan ? [plan] : [];
  });
  const requests = plans.map((plan) => ({ ref: plan.request.ref, plan }));
  let result: ExtractionResult = { links: [], failed: 0 };

  await askInBatches(ctx, {
    requests,
    batchSize: MAX_RECORDS_PER_CALL,
    messagesFor: (batch) => extractionMessages(batch.map((entry) => entry.plan.request), ctx.lang, knownSlugs),
    entriesOf: (answer) => {
      const envelope = ExtractionEnvelopeSchema.safeParse(answer);
      return envelope.success ? byRef(envelope.data.records) : new Map();
    },
    validate: ({ plan }, raw) => {
      const parsed = ExtractedRecordSchema.safeParse(raw);
      if (!parsed.success) return null;
      const units = parsed.data.units.flatMap((unit) => {
        const valid = ExtractedUnitSchema.safeParse(unit);
        return valid.success ? [valid.data] : [];
      });
      return unitsFromAnswer(plan, units);
    },
    onBatch: async ({ done, failed }) => {
      result = { links: [...result.links, ...done.flatMap((entry) => entry.value)], failed: result.failed + failed.length };
    },
  });
  // Retries answer out of order; store in record order so the earliest record names a new item.
  const position = new Map(records.map((record, i) => [record.id, i]));
  const links = [...result.links].sort((a, b) => (position.get(a.entryId) ?? 0) - (position.get(b.entryId) ?? 0));
  return { links, failed: result.failed };
}
