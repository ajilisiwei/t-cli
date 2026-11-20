/**
 * 词库: filters, query building, paging and rows for
 * `GET /v1/items` (docs/api-v1.md, "Library and stats").
 */

export type ItemType = 'word' | 'phrase' | 'grammar'
export type ItemLevel = 'new' | 'learning' | 'mastered'

export interface ItemSummary {
  readonly id: string
  readonly type: ItemType
  readonly display: string
  readonly lookupCount: number
  readonly errorCount: number
  readonly level: ItemLevel
  readonly lastSeenAt: string
}

export interface ItemsPage {
  readonly items: readonly ItemSummary[]
  readonly nextOffset: number | null
}

export interface LibraryFilter {
  /** The search text as typed (normalized when the query is built). */
  readonly q: string
  readonly type: ItemType | null
  readonly level: ItemLevel | null
}

export const EMPTY_FILTER: LibraryFilter = { q: '', type: null, level: null }

export const LIBRARY_PAGE_SIZE = 20
/** Typing pauses this long before the search runs. */
export const SEARCH_DEBOUNCE_MS = 300
/** Longer search text is cut: no display is this long, and the URL stays short. */
export const MAX_QUERY_CODE_POINTS = 64

export const TYPE_LABELS: Readonly<Record<ItemType, string>> = { word: '单词', phrase: '句型', grammar: '语法' }
export const LEVEL_LABELS: Readonly<Record<ItemLevel, string>> = { new: '新', learning: '学习中', mastered: '已掌握' }

export interface Chip {
  /** '' = 全部. */
  readonly value: string
  readonly label: string
}

export const TYPE_CHIPS: readonly Chip[] = [
  { value: '', label: '全部' },
  { value: 'word', label: TYPE_LABELS.word },
  { value: 'phrase', label: TYPE_LABELS.phrase },
  { value: 'grammar', label: TYPE_LABELS.grammar },
]

export const LEVEL_CHIPS: readonly Chip[] = [
  { value: '', label: '全部' },
  { value: 'new', label: LEVEL_LABELS.new },
  { value: 'learning', label: LEVEL_LABELS.learning },
  { value: 'mastered', label: LEVEL_LABELS.mastered },
]

export function isItemType(value: unknown): value is ItemType {
  return value === 'word' || value === 'phrase' || value === 'grammar'
}

export function isItemLevel(value: unknown): value is ItemLevel {
  return value === 'new' || value === 'learning' || value === 'mastered'
}

/** Trimmed, inner whitespace collapsed, at most {@link MAX_QUERY_CODE_POINTS}. */
export function normalizeQuery(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return Array.from(collapsed).slice(0, MAX_QUERY_CODE_POINTS).join('').trim()
}

/** Query parameters for `GET /v1/items`; empty filters are left out. */
export function itemsQuery(
  filter: LibraryFilter,
  offset: number,
  limit: number = LIBRARY_PAGE_SIZE,
): Record<string, string | number> {
  const q = normalizeQuery(filter.q)
  return {
    ...(q === '' ? {} : { q }),
    ...(filter.type === null ? {} : { type: filter.type }),
    ...(filter.level === null ? {} : { level: filter.level }),
    ...(offset > 0 ? { offset } : {}),
    limit,
  }
}

/** Two filters ask the server the same question (the search text compared normalized). */
export function sameFilter(a: LibraryFilter, b: LibraryFilter): boolean {
  return normalizeQuery(a.q) === normalizeQuery(b.q) && a.type === b.type && a.level === b.level
}

/** A chip's dataset value as a filter value; '' and anything unknown mean 全部. */
export function chipType(value: unknown): ItemType | null {
  return isItemType(value) ? value : null
}

export function chipLevel(value: unknown): ItemLevel | null {
  return isItemLevel(value) ? value : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

const readSummary = (value: unknown): ItemSummary | null => {
  if (!isRecord(value)) return null
  const { id, type, display, level } = value
  if (typeof id !== 'string' || id === '' || !isItemType(type) || typeof display !== 'string') return null
  return {
    id,
    type,
    display,
    lookupCount: count(value['lookupCount']),
    errorCount: count(value['errorCount']),
    level: isItemLevel(level) ? level : 'learning',
    lastSeenAt: typeof value['lastSeenAt'] === 'string' ? value['lastSeenAt'] : '',
  }
}

/** Validates a `GET /v1/items` response; null when unusable. Malformed items are dropped. */
export function readItemsPage(value: unknown): ItemsPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null
  const items = value['items'].map(readSummary).filter((item): item is ItemSummary => item !== null)
  const next = value['nextOffset']
  const nextOffset = typeof next === 'number' && Number.isInteger(next) && next > 0 ? next : null
  return { items, nextOffset }
}

export interface LibraryState {
  readonly items: readonly ItemSummary[]
  readonly nextOffset: number | null
}

export const EMPTY_LIBRARY: LibraryState = { items: [], nextOffset: null }

/**
 * Appends the next page. An item already shown is skipped: offsets shift when
 * the nightly job adds items between two loads.
 */
export function appendItems(state: LibraryState, page: ItemsPage): LibraryState {
  const seen = new Set(state.items.map((item) => item.id))
  return {
    items: [...state.items, ...page.items.filter((item) => !seen.has(item.id))],
    nextOffset: page.nextOffset,
  }
}

export interface LibraryRow {
  readonly id: string
  readonly display: string
  readonly level: ItemLevel
  readonly levelLabel: string
  /** "单词 · 查过 3 次 · 错 1 次" */
  readonly meta: string
}

export function toLibraryRow(item: ItemSummary): LibraryRow {
  const parts = [TYPE_LABELS[item.type]]
  if (item.lookupCount > 0) parts.push(`查过 ${item.lookupCount} 次`)
  if (item.errorCount > 0) parts.push(`错 ${item.errorCount} 次`)
  return {
    id: item.id,
    display: item.display,
    level: item.level,
    levelLabel: LEVEL_LABELS[item.level],
    meta: parts.join(' · '),
  }
}

/** What an empty list says: nothing found for a search or filter, or an empty library. */
export function emptyLibraryText(filter: LibraryFilter): string {
  const q = normalizeQuery(filter.q)
  if (q !== '') return `没有找到「${q}」`
  if (filter.type !== null || filter.level !== null) return '没有符合筛选的单元'
  return '词库还是空的。每天凌晨会把前一天查过的词句整理进来。'
}
