/**
 * 纠错 results with numbered changes (v2 prototype "Check" / "LongCheck").
 *
 * The word diff (lib/word-diff.ts) is grouped into changes: a run of deleted
 * and inserted words, with plain spaces allowed between them. Each change
 * gets a number shown after it in the text, and a numbered row under it
 * ("has finished → finished"). The model's free-text explanation is split
 * into items; an item that quotes both sides of a change becomes that row's
 * reason, the rest follow unnumbered. Only the first rows show until the
 * user expands them. Pure: no `wx`, no value imports.
 */
import type { DiffOp, DiffSegment } from './word-diff'

/** A display segment; `mark` is the number of the change it ends, else 0. */
export interface MarkedSegment {
  readonly op: DiffOp
  readonly text: string
  readonly mark: number
}

export interface Change {
  readonly no: number
  /** Deleted words ('' for a pure insertion). */
  readonly before: string
  /** Inserted words ('' for a pure deletion). */
  readonly after: string
}

export interface NumberedDiff {
  readonly segments: readonly MarkedSegment[]
  readonly changes: readonly Change[]
}

export interface ExplanationItem {
  readonly text: string
  /** A section title such as "错误分析：". */
  readonly heading: boolean
}

/** One row under the corrected text: a numbered change (no ≥ 1) or an unnumbered explanation (no = 0). */
export interface ExplanationRow {
  readonly no: number
  readonly before: string
  readonly after: string
  readonly why: string
  readonly heading: boolean
}

/** Rows shown before 「展开其余 N 条解释」. */
export const VISIBLE_EXPLANATIONS = 3

const isBlank = (text: string): boolean => text.trim() === ''
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Numbers the changes of display segments (from `displaySegments`). */
export function numberChanges(segments: readonly DiffSegment[]): NumberedDiff {
  const out: MarkedSegment[] = []
  const changes: Change[] = []
  let before: string[] = []
  let after: string[] = []
  let lastEdit = -1

  const close = (): void => {
    if (lastEdit < 0) return
    const no = changes.length + 1
    const ended = out[lastEdit]
    if (ended !== undefined) {
      // The number sits right after the word, before a space the edit ends with ("has¹ finished").
      const word = ended.text.trimEnd()
      const space = ended.text.slice(word.length)
      out.splice(lastEdit, 1, { ...ended, text: word, mark: no }, ...(space === '' ? [] : [{ op: 'equal' as const, text: space, mark: 0 }]))
    }
    changes.push({ no, before: squash(before.join(' ')), after: squash(after.join(' ')) })
    before = []
    after = []
    lastEdit = -1
  }

  segments.forEach((segment, index) => {
    if (segment.op === 'equal') {
      const next = segments[index + 1]
      const bridges = lastEdit >= 0 && isBlank(segment.text) && next !== undefined && next.op !== 'equal'
      if (!bridges) close()
      out.push({ op: 'equal', text: segment.text, mark: 0 })
      return
    }
    out.push({ op: segment.op, text: segment.text, mark: 0 })
    lastEdit = out.length - 1
    if (segment.op === 'delete') before.push(segment.text)
    else after.push(segment.text)
  })
  close()
  return { segments: out, changes }
}

const LIST_MARK_RE = /^\s*(?:[-*•·]|\d{1,2}[.)、．]|[（(]\d{1,2}[)）])\s*/
const HEADING_MAX = 30

/** Splits a cleaned explanation into items: list entries and paragraphs. */
export function explanationItems(text: string): ExplanationItem[] {
  const items: ExplanationItem[] = []
  let current: string[] = []
  const close = (): void => {
    const joined = current.join(' ').trim()
    current = []
    if (joined === '') return
    items.push({ text: joined, heading: /[:：]$/.test(joined) && Array.from(joined).length <= HEADING_MAX })
  }
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') {
      close()
      continue
    }
    const marked = LIST_MARK_RE.test(line)
    if (marked) close()
    current.push(line.replace(LIST_MARK_RE, '').trim())
    // A title line ends its own item: what follows is its content.
    if (/[:：]$/.test(line.trim())) close()
  }
  close()
  return items
}

const isLetter = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char)

/** Whether `phrase` occurs in `text` as whole words, ignoring case. */
const mentions = (text: string, phrase: string): boolean => {
  const needle = phrase.toLowerCase()
  if (needle === '') return true
  const haystack = text.toLowerCase().replace(/[‘’]/g, "'")
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    if (!isLetter(haystack[at - 1]) && !isLetter(haystack[at + needle.length])) return true
    from = at + 1
  }
}

const explains = (item: ExplanationItem, change: Change): boolean =>
  !item.heading && (change.before !== '' || change.after !== '') && mentions(item.text, change.before) && mentions(item.text, change.after)

/** Drops titles left without content once their items moved to numbered rows. */
const withoutBareHeadings = (items: readonly ExplanationItem[]): ExplanationItem[] =>
  items.filter((item, index) => {
    if (!item.heading) return true
    const next = items[index + 1]
    return next !== undefined && !next.heading
  })

/** Numbered rows for the changes (with a quoting item as the reason), then the remaining items. */
export function explanationRows(changes: readonly Change[], items: readonly ExplanationItem[]): ExplanationRow[] {
  const used = new Set<number>()
  const numbered = changes.map((change): ExplanationRow => {
    const index = items.findIndex((item, i) => !used.has(i) && explains(item, change))
    if (index >= 0) used.add(index)
    return { no: change.no, before: change.before, after: change.after, why: index >= 0 ? (items[index]?.text ?? '') : '', heading: false }
  })
  const rest = withoutBareHeadings(items.filter((_, i) => !used.has(i))).map(
    (item): ExplanationRow => ({ no: 0, before: '', after: '', why: item.text, heading: item.heading }),
  )
  return [...numbered, ...rest]
}

export interface VisibleRows {
  readonly rows: readonly ExplanationRow[]
  /** Rows behind 「展开其余 N 条解释」 (0 when expanded or nothing is hidden). */
  readonly hidden: number
  /** Whether the list can be collapsed or expanded at all. */
  readonly collapsible: boolean
}

export function visibleRows(
  rows: readonly ExplanationRow[],
  expanded: boolean,
  limit: number = VISIBLE_EXPLANATIONS,
): VisibleRows {
  const collapsible = rows.length > limit
  if (!collapsible || expanded) return { rows, hidden: 0, collapsible }
  return { rows: rows.slice(0, limit), hidden: rows.length - limit, collapsible }
}
