import { exercisesFor, type Exercises } from '../pipeline/learnContent.ts';
import type { DailyContent, DigestContent, ExtendContent, LoadedMaterial } from './content.ts';
import type {
  AnswerLine,
  Block,
  ChecklistRow,
  ExerciseGroup,
  ExportLayout,
  MaterialSection,
  MistakePair,
  Recap,
  Stat,
  WordRow,
} from './document.ts';
import { cnNumeral, dateRangeLabel, glossOfMeanings, isoWeek, monthDay, oneLine, pickExample, TOPIC_LABELS } from './format.ts';
import { storySegments } from './story.ts';

/**
 * One material → one section of a `material` export (docs/v3-plan.html §8,
 * the approved prototype pages): 重点词, 情景短文, 练习, 易错提醒 and, in the
 * practice layout, 自测清单, numbered 一, 二, …; plus the material's lines
 * for the answers section. The read layout prints the answers in place.
 */

export const MATERIAL_PARTS = ['words', 'phrases', 'grammar', 'story', 'exercises'] as const;
export type MaterialPart = (typeof MATERIAL_PARTS)[number];

/** Why a word is in the material, from the account's current data. */
export interface WordNote {
  stars: number;
  lookupCount: number;
  /** Ratings of 忘记 in the last 30 days. */
  lapses: number;
}

export interface SectionOptions {
  layout: ExportLayout;
  ipa: boolean;
  /** settings.materialParts: daily and digest show only these parts. */
  parts: ReadonlySet<MaterialPart>;
  notes: ReadonlyMap<string, WordNote>;
}

export interface BuiltSection {
  section: MaterialSection;
  answers: AnswerLine[];
}

type MakeBlock = (num: string) => Block;

const numbered = (makers: readonly (MakeBlock | null)[]): Block[] =>
  makers.filter((make): make is MakeBlock => make !== null).map((make, index) => make(cnNumeral(index + 1)));

export const CHECKLIST_INTRO = '沿中间虚线向后对折，只看左栏说出意思；说对了在格子里打勾，三遍都对就算记住了。';
const LETTERS = ['A', 'B', 'C', 'D'] as const;
const NBSP = ' ';

export function noteFor(note: WordNote | undefined): string {
  if (!note) return '';
  if (note.lapses > 0) return `复习时忘了 ${note.lapses} 次`;
  if (note.stars > 0) return `笔记本 · ${note.stars} 星`;
  if (note.lookupCount > 0) return `查过 ${note.lookupCount} 次`;
  return '';
}

// ------------------------------------------------------------------ rows

type DailyWord = DailyContent['words'][number];
type DailyPhrase = DailyContent['phrases'][number];

/**
 * The example a table row shows: preferably one the exercises do not use,
 * so the word table does not give the practice answers away.
 */
function rowExample<T extends { en: string; fromUser?: boolean }>(examples: readonly T[], avoid: ReadonlySet<string>): T | undefined {
  return pickExample(examples.filter((example) => !avoid.has(oneLine(example.en)))) ?? pickExample(examples);
}

/** The English sentences the exercises are built from (normalized). */
const exerciseSentences = (exercises: Exercises): ReadonlySet<string> =>
  new Set([
    ...exercises.cloze.map((item) => oneLine(item.before + item.answer + item.after)),
    ...exercises.translate.map((item) => oneLine(item.answer)),
  ]);

function wordRow(word: DailyWord, options: SectionOptions, avoid: ReadonlySet<string>): WordRow {
  const example = rowExample(word.examples, avoid);
  return {
    term: oneLine(word.headword),
    ipa: options.ipa ? oneLine(word.ipa) : '',
    note: noteFor(options.notes.get(word.itemId)),
    gloss: glossOfMeanings(word.meanings),
    example: oneLine(example?.en ?? ''),
    exampleZh: options.layout === 'read' ? oneLine(example?.zh ?? '') : '',
  };
}

function phraseRow(phrase: DailyPhrase, options: SectionOptions, avoid: ReadonlySet<string>): WordRow {
  const example = rowExample(phrase.examples, avoid);
  return {
    term: oneLine(phrase.phrase),
    ipa: '',
    note: noteFor(options.notes.get(phrase.itemId)),
    gloss: oneLine(phrase.zh),
    example: oneLine(example?.en ?? ''),
    exampleZh: options.layout === 'read' ? oneLine(example?.zh ?? '') : '',
  };
}

const checklistRowOf = (row: WordRow): ChecklistRow => ({ term: row.term, ipa: row.ipa, gloss: row.gloss });

// ------------------------------------------------------------- exercises

interface DraftGroup {
  /** The group, given its letter label ("A."). */
  make: (letter: string) => ExerciseGroup;
  answer: string;
}

function exerciseDrafts(exercises: Exercises, layout: ExportLayout): DraftGroup[] {
  const read = layout === 'read';
  const spare = exercises.bank.filter((base) => !exercises.cloze.some((item) => item.base === base));
  const cloze: DraftGroup | null =
    exercises.cloze.length === 0
      ? null
      : {
          make: (letter) => ({
            kind: 'cloze',
            label: `${letter} 选词填空${spare.length > 0 ? '（有一个词用不到）' : ''}`,
            bank: exercises.bank,
            items: exercises.cloze.map((item) => ({ before: item.before, after: item.after, answer: read ? item.answer : null })),
          }),
          // No-break spaces keep "8 follow up on" on one line.
          answer:
            exercises.cloze.map((item, index) => `${index + 1} ${item.answer}`.replace(/ /g, NBSP)).join('　') +
            (spare.length > 0 ? `（${spare.join('、')} 用不到）` : ''),
        };
  const translate: DraftGroup | null =
    exercises.translate.length === 0
      ? null
      : {
          make: (letter) => ({
            kind: 'translate',
            label: `${letter} 中译英`,
            items: exercises.translate.map((item) => ({ prompt: item.zh, answer: read ? item.answer : null })),
          }),
          answer: exercises.translate.map((item, index) => `${index + 1}. ${item.answer}`).join('　'),
        };
  return [cloze, translate, fixDraft(exercises.fix, layout)].filter((draft): draft is DraftGroup => draft !== null);
}

function fixDraft(fix: readonly { wrong: string; right: string }[], layout: ExportLayout): DraftGroup | null {
  if (fix.length === 0) return null;
  return {
    make: (letter) => ({
      kind: 'fix',
      label: `${letter} 改错`,
      items: fix.map((item) => ({ prompt: item.wrong, answer: layout === 'read' ? item.right : null })),
    }),
    answer: fix.map((item, index) => `${index + 1}. ${item.right}`).join('　'),
  };
}

/** Lettered groups (A., B., …) and their answer lines. */
function lettered(drafts: readonly DraftGroup[]): { groups: ExerciseGroup[]; answers: AnswerLine[] } {
  const letter = (index: number): string => `${LETTERS[index] ?? String(index + 1)}.`;
  return {
    groups: drafts.map((draft, index) => draft.make(letter(index))),
    answers: drafts.map((draft, index) => ({ label: letter(index), text: draft.answer })),
  };
}

const exerciseCount = (exercises: Exercises): number => exercises.cloze.length + exercises.translate.length + exercises.fix.length;

// ------------------------------------------------------- daily and digest

function dailyTitle(words: number, story: boolean): string {
  if (words > 0 && story) return `${words} 个词和一篇短文`;
  if (words > 0) return `${words} 个词`;
  return story ? '一篇短文' : '每日资料';
}

interface PeriodicHead {
  kicker: string;
  title: string;
  subtitle: string;
  extraRecaps: Recap[];
}

function periodicHead(material: Extract<LoadedMaterial, { kind: 'daily' | 'digest' }>, wordCount: number, story: boolean): PeriodicHead {
  if (material.kind === 'daily') {
    const { streakDays } = material.content.overview;
    return {
      kicker: `每日资料 · 第 ${isoWeek(material.date)} 周`,
      title: dailyTitle(wordCount, story),
      subtitle: `根据 ${monthDay(material.date)} 的记录整理${streakDays > 0 ? ` · 已连续学习 ${streakDays} 天` : ''}`,
      extraRecaps: [],
    };
  }
  const content: DigestContent = material.content;
  const range = content.range ? dateRangeLabel([content.range.start, content.range.end]) : monthDay(material.date);
  return {
    kicker: `7 天合集 · ${range}`,
    title: wordCount > 0 ? `7 天合集：${wordCount} 个词` : '7 天合集',
    subtitle: `${range} 的记录整理${content.review.length > 0 ? ` · 复习时忘过 ${content.review.length} 个` : ''}`,
    extraRecaps: content.review.map((item) => ({
      term: oneLine(item.display),
      note: [`这 7 天忘了 ${item.lapses} 次`, oneLine(item.gloss)].filter(Boolean).join(' · '),
      example: '',
    })),
  };
}

function periodicSection(material: Extract<LoadedMaterial, { kind: 'daily' | 'digest' }>, options: SectionOptions): BuiltSection {
  const content: DailyContent = material.content;
  const { parts, layout } = options;
  const practice = layout === 'practice';
  const exercises = exercisesFor(content);
  const avoid = parts.has('exercises') ? exerciseSentences(exercises) : new Set<string>();
  const rows = [
    ...(parts.has('words') ? content.words.map((word) => wordRow(word, options, avoid)) : []),
    ...(parts.has('phrases') ? content.phrases.map((phrase) => phraseRow(phrase, options, avoid)) : []),
  ];
  const story = parts.has('story') ? content.story : null;
  const drafts = parts.has('exercises') ? exerciseDrafts(exercises, layout) : [];
  const { groups, answers } = lettered(drafts);
  const head = periodicHead(material, rows.length, story !== null);
  const pairs: MistakePair[] = parts.has('grammar')
    ? content.grammar.map((point) => ({ title: oneLine(point.title), wrong: oneLine(point.wrong), right: oneLine(point.right), note: oneLine(point.rule) }))
    : [];
  const recaps: Recap[] = [
    ...content.mistakes.map((mistake) => ({ term: oneLine(mistake.display), note: oneLine(mistake.note), example: oneLine(mistake.example.en) })),
    ...head.extraRecaps,
  ];

  const blocks = numbered([
    rows.length > 0 ? (num) => ({ kind: 'words', num, title: '重点词', rows }) : null,
    story
      ? (num) => ({
          kind: 'story',
          num,
          title: '情景短文',
          heading: oneLine(story.title),
          // The day's phrases are key words too ("circle back" in the prototype).
          paragraphs: storySegments(story.text, [...story.words, ...content.phrases.map((phrase) => phrase.phrase)]),
          zh: practice || story.zh === '' ? null : oneLine(story.zh),
          hint: practice ? '加粗的是本期重点词。中文大意在最后的答案里。' : '加粗的是本期重点词。',
        })
      : null,
    groups.length > 0 ? (num) => ({ kind: 'exercises', num, title: '练习', groups }) : null,
    pairs.length + recaps.length > 0
      ? (num) => ({
          kind: 'mistakes',
          num,
          title: '易错提醒',
          aside: pairs.length > 0 ? '来自你的纠错' : '',
          pairs,
          recapTitle: material.kind === 'digest' ? '复习时忘过的' : '复习时常忘的',
          recaps,
        })
      : null,
    practice && rows.length > 0 ? (num) => ({ kind: 'checklist', num, title: '自测清单', intro: CHECKLIST_INTRO, rows: rows.map(checklistRowOf) }) : null,
  ]);

  const stats: Stat[] = [
    ...(parts.has('words') ? [{ value: content.words.length, label: '新词' }] : []),
    ...(parts.has('phrases') ? [{ value: content.phrases.length, label: '词组' }] : []),
    ...(parts.has('grammar') ? [{ value: content.grammar.length, label: '易错' }] : []),
    ...(parts.has('exercises') ? [{ value: exerciseCount(exercises), label: '练习题' }] : []),
  ];
  const storyAnswer = practice && story && story.zh !== '' ? [{ label: '短文大意', text: oneLine(story.zh) }] : [];
  return {
    section: { kicker: head.kicker, title: head.title, subtitle: head.subtitle, stats, reasons: [], blocks },
    answers: practice ? [...answers, ...storyAnswer] : [],
  };
}

// ---------------------------------------------------------------- extend

function extendSection(material: Extract<LoadedMaterial, { kind: 'extend' }>, options: SectionOptions): BuiltSection {
  const content: ExtendContent = material.content;
  const practice = options.layout === 'practice';
  const rows: WordRow[] = content.items.map((item) => ({
    term: oneLine(item.text),
    ipa: '',
    note: item.kind === 'phrase' ? '词组' : '',
    gloss: oneLine(item.gloss),
    example: oneLine(item.example.en),
    exampleZh: practice ? '' : oneLine(item.example.zh),
  }));
  const passage = content.passage;
  const grammar = content.grammar;
  const fix = practice && grammar ? fixDraft(grammar.examples, 'practice') : null;
  const { groups, answers } = lettered(fix ? [fix] : []);
  const blocks = numbered([
    rows.length > 0 ? (num) => ({ kind: 'words', num, title: '词汇', rows }) : null,
    passage
      ? (num) => ({
          kind: 'story',
          num,
          title: '短文',
          heading: oneLine(passage.title),
          paragraphs: storySegments(passage.text, content.items.map((item) => item.text)),
          zh: practice || passage.zh === '' ? null : oneLine(passage.zh),
          hint: practice ? '加粗的是本期词汇。中文大意在最后的答案里。' : '加粗的是本期词汇。',
        })
      : null,
    grammar
      ? (num) => ({
          kind: 'grammar',
          num,
          title: '语法',
          rule: oneLine(grammar.rule),
          pairs: practice ? [] : grammar.examples.map((example) => ({ title: '', wrong: oneLine(example.wrong), right: oneLine(example.right), note: '' })),
        })
      : null,
    groups.length > 0 ? (num) => ({ kind: 'exercises', num, title: '练习', groups }) : null,
    practice && rows.length > 0 ? (num) => ({ kind: 'checklist', num, title: '自测清单', intro: CHECKLIST_INTRO, rows: rows.map(checklistRowOf) }) : null,
  ]);
  const topic = TOPIC_LABELS[content.topic] ?? TOPIC_LABELS.other ?? '';
  const storyAnswer = practice && passage && passage.zh !== '' ? [{ label: '短文大意', text: oneLine(passage.zh) }] : [];
  return {
    section: {
      kicker: ['拓展资料', topic, content.level].filter(Boolean).join(' · '),
      title: content.title === '' ? '拓展资料' : oneLine(content.title),
      subtitle: `根据你最近的查词、笔记和复习推荐 · ${monthDay(material.date)}`,
      stats: [],
      reasons: content.reasons.map(oneLine),
      blocks,
    },
    answers: practice ? [...answers, ...storyAnswer] : [],
  };
}

export function buildSection(material: LoadedMaterial, options: SectionOptions): BuiltSection {
  return material.kind === 'extend' ? extendSection(material, options) : periodicSection(material, options);
}
