import { createEntry, validateEntry, type Entry } from '@t-cli/core/entry';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../src/db/client.ts';
import { insertEntries, toIsoWithOffset } from '../../src/db/entriesRepo.ts';
import { cards, items } from '../../src/db/schema.ts';
import type { ChatMessage, JsonCompletion, LlmUsage } from '../../src/ports.ts';
import { fakeLlm, type FakeLlm } from './app.ts';

/**
 * Test support for the nightly pipeline: synthetic records, and a fake LLM
 * that answers every pipeline task with canned, contract-valid JSON built
 * from the request's <source> payload.
 */

export interface RecordSpec {
  input: string;
  output: string;
  task?: 'translate' | 'check';
  srcLang?: 'zh' | 'en' | 'other';
  mode?: 'simple' | 'detail';
  /** ISO 8601 with offset; the entry's local offset is taken from it (e.g. "2026-11-19T10:00:00+08:00"). */
  at: string;
}

const OFFSET_RE = /([+-])(\d{2}):(\d{2})$/;

function offsetOf(iso: string): number {
  const match = OFFSET_RE.exec(iso);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** Store records for an account (independent of the test process's time zone). */
export async function seedRecords(db: Database, userId: string, specs: readonly RecordSpec[]): Promise<Entry[]> {
  const built = specs.map((spec) => {
    const at = new Date(spec.at);
    const draft = createEntry({
      source: 'cli',
      task: spec.task ?? 'translate',
      input: spec.input,
      output: spec.output,
      mode: spec.mode ?? 'simple',
      srcLang: spec.srcLang ?? 'en',
      createdAt: at,
    });
    const result = validateEntry({ ...draft, createdAt: toIsoWithOffset(at, offsetOf(spec.at)) });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.entry;
  });
  await insertEntries(db, userId, built);
  return built;
}

// ------------------------------------------------------------------ fake LLM

export type PipelineTaskName = 'extract' | 'generate' | 'daily' | 'weekly';

export interface SourcePayload {
  task: PipelineTaskName;
  [key: string]: unknown;
}

/** The JSON data block of a pipeline request (the user message's <source> payload). */
export function sourcePayload(messages: readonly ChatMessage[]): SourcePayload {
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  const start = user.indexOf('<source>\n');
  const end = user.lastIndexOf('\n</source>');
  if (start === -1 || end === -1) throw new Error('no <source> block');
  return JSON.parse(user.slice(start + '<source>\n'.length, end)) as SourcePayload;
}

type Unit = { type: 'word' | 'phrase' | 'grammar'; text: string; key?: string };

export interface ScriptOptions {
  /** Units for a sentence/paragraph record, by its English text (default: none). */
  units?: Record<string, readonly Unit[]>;
  /** Grammar units for a check record, by the learner's original (default: one verb-tense point). */
  grammar?: Record<string, readonly Unit[]>;
  /** Word heads the model does not recognize. */
  unrecognized?: readonly string[];
  /**
   * Replace the canned answer: return a value to send it (as JSON), a string
   * to send it verbatim, undefined to keep the canned answer. May throw.
   */
  respond?: (task: PipelineTaskName, payload: SourcePayload, canned: unknown) => unknown;
  /** Usage reported per call (default 1000 prompt + 500 completion). */
  usage?: LlmUsage;
}

type Record_ = { ref: string; kind: string; head?: string; en?: string; original?: string; corrected?: string };

function extractAnswer(payload: SourcePayload, options: ScriptOptions): unknown {
  const records = (payload.records as Record_[]) ?? [];
  return {
    records: records.map((record) => {
      if (record.kind === 'word') {
        const head = record.head ?? '';
        const known = !(options.unrecognized ?? []).includes(head);
        return { ref: record.ref, units: known ? [{ type: 'word', text: head, key: head.toLowerCase() }] : [] };
      }
      if (record.kind === 'check') {
        const units = options.grammar?.[record.original ?? ''] ?? [{ type: 'grammar', key: 'verb-tense', text: '动词时态' }];
        return { ref: record.ref, units };
      }
      return { ref: record.ref, units: options.units?.[record.en ?? ''] ?? [] };
    }),
  };
}

type Sentence = { en: string; zh: string };
type GenItem = { ref: string; headword?: string; phrase?: string; key?: string; title?: string; userSentence?: Sentence; userCheck?: { original: string; corrected: string } };

export function cannedWord(headword: string, userSentence?: Sentence): Record<string, unknown> {
  const own = { en: `I wrote about the ${headword} in my notes.`, zh: '我在笔记里写到了它。', fromUser: false };
  return {
    headword,
    ipa: '/ˈfeɪk/',
    meanings: [
      { pos: 'n.', zh: `${headword} 的中文释义` },
      { pos: 'v.', zh: '第二个义项' },
    ],
    examples: [userSentence ? { ...userSentence, fromUser: true } : { en: `She mentioned the ${headword} twice.`, zh: '她提到了两次。', fromUser: false }, own],
    collocations: [`a ${headword}`, `the ${headword} of`],
    synonyms: [{ word: 'thing', note: '更口语' }],
    family: [`${headword}s`],
  };
}

export function cannedPhrase(phrase: string, userSentence?: Sentence): Record<string, unknown> {
  return {
    phrase,
    zh: `${phrase} 的意思`,
    register: 'neutral',
    alternatives: [
      { en: 'another way', note: '更正式' },
      { en: 'one more way', note: '更随意' },
    ],
    examples: [
      userSentence ? { ...userSentence, fromUser: true } : { en: `We ${phrase} it every year.`, zh: '我们每年都这样。', fromUser: false },
      { en: `They always ${phrase} the weekend.`, zh: '他们总是如此。', fromUser: false },
    ],
  };
}

export function cannedGrammar(title: string, userCheck?: { original: string; corrected: string }): Record<string, unknown> {
  const own = userCheck && userCheck.original !== userCheck.corrected ? userCheck : { original: 'He go to work.', corrected: 'He goes to work.' };
  return {
    title,
    rule: '主语是第三人称单数时，一般现在时的动词要加 -s。',
    wrong: own.original,
    right: own.corrected,
    exercises: [
      { wrong: 'She like tea.', right: 'She likes tea.' },
      { wrong: 'It rain a lot here.', right: 'It rains a lot here.' },
      { wrong: 'My dad work late.', right: 'My dad works late.' },
    ],
  };
}

function generateAnswer(payload: SourcePayload): unknown {
  const list = (payload.items as GenItem[]) ?? [];
  return {
    items: list.map((item) => {
      if (payload.itemType === 'word') return { ref: item.ref, content: cannedWord(item.headword ?? '', item.userSentence) };
      if (payload.itemType === 'phrase') return { ref: item.ref, content: cannedPhrase(item.phrase ?? '', item.userSentence) };
      return { ref: item.ref, content: cannedGrammar(item.title ?? '', item.userCheck) };
    }),
  };
}

/** A ~70-word story that uses the first 5–8 story words. */
export function cannedStory(storyWords: readonly string[]): Record<string, unknown> | null {
  if (storyWords.length < 5) return null;
  const words = storyWords.slice(0, 8);
  const text = `${words.map((word) => `In the morning we talked about the ${word} for a while.`).join(' ')} Then the day went on quietly and everyone went home happy after a long walk.`;
  return { title: 'A quiet day', text, words, zh: '安静的一天：我们聊了很多事情。' };
}

function dailyAnswer(payload: SourcePayload): unknown {
  const mistakes = (payload.mistakes as { ref: string }[]) ?? [];
  return {
    story: cannedStory((payload.storyWords as string[]) ?? []),
    mistakes: mistakes.map((mistake) => ({ ref: mistake.ref, note: '再讲一遍：注意它的用法。', example: { en: 'A brand new example sentence.', zh: '一个全新的例句。' } })),
  };
}

export interface ScriptedLlm extends FakeLlm {
  /** Every completeJson request's payload, in order. */
  payloads: SourcePayload[];
  tasks(): PipelineTaskName[];
}

/** A fake LLM that answers every pipeline task with canned valid JSON (see ScriptOptions to change answers). */
export function scriptedLlm(options: ScriptOptions = {}): ScriptedLlm {
  const payloads: SourcePayload[] = [];
  const usage = options.usage ?? { promptTokens: 1000, completionTokens: 500 };
  const llm = fakeLlm(['ok'], {
    json: (messages): JsonCompletion => {
      const payload = sourcePayload(messages);
      payloads.push(payload);
      const canned =
        payload.task === 'extract'
          ? extractAnswer(payload, options)
          : payload.task === 'generate'
            ? generateAnswer(payload)
            : payload.task === 'daily'
              ? dailyAnswer(payload)
              : { summary: '本周你坚持查词和复习，继续保持。' };
      const answer = options.respond ? options.respond(payload.task, payload, canned) : undefined;
      const value = answer === undefined ? canned : answer;
      return { content: typeof value === 'string' ? value : JSON.stringify(value), usage };
    },
  });
  return Object.assign(llm, { payloads, tasks: () => payloads.map((payload) => payload.task) });
}

// ------------------------------------------------------------------- queries

export async function itemsOf(db: Database, userId: string) {
  return db.select().from(items).where(eq(items.userId, userId)).orderBy(asc(items.type), asc(items.normKey));
}

export async function cardsOf(db: Database, userId: string, itemId?: string) {
  return db
    .select()
    .from(cards)
    .where(itemId ? and(eq(cards.userId, userId), eq(cards.itemId, itemId)) : eq(cards.userId, userId))
    .orderBy(asc(cards.itemId), asc(cards.cardType));
}
