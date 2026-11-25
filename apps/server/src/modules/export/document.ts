/**
 * The data a PDF is typeset from: written to `data.json` next to the fixed
 * Typst templates (templates/*.typ), which read it with `json()` and lay
 * every string out as plain text. Nothing in here is ever Typst source.
 *
 * Every field is always present (empty string / array, or null), so the
 * templates never have to guess.
 */

export type ExportScope = 'material' | 'cards' | 'checklist';
export type ExportLayout = 'read' | 'practice';

/** A run of a story paragraph; `b` = one of the material's words (set in bold). */
export interface Segment {
  t: string;
  b: boolean;
}

export interface WordRow {
  term: string;
  /** Empty when there is none or `ipa` is off. */
  ipa: string;
  /** Why the word is here ("复习时忘了 2 次", "笔记本 · 3 星"), or empty. */
  note: string;
  gloss: string;
  example: string;
  /** The example's translation (read layout), else empty. */
  exampleZh: string;
}

export interface ChecklistRow {
  term: string;
  ipa: string;
  gloss: string;
}

export interface ClozeItem {
  before: string;
  after: string;
  /** Filled in (read layout) or null (practice: the answer is in the answers section). */
  answer: string | null;
}

export interface PromptItem {
  prompt: string;
  answer: string | null;
}

export type ExerciseGroup =
  | { kind: 'cloze'; label: string; bank: string[]; items: ClozeItem[] }
  | { kind: 'translate'; label: string; items: PromptItem[] }
  | { kind: 'fix'; label: string; items: PromptItem[] };

export interface MistakePair {
  title: string;
  wrong: string;
  right: string;
  note: string;
}

export interface Recap {
  term: string;
  note: string;
  example: string;
}

export type Block =
  | { kind: 'words'; num: string; title: string; rows: WordRow[] }
  | { kind: 'story'; num: string; title: string; heading: string; paragraphs: Segment[][]; zh: string | null; hint: string }
  | { kind: 'grammar'; num: string; title: string; rule: string; pairs: MistakePair[] }
  | { kind: 'exercises'; num: string; title: string; groups: ExerciseGroup[] }
  | { kind: 'mistakes'; num: string; title: string; aside: string; pairs: MistakePair[]; recapTitle: string; recaps: Recap[] }
  | { kind: 'checklist'; num: string; title: string; intro: string; rows: ChecklistRow[] };

export interface Stat {
  value: number;
  label: string;
}

/** One material of a `material` export. */
export interface MaterialSection {
  kicker: string;
  title: string;
  subtitle: string;
  stats: Stat[];
  reasons: string[];
  blocks: Block[];
}

export interface AnswerLine {
  label: string;
  text: string;
}

/** Answers of one material (practice layout); `heading` only when the export has several. */
export interface AnswerGroup {
  heading: string | null;
  lines: AnswerLine[];
}

export interface Card {
  term: string;
  ipa: string;
  gloss: string;
  example: string;
  zh: string;
}

export interface PdfDocument {
  scope: ExportScope;
  layout: ExportLayout;
  options: { ipa: boolean; large: boolean };
  /** PDF metadata title. */
  title: string;
  header: { left: string; right: string };
  footer: string;
  sections: MaterialSection[];
  /** Practice layout only; empty otherwise. */
  answers: AnswerGroup[];
  cards: Card[];
  checklist: { heading: string; subtitle: string; intro: string; rows: ChecklistRow[] };
  /** Shown instead of an empty list (cards or checklist with nothing in them), else empty. */
  empty: string;
}
