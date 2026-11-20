/**
 * Word-level diff of a sentence and its correction (纠错: deleted words struck
 * through, inserted words highlighted).
 *
 * Tokens are words, whitespace runs and single punctuation marks, so a fixed
 * comma does not mark its whole word as changed. Any two whitespace runs count
 * as equal (a line break in the input versus a space in the one-line
 * correction is not an edit). The diff is a longest-common-subsequence over
 * the tokens left after trimming the common prefix and suffix; inputs too
 * large for that fall back to replacing the differing middle as a whole.
 */

export type DiffOp = 'equal' | 'delete' | 'insert'

export interface DiffSegment {
  readonly op: DiffOp
  readonly text: string
}

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu
const WHITESPACE_RE = /^\s+$/

/** Above this many LCS cells the middle is replaced wholesale (memory bound). */
export const MAX_DIFF_CELLS = 400_000

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

const keyOf = (token: string): string => (WHITESPACE_RE.test(token) ? ' ' : token)

const merge = (segments: readonly DiffSegment[]): DiffSegment[] => {
  const out: DiffSegment[] = []
  for (const segment of segments) {
    if (segment.text === '') continue
    const last = out[out.length - 1]
    if (last !== undefined && last.op === segment.op) {
      out[out.length - 1] = { op: last.op, text: last.text + segment.text }
    } else {
      out.push(segment)
    }
  }
  return out
}

const lcsSegments = (before: readonly string[], after: readonly string[]): DiffSegment[] => {
  const n = before.length
  const m = after.length
  const width = m + 1
  // table[i * width + j] = LCS length of before[i..] and after[j..]
  const table = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        keyOf(before[i] as string) === keyOf(after[j] as string)
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number)
    }
  }
  const out: DiffSegment[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const a = before[i] as string
    const b = after[j] as string
    if (keyOf(a) === keyOf(b)) {
      out.push({ op: 'equal', text: b })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      out.push({ op: 'delete', text: a })
      i += 1
    } else {
      out.push({ op: 'insert', text: b })
      j += 1
    }
  }
  for (; i < n; i += 1) out.push({ op: 'delete', text: before[i] as string })
  for (; j < m; j += 1) out.push({ op: 'insert', text: after[j] as string })
  return out
}

/** Raw token diff: equal runs carry the corrected text. */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before)
  const b = tokenize(after)
  let start = 0
  while (start < a.length && start < b.length && keyOf(a[start] as string) === keyOf(b[start] as string)) {
    start += 1
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && keyOf(a[endA - 1] as string) === keyOf(b[endB - 1] as string)) {
    endA -= 1
    endB -= 1
  }
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  const middle =
    (middleA.length + 1) * (middleB.length + 1) > MAX_DIFF_CELLS
      ? [
          { op: 'delete' as const, text: middleA.join('') },
          { op: 'insert' as const, text: middleB.join('') },
        ]
      : lcsSegments(middleA, middleB)
  return merge([
    { op: 'equal', text: b.slice(0, start).join('') },
    ...middle,
    { op: 'equal', text: b.slice(endB).join('') },
  ])
}

const isBlank = (text: string): boolean => text.trim() === ''

/**
 * Segments ready to render: a whitespace-only deletion is dropped, a
 * whitespace-only insertion is shown as plain space, and a deletion directly
 * followed by an insertion gets a space between them ("hear hearing", not
 * "hearhearing").
 */
export function displaySegments(segments: readonly DiffSegment[]): DiffSegment[] {
  const cleaned: DiffSegment[] = []
  for (const segment of segments) {
    if (segment.op === 'delete' && isBlank(segment.text)) continue
    if (segment.op === 'insert' && isBlank(segment.text)) {
      cleaned.push({ op: 'equal', text: segment.text })
      continue
    }
    const previous = cleaned[cleaned.length - 1]
    if (
      segment.op === 'insert' &&
      previous !== undefined &&
      previous.op === 'delete' &&
      !/\s$/.test(previous.text) &&
      !/^\s/.test(segment.text)
    ) {
      cleaned.push({ op: 'equal', text: ' ' })
    }
    cleaned.push(segment)
  }
  return merge(cleaned)
}

/** Whether the correction changed anything beyond whitespace. */
export function hasChanges(segments: readonly DiffSegment[]): boolean {
  return segments.some((segment) => segment.op !== 'equal' && !isBlank(segment.text))
}
