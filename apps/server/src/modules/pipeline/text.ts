import { detectSourceLang } from '@t-cli/core/detect';
import { extractHeadTerm } from '@t-cli/core/spelling';

/**
 * Pure text helpers: what of a raw record the pipeline looks at, dedup keys,
 * and the `<source>` data convention for prompts.
 */

/** The fields of a stored entry the pipeline reads. */
export interface RecordFields {
  id: string;
  seq: number;
  task: 'translate' | 'check';
  kind: 'word' | 'sentence' | 'paragraph';
  input: string;
  output: string;
  srcLang: 'zh' | 'en' | 'other' | null;
  mode: 'simple' | 'detail';
  correctedInput: string | null;
  createdAt: Date;
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

export const containsCjk = (text: string): boolean => CJK_RE.test(text);

const codePoints = (text: string): number => [...text].length;

/** Trim to at most `max` code points. */
export function clip(text: string, max: number): string {
  return codePoints(text) <= max ? text : [...text].slice(0, max).join('');
}

const firstNonEmptyLine = (text: string): string =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\*\*/g, '').trim())
    .find((line) => line !== '') ?? '';

/** The model's main answer: the whole output in simple mode, its first line in detail mode (the prompts put the best answer there). */
export function mainAnswer(record: Pick<RecordFields, 'output' | 'mode'>): string {
  return record.mode === 'simple' ? record.output.replace(/\*\*/g, '').trim() : firstNonEmptyLine(record.output);
}

export const sourceLangOf = (record: Pick<RecordFields, 'srcLang' | 'input'>): 'zh' | 'en' | 'other' =>
  record.srcLang ?? detectSourceLang(record.input);

/**
 * The English and Chinese sides of a translate record: an English source →
 * (input, answer); a Chinese source → (answer, input); any other language
 * has no English side (its answer is Chinese).
 */
export function sidesOf(record: RecordFields): { en: string | null; zh: string | null } {
  const lang = sourceLangOf(record);
  if (lang === 'en') return { en: record.input, zh: mainAnswer(record) || null };
  if (lang === 'zh') return { en: mainAnswer(record) || null, zh: record.input };
  return { en: null, zh: null };
}

/** A grammar check: what the learner wrote and the corrected text (the answer's first line). */
export function checkSides(record: RecordFields): { original: string; corrected: string } {
  return { original: record.input, corrected: mainAnswer(record) };
}

/**
 * The head of a word lookup (docs/api-v1.md, Nightly pipeline): the spelling
 * correction if there was one, else the term before the IPA. Null when the
 * answer has no "term /ipa/" head, i.e. the word was not recognized.
 */
export function wordHeadOf(record: Pick<RecordFields, 'correctedInput' | 'output'>): string | null {
  const head = record.correctedInput ?? extractHeadTerm(record.output);
  const trimmed = head?.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed : null;
}

// ---------------------------------------------------------------- dedup keys

const straightQuotes = (text: string): string => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const collapse = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** An English word or short term: letters, apostrophes and hyphens, 1–4 tokens. */
export const WORD_TEXT_RE = /^[A-Za-z][A-Za-z'-]*(?: [A-Za-z][A-Za-z'-]*){0,3}$/;
export const GRAMMAR_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function cleanWord(text: string): string | null {
  const word = collapse(straightQuotes(text));
  return word.length <= 40 && WORD_TEXT_RE.test(word) ? word : null;
}

export const wordKey = (word: string): string => collapse(straightQuotes(word)).toLowerCase();

/** An English expression: 2–10 tokens of printable ASCII (no CJK), at most 80 characters. */
export function cleanPhrase(text: string, maxWords = 10): string | null {
  const phrase = collapse(straightQuotes(text)).replace(/^[\s"'.,;:!?]+|[\s"'.,;:]+$/g, '');
  const words = phrase.split(' ').filter(Boolean);
  if (phrase.length > 80 || words.length < 2 || words.length > maxWords) return null;
  if (!/^[\x20-\x7e]+$/.test(phrase) || !/[A-Za-z]/.test(phrase)) return null;
  return phrase;
}

export const phraseKey = (phrase: string): string => collapse(straightQuotes(phrase)).toLowerCase().replace(/[.!?]+$/, '');

export const wordCount = (text: string): number => collapse(text).split(' ').filter(Boolean).length;

// ------------------------------------------------------ finding a target text

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Irregular forms of verbs that commonly start phrases ("be supposed to", "get rid of", …). */
const IRREGULAR: Readonly<Record<string, readonly string[]>> = {
  be: ['am', 'is', 'are', 'was', 'were', 'been', 'being'],
  have: ['has', 'had', 'having'],
  do: ['does', 'did', 'done', 'doing'],
  go: ['goes', 'went', 'gone', 'going'],
  get: ['gets', 'got', 'gotten', 'getting'],
  make: ['makes', 'made', 'making'],
  take: ['takes', 'took', 'taken', 'taking'],
  come: ['comes', 'came', 'coming'],
  give: ['gives', 'gave', 'given', 'giving'],
  keep: ['keeps', 'kept', 'keeping'],
  bring: ['brings', 'brought', 'bringing'],
  think: ['thinks', 'thought', 'thinking'],
  break: ['breaks', 'broke', 'broken', 'breaking'],
  catch: ['catches', 'caught', 'catching'],
  run: ['runs', 'ran', 'running'],
  put: ['puts', 'putting'],
  set: ['sets', 'setting'],
  find: ['finds', 'found', 'finding'],
};

/** Regular (and a few irregular) inflections of one English word, as a regex alternation. */
function inflections(word: string): string {
  const lower = word.toLowerCase();
  const forms = new Set([lower, `${lower}s`, `${lower}es`, `${lower}d`, `${lower}ed`, `${lower}ing`, `${lower}er`, `${lower}est`]);
  for (const form of IRREGULAR[lower] ?? []) forms.add(form);
  if (lower.length > 2 && lower.endsWith('e')) {
    const stem = lower.slice(0, -1);
    for (const suffix of ['ing', 'ed', 'er', 'est']) forms.add(stem + suffix);
  }
  if (lower.length > 2 && lower.endsWith('y')) {
    const stem = lower.slice(0, -1);
    for (const suffix of ['ies', 'ied', 'ier', 'iest']) forms.add(stem + suffix);
  }
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(lower)) {
    const doubled = lower + lower.slice(-1);
    for (const suffix of ['ing', 'ed', 'er', 'est']) forms.add(doubled + suffix);
  }
  return [...forms]
    .sort((a, b) => b.length - a.length)
    .map((form) => escapeRegExp(form).replace(/'/g, "['’]"))
    .join('|');
}

/**
 * The first occurrence of `target` in `sentence`, ignoring case, allowing a
 * regular inflection of its first word ("look forward to" matches "looking
 * forward to"). Null when absent.
 */
export function findTarget(sentence: string, target: string): { index: number; text: string } | null {
  const tokens = collapse(straightQuotes(target)).split(' ').filter(Boolean);
  const [first, ...rest] = tokens;
  if (!first) return null;
  const tail = rest.map((token) => `\\s+${escapeRegExp(token).replace(/'/g, "['’]")}`).join('');
  const re = new RegExp(`(?<![A-Za-z])(?:${inflections(first)})${tail}(?![A-Za-z])`, 'i');
  const match = re.exec(sentence);
  return match ? { index: match.index, text: match[0] } : null;
}

// --------------------------------------------------------- prompt data blocks

/**
 * User text in a prompt is always data inside <source> tags (the same
 * convention as buildSourceMessage in @t-cli/core/prompts). The payload is
 * JSON with "<" and ">" escaped, so no value can close the tag.
 */
export function sourceBlock(payload: unknown): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<source>\n${json}\n</source>`;
}
