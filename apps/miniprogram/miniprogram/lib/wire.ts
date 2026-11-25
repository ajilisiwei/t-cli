/**
 * Shape checks for API responses (docs/api-v1.md, "Account" and "v2"). Each
 * reader takes the envelope's `data` as `unknown` and returns the typed value,
 * or null when a field a screen depends on is missing; optional parts that are
 * malformed are dropped instead of failing the whole response. Pure: no `wx`.
 */
import type {
  Accent,
  EntryDay,
  ExtendTopic,
  LexiconEntry,
  LookupContext,
  LookupResult,
  MaterialFrequency,
  MaterialPart,
  MaterialTopic,
  MutedTopic,
  Note,
  NoteChanges,
  NoteKind,
  NoteLevel,
  NotesPage,
  NoteStars,
  NotesSummary,
  Settings,
  SpeechParts,
  StudyLevelSetting,
  ThemeChoice,
  ThemeMode,
} from './types'

type Fields = Record<string, unknown>

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

const ACCENT_VALUES: readonly Accent[] = ['indigo', 'pine', 'plum', 'ochre', 'ink']
const FREQUENCIES: readonly MaterialFrequency[] = ['daily', 'weekly', 'off']
const PARTS: readonly MaterialPart[] = ['words', 'phrases', 'grammar', 'story', 'exercises']
const TOPICS: readonly ExtendTopic[] = ['work', 'travel', 'exam', 'daily', 'tech', 'culture', 'finance', 'health']
const MATERIAL_TOPICS: readonly MaterialTopic[] = [...TOPICS, 'other']
const LEVELS: readonly StudyLevelSetting[] = ['auto', 'A2', 'B1', 'B2', 'C1']
const MAX_TOPICS = 8
const THEME_MODES: readonly ThemeMode[] = ['system', 'time', 'fixed']
const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark']
const NOTE_KINDS: readonly NoteKind[] = ['word', 'phrase', 'sentence']
const NOTE_LEVELS: readonly NoteLevel[] = ['new', 'learning', 'mastered']
const CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A list of distinct `values` with `min`–`max` entries; undefined when anything is off. */
const distinctList = <T extends string>(values: readonly T[], value: unknown, min: number, max: number): T[] | undefined => {
  if (!Array.isArray(value) || value.length < min || value.length > max) return undefined
  if (!value.every((entry) => oneOf(values, entry)) || new Set(value).size !== value.length) return undefined
  return value as T[]
}

const readMuted = (value: unknown): MutedTopic[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_TOPICS) return undefined
  const muted = value.flatMap((entry): MutedTopic[] => {
    if (!isRecord(entry)) return []
    const topic = entry['topic']
    const until = entry['until']
    return oneOf(MATERIAL_TOPICS, topic) && typeof until === 'string' && DATE_RE.test(until) ? [{ topic, until }] : []
  })
  return muted.length === value.length ? muted : undefined
}

/** The v3 keys of `value` that are valid (docs/api-v1.md, "v3 → Settings"). */
const readLearnSettings = (v: Fields): Settings => {
  const frequency = v['materialFrequency']
  const weekday = v['materialWeekday']
  const parts = distinctList(PARTS, v['materialParts'], 1, PARTS.length)
  const topics = distinctList(TOPICS, v['extendTopics'], 0, MAX_TOPICS)
  const muted = readMuted(v['extendMuted'])
  const level = v['studyLevel']
  const extendEnabled = v['extendEnabled']
  return {
    ...(oneOf(FREQUENCIES, frequency) ? { materialFrequency: frequency } : {}),
    ...(isInt(weekday, 0, 6) ? { materialWeekday: weekday } : {}),
    ...(parts === undefined ? {} : { materialParts: parts }),
    ...(typeof extendEnabled === 'boolean' ? { extendEnabled } : {}),
    ...(topics === undefined ? {} : { extendTopics: topics }),
    ...(muted === undefined ? {} : { extendMuted: muted }),
    ...(oneOf(LEVELS, level) ? { studyLevel: level } : {}),
  }
}

/** Only known keys with valid values; anything else is dropped (absent = default). */
export function readSettings(value: unknown): Settings {
  if (!isRecord(value)) return {}
  const v = value
  const bool = (key: string): boolean | undefined => (typeof v[key] === 'boolean' ? (v[key] as boolean) : undefined)
  const clock = (key: string): string | undefined => {
    const time = v[key]
    return typeof time === 'string' && CLOCK_RE.test(time) ? time : undefined
  }
  const lang = v['explanationLang']
  const hour = v['reminderHour']
  const autoSpeakWord = bool('autoSpeakWord')
  const autoSpeakOnFlip = bool('autoSpeakOnFlip')
  const showDirection = bool('showDirection')
  const readingMode = bool('readingMode')
  const importanceReview = bool('importanceReview')
  const themeDayStart = clock('themeDayStart')
  const themeNightStart = clock('themeNightStart')
  const accent = v['accent']
  const themeMode = v['themeMode']
  const themeFixed = v['themeFixed']
  const step = v['readingFontStep']
  return {
    ...(lang === 'zh' || lang === 'en' ? { explanationLang: lang } : {}),
    ...(autoSpeakWord === undefined ? {} : { autoSpeakWord }),
    ...(autoSpeakOnFlip === undefined ? {} : { autoSpeakOnFlip }),
    ...(hour === null || isInt(hour, 0, 23) ? { reminderHour: hour } : {}),
    ...(showDirection === undefined ? {} : { showDirection }),
    ...(oneOf(ACCENT_VALUES, accent) ? { accent } : {}),
    ...(oneOf(THEME_MODES, themeMode) ? { themeMode } : {}),
    ...(oneOf(THEME_CHOICES, themeFixed) ? { themeFixed } : {}),
    ...(themeDayStart === undefined ? {} : { themeDayStart }),
    ...(themeNightStart === undefined ? {} : { themeNightStart }),
    ...(readingMode === undefined ? {} : { readingMode }),
    ...(isInt(step, 0, 3) ? { readingFontStep: step } : {}),
    ...(importanceReview === undefined ? {} : { importanceReview }),
    ...readLearnSettings(v),
  }
}

/** The elements of `value` (an array) that `read` accepts; [] when it is not an array. */
const listOf = <T>(value: unknown, read: (item: Fields) => T | null): T[] =>
  Array.isArray(value) ? value.flatMap((item) => (isRecord(item) ? (read(item) ?? []) : [])) : []

/** Reads an object whose listed keys are all strings. */
const strings = <K extends string>(keys: readonly K[]) => (item: Fields): Record<K, string> | null => {
  const out: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const value = str(item[key])
    if (value === null) return null
    out[key] = value
  }
  return out as Record<K, string>
}

export function readLexiconEntry(value: unknown): LexiconEntry | null {
  if (!isRecord(value)) return null
  const lemma = str(value['lemma'])
  const senses = listOf(value['senses'], strings(['pos', 'gloss', 'def'] as const))
  if (lemma === null || lemma === '' || senses.length === 0) return null
  const ipa = isRecord(value['ipa']) ? value['ipa'] : {}
  return {
    lemma,
    ipa: { us: str(ipa['us']) ?? '', uk: str(ipa['uk']) ?? '' },
    senses,
    forms: listOf(value['forms'], strings(['label', 'form'] as const)),
    collocations: listOf(value['collocations'], strings(['text', 'gloss'] as const)),
    examples: listOf(value['examples'], strings(['text', 'gloss'] as const)),
    contrasts: listOf(value['contrasts'], strings(['word', 'note'] as const)),
    memory: str(value['memory']) ?? '',
  }
}

const readContext = (value: unknown): LookupContext | null => {
  if (!isRecord(value)) return null
  const meaning = str(value['meaning'])
  if (meaning === null) return null
  const phrase = isRecord(value['phrase']) ? strings(['text', 'gloss'] as const)(value['phrase']) : null
  return { meaning, phrase }
}

/** `POST /v1/lookup` data; null without a usable entry. */
export function readLookupResult(value: unknown): LookupResult | null {
  if (!isRecord(value)) return null
  const entry = readLexiconEntry(value['entry'])
  if (entry === null) return null
  return {
    lemma: strOrNull(value['lemma']) ?? entry.lemma,
    lang: 'en',
    entry,
    context: readContext(value['context']),
    cached: value['cached'] === true,
  }
}

export function readNote(value: unknown): Note | null {
  if (!isRecord(value)) return null
  const id = str(value['id'])
  const kind = value['kind']
  const text = str(value['text'])
  const stars = value['stars']
  const seq = value['seq']
  const level = value['level']
  const task = value['task']
  if (id === null || text === null || !oneOf(NOTE_KINDS, kind) || !isInt(stars, 1, 4) || !isInt(seq, 0, Number.MAX_SAFE_INTEGER)) {
    return null
  }
  return {
    id,
    kind,
    text,
    translation: strOrNull(value['translation']),
    lang: 'en',
    stars: stars as NoteStars,
    lemma: strOrNull(value['lemma']),
    entryId: strOrNull(value['entryId']),
    itemId: strOrNull(value['itemId']),
    seq,
    createdAt: str(value['createdAt']) ?? '',
    updatedAt: str(value['updatedAt']) ?? '',
    deletedAt: strOrNull(value['deletedAt']),
    // Added after v2's first contract; absent or anything else means unknown (left out).
    ...(oneOf(NOTE_LEVELS, level) ? { level } : {}),
    ...(task === 'translate' || task === 'check' ? { task } : {}),
  }
}

/** `{ note }` of `PUT` / `DELETE /v1/notes/:id`. */
export function readNoteEnvelope(value: unknown): Note | null {
  return isRecord(value) ? readNote(value['note']) : null
}

const notesOf = (value: unknown): Note[] | null =>
  Array.isArray(value) ? value.flatMap((item) => readNote(item) ?? []) : null

export function readNotesPage(value: unknown): NotesPage | null {
  if (!isRecord(value)) return null
  const notes = notesOf(value['notes'])
  if (notes === null) return null
  const nextBefore = strOrNull(value['nextBefore'])
  return { notes, nextBefore, hasMore: value['hasMore'] === true && nextBefore !== null }
}

export function readNoteChanges(value: unknown): NoteChanges | null {
  if (!isRecord(value)) return null
  const notes = notesOf(value['notes'])
  const nextAfter = value['nextAfter']
  if (notes === null || !isInt(nextAfter, 0, Number.MAX_SAFE_INTEGER)) return null
  return { notes, nextAfter, hasMore: value['hasMore'] === true }
}

const counts = <K extends string>(keys: readonly K[], value: unknown): Record<K, number> | null => {
  if (!isRecord(value)) return null
  const out: Partial<Record<K, number>> = {}
  for (const key of keys) {
    const count = value[key]
    if (!isInt(count, 0, Number.MAX_SAFE_INTEGER)) return null
    out[key] = count
  }
  return out as Record<K, number>
}

/** `GET /v1/notes/summary` data; null when any count is missing or malformed. */
export function readNotesSummary(value: unknown): NotesSummary | null {
  if (!isRecord(value)) return null
  const total = value['total']
  const thisWeek = value['thisWeek']
  const kinds = counts(NOTE_KINDS, value['kinds'])
  const levels = counts(NOTE_LEVELS, value['levels'])
  if (!isInt(total, 0, Number.MAX_SAFE_INTEGER) || !isInt(thisWeek, 0, Number.MAX_SAFE_INTEGER)) return null
  if (kinds === null || levels === null) return null
  return { total, thisWeek, kinds, levels }
}

/** `GET /v1/entries/days` data → the days with records; null when malformed. */
export function readEntryDays(value: unknown): EntryDay[] | null {
  if (!isRecord(value) || !Array.isArray(value['days'])) return null
  return value['days'].flatMap((day) => {
    if (!isRecord(day)) return []
    const date = day['date']
    const count = day['count']
    return typeof date === 'string' && DATE_RE.test(date) && isInt(count, 1, Number.MAX_SAFE_INTEGER) ? [{ date, count }] : []
  })
}

const headerValue = (header: Fields, name: string): unknown => {
  const key = Object.keys(header).find((candidate) => candidate.toLowerCase() === name)
  return key === undefined ? undefined : header[key]
}

const headerInt = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  return /^\d+$/.test(text) ? Number(text) : null
}

/**
 * The part headers of a `POST /v1/tts` answer (names in any case, as
 * `wx.request` passes them). Null when absent or inconsistent — an older
 * server, whose audio is the whole text.
 */
export function readSpeechParts(header: unknown): SpeechParts | null {
  if (!isRecord(header)) return null
  const part = headerInt(headerValue(header, 'x-speech-part'))
  const parts = headerInt(headerValue(header, 'x-speech-parts'))
  return part !== null && parts !== null && parts >= 1 && part < parts ? { part, parts } : null
}
