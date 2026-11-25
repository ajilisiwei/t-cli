import { exercisesFor, type Exercises } from '../pipeline/learnContent.ts';
import type { DailyMaterial } from '../pipeline/materials.ts';
import type { ExplanationLang } from '../pipeline/schemas.ts';
import { estimatePages } from './materialPages.ts';
import type { UnitReason } from './materialReasons.ts';
import type { MaterialKind, MaterialRow } from './materials.ts';

/**
 * What the API shows of a stored material (docs/api-v1.md, "v3 →
 * Materials"): list items with a server-built title, subtitle, counts and
 * estimated pages, and material responses with the derived exercises. Pure;
 * stored content is read field by field, so an older or partial shape never
 * fails a request.
 */

export interface MaterialCounts {
  words: number;
  phrases: number;
  grammar: number;
  exercises: number;
  /** Extension items. */
  items: number;
}

export interface MaterialListItem {
  kind: MaterialKind;
  date: string;
  title: string;
  /** extend: its first reason; null for the other kinds. */
  subtitle: string | null;
  counts: MaterialCounts;
  readAt: string | null;
  pages: number;
  createdAt: string;
}

export interface MaterialResponse {
  date: string;
  kind: MaterialKind;
  createdAt: string;
  readAt: string | null;
  content: Record<string, unknown>;
  /** daily and digest: derived from the content, never stored. */
  exercises?: Exercises;
  /** extend: per item, the account already has a unit with that text. */
  known?: boolean[];
  /** daily and digest: why each word and phrase was picked, by item id. */
  reasons?: Record<string, UnitReason>;
}

/** What a material response carries beside the stored content. */
export interface ResponseExtras {
  known?: boolean[];
  reasons?: Record<string, UnitReason>;
}

type Practicable = Pick<DailyMaterial, 'words' | 'phrases' | 'grammar'>;

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isExample = (value: unknown): boolean => isRecord(value) && typeof value.en === 'string' && typeof value.zh === 'string';
const hasExamples = (value: Record<string, unknown>): boolean => Array.isArray(value.examples) && value.examples.every(isExample);
const isFixPair = (value: unknown): boolean => isRecord(value) && typeof value.wrong === 'string' && typeof value.right === 'string';

/** The words, phrases and grammar points of a daily material or digest that exercisesFor can use. */
export function practicableOf(content: Record<string, unknown>): Practicable {
  const words = arrayOf(content.words).filter(
    (word) => isRecord(word) && typeof word.itemId === 'string' && typeof word.headword === 'string' && hasExamples(word),
  );
  const phrases = arrayOf(content.phrases).filter(
    (phrase) => isRecord(phrase) && typeof phrase.itemId === 'string' && typeof phrase.phrase === 'string' && hasExamples(phrase),
  );
  const grammar = arrayOf(content.grammar).filter(
    (point) => isRecord(point) && typeof point.itemId === 'string' && Array.isArray(point.exercises) && point.exercises.every(isFixPair),
  );
  return { words, phrases, grammar } as Practicable;
}

const hasExercises = (kind: MaterialKind): boolean => kind === 'daily' || kind === 'digest';

export function exercisesOf(row: Pick<MaterialRow, 'kind' | 'content'>): Exercises | null {
  return hasExercises(row.kind) ? exercisesFor(practicableOf(row.content)) : null;
}

export function countsOf(row: Pick<MaterialRow, 'kind' | 'content'>, exercises: Exercises | null): MaterialCounts {
  const { kind, content } = row;
  if (kind === 'extend') return { words: 0, phrases: 0, grammar: 0, exercises: 0, items: arrayOf(content.items).length };
  if (kind === 'weekly') return { words: 0, phrases: 0, grammar: 0, exercises: 0, items: 0 };
  return {
    words: arrayOf(content.words).length,
    phrases: arrayOf(content.phrases).length,
    grammar: arrayOf(content.grammar).length,
    exercises: exercises ? exercises.cloze.length + exercises.translate.length + exercises.fix.length : 0,
    items: 0,
  };
}

// ------------------------------------------------------------------ titles

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The main count of a daily material or digest: words, else phrases, else grammar points (null: none). */
function mainCount(counts: MaterialCounts, lang: ExplanationLang): string | null {
  if (counts.words > 0) return lang === 'zh' ? `${counts.words} 个词` : plural(counts.words, 'word', 'words');
  if (counts.phrases > 0) return lang === 'zh' ? `${counts.phrases} 个词组` : plural(counts.phrases, 'phrase', 'phrases');
  if (counts.grammar > 0) return lang === 'zh' ? `${counts.grammar} 个语法点` : plural(counts.grammar, 'grammar point', 'grammar points');
  return null;
}

function dailyTitle(content: Record<string, unknown>, counts: MaterialCounts, lang: ExplanationLang): string {
  const main = mainCount(counts, lang);
  const story = isRecord(content.story);
  const mistakes = arrayOf(content.mistakes).length;
  if (lang === 'zh') {
    if (main) return story ? `${main}和一篇短文` : main;
    if (story) return '一篇短文';
    return mistakes > 0 ? `${mistakes} 个易错点` : '今日回顾';
  }
  if (main) return story ? `${main} and a short story` : main;
  if (story) return 'A short story';
  return mistakes > 0 ? plural(mistakes, 'tricky item', 'tricky items') : 'Daily review';
}

function digestTitle(content: Record<string, unknown>, counts: MaterialCounts, lang: ExplanationLang): string {
  const main = mainCount(counts, lang);
  const review = arrayOf(content.review).length;
  if (lang === 'zh') {
    if (main) return `7 天合集：${main}`;
    return review > 0 ? `7 天合集：回顾 ${review} 个忘过的` : '7 天合集';
  }
  if (main) return `7-day digest: ${main}`;
  return review > 0 ? `7-day digest: ${plural(review, 'item', 'items')} to revisit` : '7-day digest';
}

function weeklyTitle(content: Record<string, unknown>, lang: ExplanationLang): string {
  const totals = isRecord(content.totals) ? content.totals : {};
  const retention = isRecord(content.retention) ? content.retention.thisWeek : null;
  const reviews = typeof totals.reviews === 'number' ? totals.reviews : 0;
  const records = typeof totals.entries === 'number' ? totals.entries : 0;
  const percent = typeof retention === 'number' ? Math.round(retention * 100) : null;
  if (lang === 'zh') {
    if (reviews === 0) return `本周 ${records} 条记录`;
    return percent === null ? `复习 ${reviews} 次` : `复习 ${reviews} 次，记住 ${percent}%`;
  }
  if (reviews === 0) return `${plural(records, 'record', 'records')} this week`;
  return percent === null ? plural(reviews, 'review', 'reviews') : `${plural(reviews, 'review', 'reviews')}, ${percent}% remembered`;
}

export function titleOf(row: Pick<MaterialRow, 'kind' | 'content'>, counts: MaterialCounts, lang: ExplanationLang): string {
  const { kind, content } = row;
  if (kind === 'extend') return typeof content.title === 'string' && content.title !== '' ? content.title : lang === 'zh' ? '拓展资料' : 'Extension';
  if (kind === 'weekly') return weeklyTitle(content, lang);
  if (kind === 'digest') return digestTitle(content, counts, lang);
  return dailyTitle(content, counts, lang);
}

/** An extension's first reason (trimmed, non-empty); null for the other kinds or without one. */
export function subtitleOf(row: Pick<MaterialRow, 'kind' | 'content'>): string | null {
  if (row.kind !== 'extend') return null;
  const first = arrayOf(row.content.reasons).find((reason): reason is string => typeof reason === 'string' && reason.trim() !== '');
  return first?.trim() ?? null;
}

// ------------------------------------------------------------------ views

export function toListItem(row: MaterialRow, lang: ExplanationLang): MaterialListItem {
  const exercises = exercisesOf(row);
  const counts = countsOf(row, exercises);
  return {
    kind: row.kind,
    date: row.date,
    title: titleOf(row, counts, lang),
    subtitle: subtitleOf(row),
    counts,
    readAt: row.readAt?.toISOString() ?? null,
    pages: estimatePages(row.kind, row.content, exercises),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMaterialResponse(row: MaterialRow, { known, reasons }: ResponseExtras = {}): MaterialResponse {
  const exercises = exercisesOf(row);
  return {
    date: row.date,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    content: row.content,
    ...(exercises ? { exercises } : {}),
    ...(known ? { known } : {}),
    ...(reasons ? { reasons } : {}),
  };
}

/** The extension's items as (type, text) pairs; entries without a usable kind and text are skipped as null. */
export function extendItemsOf(content: Record<string, unknown>): ({ type: 'word' | 'phrase'; text: string } | null)[] {
  return arrayOf(content.items).map((item) =>
    isRecord(item) && (item.kind === 'word' || item.kind === 'phrase') && typeof item.text === 'string' && item.text.trim() !== ''
      ? { type: item.kind, text: item.text }
      : null,
  );
}
