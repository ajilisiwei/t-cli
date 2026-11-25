import type { LoadedMaterial } from './content.ts';
import type { Card, ChecklistRow, ExportLayout, PdfDocument } from './document.ts';
import { cnDate, dateRangeLabel, glossOfMeanings, monthDay, oneLine, pickExample } from './format.ts';
import { buildSection, CHECKLIST_INTRO, type MaterialPart, type WordNote } from './sections.ts';

/**
 * Build the PDF data (document.ts) for each export scope
 * (docs/api-v1.md, "v3 → PDF export"). Pure: the route loads the rows.
 */

export interface DocumentOptions {
  layout: ExportLayout;
  ipa: boolean;
  large: boolean;
  /** The caller's local day: shown when an export has no material dates. */
  today: string;
}

const KIND_NAMES: Readonly<Record<LoadedMaterial['kind'], string>> = { daily: '每日资料', digest: '7 天合集', extend: '拓展资料' };

const datesOf = (materials: readonly LoadedMaterial[]): string[] => materials.map((material) => material.date);

const blankDocument = (options: DocumentOptions): Omit<PdfDocument, 'scope' | 'title' | 'header' | 'footer'> => ({
  layout: options.layout,
  options: { ipa: options.ipa, large: options.large },
  sections: [],
  answers: [],
  cards: [],
  checklist: { heading: '', subtitle: '', intro: '', rows: [] },
  empty: '',
});

// ------------------------------------------------------------- material

export function materialDocument(
  materials: readonly LoadedMaterial[],
  options: DocumentOptions & { parts: ReadonlySet<MaterialPart>; notes: ReadonlyMap<string, WordNote> },
): PdfDocument {
  const several = materials.length > 1;
  const built = materials.map((material) => ({ material, ...buildSection(material, options) }));
  const practice = options.layout === 'practice';
  const first = built[0];
  return {
    ...blankDocument(options),
    scope: 'material',
    title: several || !first ? '学习资料合集' : first.section.title,
    header: {
      left: several || !first ? `学习资料合集 · ${dateRangeLabel(datesOf(materials))}` : `${KIND_NAMES[first.material.kind]} · ${cnDate(first.material.date)}`,
      right: `t-cli 学习 · ${practice ? '练习版' : '阅读版'}`,
    },
    footer: practice ? '先读后练，答案在最后一节，可沿剪切线剪下' : '阅读版：释义和答案都写在正文里',
    sections: built.map((entry) => entry.section),
    answers: practice
      ? built
          .filter((entry) => entry.answers.length > 0)
          .map((entry) => ({
            heading: several ? `${monthDay(entry.material.date)} ${KIND_NAMES[entry.material.kind]} · ${entry.section.title}` : null,
            lines: entry.answers,
          }))
      : [],
  };
}

// ---------------------------------------------------------------- cards

function cardsOfMaterial(material: LoadedMaterial, ipa: boolean): Card[] {
  if (material.kind === 'extend') {
    return material.content.items.map((item) => ({
      term: oneLine(item.text),
      ipa: '',
      gloss: oneLine(item.gloss),
      example: oneLine(item.example.en),
      zh: oneLine(item.example.zh),
    }));
  }
  const { words, phrases } = material.content;
  return [
    ...words.map((word) => {
      const example = pickExample(word.examples);
      return {
        term: oneLine(word.headword),
        ipa: ipa ? oneLine(word.ipa) : '',
        gloss: glossOfMeanings(word.meanings),
        example: oneLine(example?.en ?? ''),
        zh: oneLine(example?.zh ?? ''),
      };
    }),
    ...phrases.map((phrase) => {
      const example = pickExample(phrase.examples);
      return { term: oneLine(phrase.phrase), ipa: '', gloss: oneLine(phrase.zh), example: oneLine(example?.en ?? ''), zh: oneLine(example?.zh ?? '') };
    }),
  ];
}

/** The first occurrence of each term (case-insensitive), in order. */
function uniqueByTerm<T extends { term: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function cardsDocument(materials: readonly LoadedMaterial[], options: DocumentOptions): PdfDocument {
  const cards = uniqueByTerm(materials.flatMap((material) => cardsOfMaterial(material, options.ipa)));
  return {
    ...blankDocument(options),
    scope: 'cards',
    title: '单词卡',
    header: { left: `单词卡 · ${dateRangeLabel(datesOf(materials))}`, right: 't-cli 学习 · 单词卡' },
    footer: '实线剪开，虚线向后对折',
    cards,
    empty: cards.length === 0 ? '这些资料里没有单词或词组。' : '',
  };
}

// ------------------------------------------------------------ checklist

export function checklistRowsOf(materials: readonly LoadedMaterial[]): ChecklistRow[] {
  return uniqueByTerm(
    materials.flatMap((material) => cardsOfMaterial(material, true).map((card) => ({ term: card.term, ipa: card.ipa, gloss: card.gloss }))),
  );
}

export type ChecklistSource = { from: 'materials'; materials: readonly LoadedMaterial[] } | { from: 'units'; rows: readonly ChecklistRow[] };

export function checklistDocument(source: ChecklistSource, options: DocumentOptions): PdfDocument {
  const rows = (source.from === 'materials' ? checklistRowsOf(source.materials) : source.rows).map((row) => ({
    ...row,
    ipa: options.ipa ? row.ipa : '',
  }));
  const label = source.from === 'materials' ? dateRangeLabel(datesOf(source.materials)) : monthDay(options.today);
  const count = rows.length > 0 ? ` ${rows.length} 个` : '';
  const subtitle = source.from === 'materials' ? `${label} 资料里的${count}词和词组` : `今天到期和最近 30 天常忘的${count}词和词组`;
  return {
    ...blankDocument(options),
    scope: 'checklist',
    title: '自测清单',
    header: { left: `自测清单 · ${label}`, right: 't-cli 学习 · 自测清单' },
    footer: '沿虚线向后对折，看单词说意思',
    checklist: { heading: '自测清单', subtitle, intro: CHECKLIST_INTRO, rows },
    empty: rows.length > 0 ? '' : source.from === 'materials' ? '这些资料里没有单词或词组。' : '今天没有到期或常忘的词，明天再来。',
  };
}
