/**
 * 笔记本 and 单词详情 (v2): filters, paging and incremental refresh of the
 * notebook (`GET /v1/notes`, `GET /v1/notes/changes`), its rows and summary
 * card, the saved-state index the word page keeps, and the word page's view
 * of a lexicon entry (docs/api-v1.md, "v2 → Lookup / Notes"). Pure: no `wx`.
 */
import type {
  LookupResult,
  Note,
  NoteInput,
  NoteKind,
  NoteLevel,
  NotesPage,
  NotesQuery,
  NoteStars,
  NotesSummary,
} from './types'

export const KIND_LABELS: Readonly<Record<NoteKind, string>> = { word: '单词', phrase: '词组', sentence: '句子' }
export const LEVEL_LABELS: Readonly<Record<NoteLevel, string>> = { new: '新加', learning: '学习中', mastered: '已掌握' }

const NOTE_KINDS: readonly NoteKind[] = ['word', 'phrase', 'sentence']
const NOTE_LEVELS: readonly NoteLevel[] = ['new', 'learning', 'mastered']
const MAX_STARS = 4

/** A new note's importance (收藏 = 1 星). */
export const DEFAULT_STARS: NoteStars = 1
/** Word and phrase notes: the server's limit on `text`, in code points. */
export const MAX_PHRASE_CODE_POINTS = 64

const CJK_RE = /[぀-ヿ㐀-鿿가-힯豈-﫿]/
const LATIN_RE = /[A-Za-zÀ-ɏ]/

// ---------------------------------------------------------------- filters

export interface NotebookFilter {
  readonly kind: NoteKind | null
  readonly stars: NoteStars | null
}

export const EMPTY_NOTEBOOK_FILTER: NotebookFilter = { kind: null, stars: null }

export function chipKind(value: unknown): NoteKind | null {
  return NOTE_KINDS.find((kind) => kind === value) ?? null
}

export function chipStars(value: unknown): NoteStars | null {
  const n = typeof value === 'string' && value !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_STARS ? (n as NoteStars) : null
}

export interface KindTab {
  /** '' = 全部. */
  readonly value: '' | NoteKind
  /** "单词 126"; just the name while the counts are unknown. */
  readonly label: string
  readonly selected: boolean
}

export function kindTabs(summary: NotesSummary | null, selected: NoteKind | null): KindTab[] {
  const label = (name: string, count: number | undefined): string => (count === undefined ? name : `${name} ${count}`)
  return [
    { value: '', label: label('全部', summary?.total), selected: selected === null },
    ...NOTE_KINDS.map((kind) => ({
      value: kind,
      label: label(KIND_LABELS[kind], summary?.kinds[kind]),
      selected: selected === kind,
    })),
  ]
}

export interface StarChip {
  /** '' = 全部. */
  readonly value: string
  readonly label: string
  /** Draw a star in front of the number. */
  readonly star: boolean
  readonly selected: boolean
  readonly aria: string
}

/** 全部, then 4 … 1 star. */
export function starChips(selected: NoteStars | null): StarChip[] {
  return [0, 4, 3, 2, 1].map((n) => ({
    value: n === 0 ? '' : String(n),
    label: n === 0 ? '全部' : String(n),
    star: n > 0,
    selected: n === 0 ? selected === null : selected === n,
    aria: n === 0 ? '全部星级' : `只看 ${n} 星`,
  }))
}

export function sameNotebookFilter(a: NotebookFilter, b: NotebookFilter): boolean {
  return a.kind === b.kind && a.stars === b.stars
}

/** `GET /v1/notes` query; absent filters are left out. */
export function notesQuery(filter: NotebookFilter, before: string | null, limit?: number): NotesQuery {
  return {
    ...(filter.kind === null ? {} : { kind: filter.kind }),
    ...(filter.stars === null ? {} : { stars: filter.stars }),
    ...(before === null ? {} : { before }),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function matchesNotebookFilter(note: Note, filter: NotebookFilter): boolean {
  return (
    note.deletedAt === null &&
    (filter.kind === null || note.kind === filter.kind) &&
    (filter.stars === null || note.stars === filter.stars)
  )
}

export function emptyNotebookText(filter: NotebookFilter): string {
  if (filter.kind === null && filter.stars === null) return '还没有笔记。翻译结果里点书签，就会收进笔记本'
  const what = filter.kind === null ? '笔记' : KIND_LABELS[filter.kind]
  return filter.stars === null ? `还没有${what}` : `没有 ${filter.stars} 星的${what}`
}

// ---------------------------------------------------------------- list

export interface NotebookList {
  /** Newest first (ULID order). */
  readonly notes: readonly Note[]
  /** `before` of the next page; null when there is none. */
  readonly nextBefore: string | null
  readonly hasMore: boolean
}

export const EMPTY_NOTEBOOK: NotebookList = { notes: [], nextBefore: null, hasMore: false }

const newestFirst = (a: Note, b: Note): number => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** Appends an older page; notes already shown are kept (no duplicate rows). */
export function appendNotesPage(list: NotebookList, page: NotesPage): NotebookList {
  const seen = new Set(list.notes.map((note) => note.id))
  const fresh = page.notes.filter((note) => !seen.has(note.id))
  const nextBefore = page.hasMore ? page.nextBefore : null
  return {
    notes: [...list.notes, ...fresh].sort(newestFirst),
    nextBefore,
    hasMore: page.hasMore && nextBefore !== null,
  }
}

/**
 * The `/v1/notes/changes` cursor after seeing `notes`. Every change up to a
 * seen seq was committed before the response that carried it (seq order is
 * commit order), so starting there never skips a change; re-applying one
 * already shown is harmless.
 */
export function advanceCursor(cursor: number, notes: readonly Note[]): number {
  return notes.reduce((max, note) => Math.max(max, note.seq), cursor)
}

/**
 * Applies changed notes (in seq order, deleted ones included) to the loaded
 * list: a deleted note or one that no longer matches the filter leaves, a
 * changed one is replaced, a new match is inserted where it belongs — unless
 * it is older than the loaded pages, which bring it in when scrolled to.
 */
export function applyNoteChanges(list: NotebookList, changed: readonly Note[], filter: NotebookFilter): NotebookList {
  const oldest = list.notes[list.notes.length - 1]?.id ?? null
  const byId = new Map(list.notes.map((note) => [note.id, note]))
  for (const note of changed) {
    byId.delete(note.id)
    const loadedRange = !list.hasMore || oldest === null || note.id >= oldest
    if (matchesNotebookFilter(note, filter) && loadedRange) byId.set(note.id, note)
  }
  return { ...list, notes: [...byId.values()].sort(newestFirst) }
}

/** A local edit shown at once (the row stays even if the star filter no longer matches). */
export function replaceNote(list: NotebookList, note: Note): NotebookList {
  return { ...list, notes: list.notes.map((current) => (current.id === note.id ? note : current)) }
}

export function removeNote(list: NotebookList, id: string): NotebookList {
  return { ...list, notes: list.notes.filter((note) => note.id !== id) }
}

export function findNote(list: NotebookList, id: string): Note | null {
  return list.notes.find((note) => note.id === id) ?? null
}

// ---------------------------------------------------------------- rows

export interface StarMark {
  readonly key: string
  readonly filled: boolean
}

export interface NoteRow {
  readonly id: string
  /** The learning unit, which 朗读 reads; '' before the server links one. */
  readonly itemId: string
  readonly kind: NoteKind
  readonly text: string
  /** The translation, or ''. */
  readonly gloss: string
  /** 单词 / 词组 / 句子 / 句子 · 纠错. */
  readonly kindLabel: string
  /** '' while the note has no learning unit yet. */
  readonly level: '' | NoteLevel
  readonly levelLabel: string
  /** Lines the text is clamped to: words and phrases 1, sentences 2, an expanded row 0 (all). */
  readonly lines: 0 | 1 | 2
  readonly serif: boolean
  readonly stars: number
  readonly marks: readonly StarMark[]
  /** A word opens 单词详情; a phrase or sentence expands in place. */
  readonly opensWord: boolean
  readonly expanded: boolean
  readonly aria: string
}

export function starMarks(stars: number): StarMark[] {
  return Array.from({ length: MAX_STARS }, (_, i) => ({ key: `${i + 1}`, filled: i < stars }))
}

export function noteKindLabel(note: Note): string {
  return note.kind === 'sentence' && note.task === 'check' ? `${KIND_LABELS.sentence} · 纠错` : KIND_LABELS[note.kind]
}

export function toNoteRow(note: Note, expandedId: string): NoteRow {
  const expanded = note.kind !== 'word' && note.id === expandedId
  const level = note.level ?? null
  const kindLabel = noteKindLabel(note)
  const levelLabel = level === null ? '' : LEVEL_LABELS[level]
  return {
    id: note.id,
    itemId: note.itemId ?? '',
    kind: note.kind,
    text: note.text,
    gloss: note.translation ?? '',
    kindLabel,
    level: level ?? '',
    levelLabel,
    lines: expanded ? 0 : note.kind === 'sentence' ? 2 : 1,
    serif: !CJK_RE.test(note.text),
    stars: note.stars,
    marks: starMarks(note.stars),
    opensWord: note.kind === 'word',
    expanded,
    aria: [note.text, kindLabel, levelLabel, `${note.stars} 星`].filter((part) => part !== '').join('，'),
  }
}

// ---------------------------------------------------------------- summary card

export interface SummarySegment {
  readonly key: NoteLevel
  readonly label: string
  readonly count: number
}

export interface SummaryView {
  readonly total: number
  /** "条笔记 · 本周 +21". */
  readonly caption: string
  /** Levels with notes, for the bar (flex = count). */
  readonly bar: readonly SummarySegment[]
  /** All three levels, for the legend. */
  readonly legend: readonly SummarySegment[]
  readonly barAria: string
}

export function summaryView(summary: NotesSummary): SummaryView {
  const legend = NOTE_LEVELS.map((key) => ({ key, label: LEVEL_LABELS[key], count: summary.levels[key] }))
  return {
    total: summary.total,
    caption: `条笔记 · 本周 +${summary.thisWeek}`,
    bar: legend.filter((segment) => segment.count > 0),
    legend,
    barAria: legend.map((segment) => `${segment.label} ${segment.count}`).join('，'),
  }
}

// ---------------------------------------------------------------- word page link

export const WORD_PAGE = '/pages/word/index'

/** `/pages/word/index?lemma=…[&sentence=…][&entryId=…]`. */
export function wordPageUrl(lemma: string, options: { readonly sentence?: string; readonly entryId?: string } = {}): string {
  const params = [`lemma=${encodeURIComponent(lemma)}`]
  if (options.sentence !== undefined && options.sentence !== '') params.push(`sentence=${encodeURIComponent(options.sentence)}`)
  if (options.entryId !== undefined && options.entryId !== '') params.push(`entryId=${encodeURIComponent(options.entryId)}`)
  return `${WORD_PAGE}?${params.join('&')}`
}

/** What a word note opens: its lemma, else its text. */
export function noteLemma(note: Note): string {
  return note.lemma ?? note.text
}

// ---------------------------------------------------------------- saved state (word page)

/**
 * The key a lemma, word or phrase is saved under: curly quotes straightened,
 * whitespace collapsed, lowercased — the server's lemma key.
 */
export function lemmaKey(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** What the word page needs to know about a saved word or phrase. */
export interface SavedNote {
  readonly id: string
  readonly kind: NoteKind
  /** As stored: a later `PUT` must send it unchanged. */
  readonly text: string
  readonly stars: NoteStars
  readonly live: boolean
  readonly itemId: string | null
}

/**
 * Notes by kind and key (a word by its lemma, a phrase or sentence by its
 * text), deleted ones included: re-saving revives the same id.
 */
export type SavedIndex = Readonly<Record<string, SavedNote>>

export const savedKey = (kind: NoteKind, text: string): string => `${kind}:${lemmaKey(text)}`

const indexKeyOf = (note: Note): string => savedKey(note.kind, note.kind === 'word' ? noteLemma(note) : note.text)

export function toSavedNote(note: Note): SavedNote {
  return {
    id: note.id,
    kind: note.kind,
    text: note.text,
    stars: note.stars,
    live: note.deletedAt === null,
    itemId: note.itemId,
  }
}

/** Notes in seq order folded into the index; a live note is never replaced by another id's deleted one. */
export function indexNotes(index: SavedIndex, notes: readonly Note[]): SavedIndex {
  const next: Record<string, SavedNote> = { ...index }
  for (const note of notes) {
    const key = indexKeyOf(note)
    const saved = toSavedNote(note)
    const current = next[key]
    if (current !== undefined && current.id !== saved.id && current.live && !saved.live) continue
    next[key] = saved
  }
  return next
}

export function findSaved(index: SavedIndex, kind: NoteKind, text: string): SavedNote | null {
  return index[savedKey(kind, text)] ?? null
}

/** The stars shown for `kind` / `text`: 0 when not saved. */
export function savedStars(index: SavedIndex, kind: NoteKind, text: string): number {
  const saved = findSaved(index, kind, text)
  return saved !== null && saved.live ? saved.stars : 0
}

export function withSaved(index: SavedIndex, saved: SavedNote): SavedIndex {
  return { ...index, [savedKey(saved.kind, saved.text)]: saved }
}

/** A phrase the server accepts as a note: 1–64 code points with a Latin letter. */
export function canSavePhrase(text: string): boolean {
  const length = Array.from(text.trim()).length
  return length >= 1 && length <= MAX_PHRASE_CODE_POINTS && LATIN_RE.test(text)
}

/** The `PUT` body that changes a saved note's stars (kind and text unchanged, or 409). */
export function starsInput(saved: SavedNote, stars: NoteStars): NoteInput {
  return { kind: saved.kind, text: saved.text, lang: 'en', stars }
}

/** The word's line for the notebook: the first sense, "adj. 简洁的；简明的". */
export function wordTranslation(result: LookupResult): string {
  const sense = result.entry.senses[0]
  return sense === undefined ? '' : `${sense.pos} ${sense.gloss}`.trim()
}

/** Saving the looked-up word: the lemma as text, from the record it was tapped in. */
export function wordNoteInput(result: LookupResult, stars: NoteStars, entryId: string): NoteInput {
  const translation = wordTranslation(result)
  return {
    kind: 'word',
    text: result.lemma,
    lang: 'en',
    stars,
    lemma: result.lemma,
    ...(translation === '' ? {} : { translation }),
    ...(entryId === '' ? {} : { entryId }),
  }
}

export function phraseNoteInput(text: string, gloss: string, stars: NoteStars): NoteInput {
  return { kind: 'phrase', text, lang: 'en', stars, ...(gloss === '' ? {} : { translation: gloss }) }
}

// ---------------------------------------------------------------- word view

/**
 * The audio key of a lexicon reading: the lemma (美 / 英 speaker) or its
 * example at `part` (0-based). Letters, digits, '_' and '-' only: it names
 * the cached file.
 */
export function lexiconSpeechKey(lemma: string, part: 'us' | 'uk' | number): string {
  const slug = lemmaKey(lemma).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `lex-${slug}-${typeof part === 'number' ? `ex${part}` : part}`
}

/** One pair of slashes around an IPA transcription; '' when there is none. */
export function formatIpa(ipa: string): string {
  const bare = ipa.trim().replace(/^\/+|\/+$/g, '').trim()
  return bare === '' ? '' : `/${bare}/`
}

export interface TextSegment {
  readonly key: string
  readonly text: string
  readonly hit: boolean
}

const isLetter = (char: string | undefined): boolean => char !== undefined && /[A-Za-zÀ-ɏ]/.test(char)

/** Regular inflections of a one-word lemma (decide → decides, decided, deciding; study → studies). */
export function inflectionsOf(lemma: string): string[] {
  const word = lemma.toLowerCase()
  if (!/^[a-z]+$/.test(word)) return [word]
  const forms = [word, `${word}s`, `${word}es`, `${word}ed`, `${word}d`, `${word}ing`, `${word}er`, `${word}est`, `${word}ly`, `${word}r`, `${word}st`]
  if (word.endsWith('e')) forms.push(`${word.slice(0, -1)}ing`)
  if (/[^aeiou]y$/.test(word)) {
    const stem = word.slice(0, -1)
    forms.push(`${stem}ies`, `${stem}ied`, `${stem}ier`, `${stem}iest`, `${stem}ily`)
  }
  if (/[^aeiou][aeiou][bdgklmnprtvz]$/.test(word)) {
    const last = word.charAt(word.length - 1)
    forms.push(`${word}${last}ed`, `${word}${last}ing`, `${word}${last}er`, `${word}${last}est`)
  }
  return forms
}

/** The first whole-word, case-insensitive occurrence of any candidate (longest first). */
const findOccurrence = (sentence: string, candidates: readonly string[]): { start: number; end: number } | null => {
  const lower = sentence.toLowerCase()
  const sorted = [...new Set(candidates.map((c) => c.trim().toLowerCase()).filter((c) => c !== ''))].sort(
    (a, b) => b.length - a.length,
  )
  let best: { start: number; end: number } | null = null
  for (const candidate of sorted) {
    for (let from = lower.indexOf(candidate); from !== -1; from = lower.indexOf(candidate, from + 1)) {
      const end = from + candidate.length
      if (!isLetter(lower[from - 1]) && !isLetter(lower[end])) {
        if (best === null || from < best.start) best = { start: from, end }
        break
      }
    }
  }
  return best
}

/**
 * The sentence split around the looked-up word for 在本句中: the tapped
 * form, the lemma, the entry's forms (went for go) and regular inflections.
 */
export function highlightSentence(sentence: string, candidates: readonly string[]): TextSegment[] {
  const lemmaForms = candidates.flatMap((candidate) => inflectionsOf(candidate))
  const hit = findOccurrence(sentence, [...candidates, ...lemmaForms])
  if (hit === null) return sentence === '' ? [] : [{ key: '0', text: sentence, hit: false }]
  return [
    { key: '0', text: sentence.slice(0, hit.start), hit: false },
    { key: '1', text: sentence.slice(hit.start, hit.end), hit: true },
    { key: '2', text: sentence.slice(hit.end), hit: false },
  ].filter((segment) => segment.text !== '')
}

export interface WordView {
  readonly lemma: string
  readonly ipaUs: string
  readonly ipaUk: string
  readonly senses: readonly { key: string; pos: string; gloss: string; def: string }[]
  readonly forms: readonly { key: string; label: string; form: string }[]
  readonly examples: readonly { key: string; index: number; text: string; gloss: string }[]
  readonly contrasts: readonly { key: string; word: string; note: string }[]
  readonly memory: string
  /** 在本句中; null without a sentence. */
  readonly context: {
    readonly segments: readonly TextSegment[]
    readonly meaning: string
    readonly phrase: { readonly text: string; readonly gloss: string } | null
  } | null
}

export function wordView(result: LookupResult, sentence: string, tapped: string): WordView {
  const { entry } = result
  const keyed = <T>(rows: readonly T[]): (T & { key: string })[] => rows.map((row, i) => ({ ...row, key: `${i}` }))
  const context =
    result.context === null || sentence === ''
      ? null
      : {
          segments: highlightSentence(sentence, [tapped, result.lemma, ...entry.forms.map((form) => form.form)]),
          meaning: result.context.meaning,
          phrase: result.context.phrase,
        }
  return {
    lemma: result.lemma,
    ipaUs: formatIpa(entry.ipa.us),
    ipaUk: formatIpa(entry.ipa.uk),
    senses: keyed(entry.senses),
    forms: keyed(entry.forms),
    examples: entry.examples.map((example, index) => ({ ...example, key: `${index}`, index })),
    contrasts: keyed(entry.contrasts),
    memory: entry.memory,
    context,
  }
}

export interface CollocationRow {
  readonly key: string
  readonly text: string
  readonly gloss: string
  /** Short enough to save as a phrase note. */
  readonly savable: boolean
  /** 0 when not saved. */
  readonly stars: number
  readonly aria: string
}

export function collocationRows(result: LookupResult, index: SavedIndex): CollocationRow[] {
  return result.entry.collocations.map((collocation, i) => {
    const stars = savedStars(index, 'phrase', collocation.text)
    return {
      key: `${i}`,
      text: collocation.text,
      gloss: collocation.gloss,
      savable: canSavePhrase(collocation.text),
      stars,
      aria: stars > 0 ? `取消收藏 ${collocation.text}` : `收藏 ${collocation.text} 到笔记本`,
    }
  })
}

// ---------------------------------------------------------------- 我的记录

/** The parts of a learning unit (`GET /v1/items/:id`) 我的记录 reads. */
export interface UnitRecord {
  readonly lookupCount: number
  readonly firstSeenAt: string
  readonly level: NoteLevel
  readonly cards: readonly { readonly due: string | null; readonly mastered: boolean; readonly suspended: boolean; readonly state: string }[]
}

export interface MyRecordView {
  /** "查过 3 次 · 第一次是 11月18日"; '' without a unit. */
  readonly lookups: string
  readonly review: string
}

/** The earliest due of the cards still scheduled; null when none is. */
const nextDue = (cards: UnitRecord['cards']): string | null =>
  cards
    .filter((card) => !card.mastered && !card.suspended && card.state !== 'new' && card.due !== null)
    .map((card) => card.due as string)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null

/**
 * 我的记录 on the word page. `formatDay` words the first lookup ("11月18日"),
 * `formatDue` a future due date ("3 天后"); a card already due reads 待复习.
 */
export function myRecordView(
  unit: UnitRecord | null,
  saved: boolean,
  now: number,
  formatDay: (iso: string) => string,
  formatDue: (iso: string) => string,
): MyRecordView {
  if (unit === null) {
    return { lookups: '', review: saved ? '复习卡片稍后生成' : '还没有复习卡片' }
  }
  const first = unit.firstSeenAt === '' ? '' : formatDay(unit.firstSeenAt)
  const lookups =
    unit.lookupCount > 0 ? `查过 ${unit.lookupCount} 次${first === '' ? '' : ` · 第一次是 ${first}`}` : ''
  if (unit.cards.length === 0) return { lookups, review: saved ? '复习卡片稍后生成' : '还没有复习卡片' }
  if (unit.level === 'mastered') return { lookups, review: '复习卡片：已掌握' }
  if (unit.level === 'new') return { lookups, review: '复习卡片：还没开始复习' }
  const due = nextDue(unit.cards)
  if (due === null) return { lookups, review: '复习卡片：学习中' }
  return { lookups, review: Date.parse(due) <= now ? '复习卡片：学习中 · 待复习' : `复习卡片：学习中 · 下次 ${formatDue(due)}` }
}
