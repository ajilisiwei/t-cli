import { lexiconKey, type LexiconEntry } from './lexicon.ts';

/**
 * Deterministic lemma keys for the lexicon cache (docs/api-v1.md, "v2 →
 * Lookup", Flow): the looked-up text's own key first, then keys English
 * inflection rules derive from it ("decisions" → "decision", "went" → "go",
 * "looking forward to" → "look forward to").
 *
 * Rules overgenerate ("news" → "new", "uses" → "us"), so a derived key only
 * counts as a hit when that entry lists the looked-up text as one of its
 * inflections (see `listsInflection`); everything else is a miss and the
 * model decides the lemma.
 */

/** Common irregular forms whose base form is unambiguous (forms that are headwords of their own, like "left" or "saw", are left out). */
const IRREGULAR: Readonly<Record<string, readonly string[]>> = {
  am: ['be'], is: ['be'], are: ['be'], was: ['be'], were: ['be'], been: ['be'],
  has: ['have'], had: ['have'], does: ['do'], did: ['do'], done: ['do'],
  went: ['go'], gone: ['go'], made: ['make'], took: ['take'], taken: ['take'],
  came: ['come'], gave: ['give'], given: ['give'], got: ['get'], gotten: ['get'],
  kept: ['keep'], brought: ['bring'], thought: ['think'], bought: ['buy'], caught: ['catch'],
  taught: ['teach'], said: ['say'], told: ['tell'], knew: ['know'], known: ['know'],
  grew: ['grow'], grown: ['grow'], threw: ['throw'], thrown: ['throw'], seen: ['see'],
  wrote: ['write'], written: ['write'], spoke: ['speak'], spoken: ['speak'], broke: ['break'],
  chose: ['choose'], chosen: ['choose'], ate: ['eat'], eaten: ['eat'], drove: ['drive'],
  driven: ['drive'], began: ['begin'], begun: ['begin'], ran: ['run'], sang: ['sing'],
  sung: ['sing'], swam: ['swim'], forgot: ['forget'], forgotten: ['forget'], sold: ['sell'],
  slept: ['sleep'], fought: ['fight'], sought: ['seek'], meant: ['mean'], sent: ['send'],
  spent: ['spend'], built: ['build'], heard: ['hear'], held: ['hold'], stood: ['stand'],
  understood: ['understand'], children: ['child'], men: ['man'], women: ['woman'],
  feet: ['foot'], teeth: ['tooth'], mice: ['mouse'], geese: ['goose'],
  worse: ['bad'], worst: ['bad'],
};

const TOKEN_RE = /^[a-z][a-z'-]*$/;
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
/** At most this many keys are read per lookup (the text's own key included). */
const MAX_CANDIDATES = 12;

/** "stopp" → "stop", "runn" → "run": a doubled final consonant before -ed / -ing / -er / -est. */
function undoubled(stem: string): string | null {
  const last = stem.at(-1);
  return stem.length >= 3 && last !== undefined && !VOWELS.has(last) && stem.at(-2) === last ? stem.slice(0, -1) : null;
}

/** Stems of `word` for one suffix: the bare stem, the stem + "e" (making → make) and the undoubled stem (running → run). */
function stemsFor(word: string, suffix: string, minLength: number): string[] {
  if (word.length < minLength || !word.endsWith(suffix)) return [];
  const stem = word.slice(0, -suffix.length);
  return [stem, `${stem}e`, undoubled(stem)].filter((value): value is string => value !== null);
}

/** Possible base forms of one lowercase token, most likely first (the token itself excluded). */
export function baseForms(token: string): string[] {
  if (!TOKEN_RE.test(token)) return [];
  const forms = [
    ...(IRREGULAR[token] ?? []),
    ...(token.length >= 5 && token.endsWith('ies') ? [`${token.slice(0, -3)}y`] : []),
    ...(token.length >= 4 && token.endsWith('s') && !token.endsWith('ss') ? [token.slice(0, -1)] : []),
    ...(token.length >= 4 && token.endsWith('es') ? [token.slice(0, -2)] : []),
    ...(token.length >= 5 && token.endsWith('ied') ? [`${token.slice(0, -3)}y`] : []),
    ...(token.length >= 4 && token.endsWith('ed') ? [token.slice(0, -1)] : []),
    ...stemsFor(token, 'ed', 5),
    ...(token.length >= 5 && token.endsWith('ying') ? [`${token.slice(0, -4)}ie`] : []),
    ...stemsFor(token, 'ing', 5),
    ...(token.length >= 5 && token.endsWith('ier') ? [`${token.slice(0, -3)}y`] : []),
    ...stemsFor(token, 'er', 5),
    ...(token.length >= 6 && token.endsWith('iest') ? [`${token.slice(0, -4)}y`] : []),
    ...stemsFor(token, 'est', 6),
  ];
  return [...new Set(forms)].filter((form) => form !== token && form.length >= 2 && TOKEN_RE.test(form));
}

/**
 * The lexicon keys to read for a looked-up text, in order: its own key, then
 * its base forms (for a phrase, of its first word: "looking forward to" →
 * "look forward to").
 */
export function lemmaCandidates(text: string): string[] {
  const own = lexiconKey(text);
  const [first, ...rest] = own.split(' ');
  const derived = first ? baseForms(first).map((base) => [base, ...rest].join(' ')) : [];
  return [own, ...derived.filter((key) => key !== own)].slice(0, MAX_CANDIDATES);
}

/**
 * Inflection labels the lexicon prompt asks for (both explanation
 * languages). A label counts when it contains one of these, so a combined
 * "过去式/过去分词" counts too; derived-word labels ("名词", "noun") never do.
 */
const INFLECTION_LABELS = ['复数', '第三人称', '过去式', '过去分词', '现在分词', '比较级', '最高级', 'plural', 'third person', 'past', 'participle', 'comparative', 'superlative'];

export const isInflectionLabel = (label: string): boolean => {
  const lower = label.toLowerCase();
  return INFLECTION_LABELS.some((token) => lower.includes(token));
};

/** The entry lists the text with key `key` as one of its inflections. */
export function listsInflection(entry: LexiconEntry, key: string): boolean {
  return entry.forms.some((form) => isInflectionLabel(form.label) && lexiconKey(form.form) === key);
}

/**
 * Whether a freshly generated entry may go into the shared lexicon: its lemma
 * must be the text's own key or one of the derived candidates, or — for a
 * single word only (an irregular form the rules do not know, "mice") — the
 * entry must list the word among its forms. An entry whose lemma is unrelated
 * to what was looked up (a corrected misspelling, or a model steered by
 * crafted text) is returned to the caller but never cached for everyone.
 */
export function mayStore(text: string, entry: LexiconEntry): boolean {
  const key = lexiconKey(entry.lemma);
  if (lemmaCandidates(text).includes(key)) return true;
  const own = lexiconKey(text);
  return TOKEN_RE.test(own) && entry.forms.some((form) => lexiconKey(form.form) === own);
}
