/**
 * The 翻译 page's input box: its length limit and counter, pasted text, and
 * the small facts shown about a result. Pure: no `wx`, no value imports.
 */

/** `POST /v1/ai/translate` takes 1–2000 code points. */
export const MAX_INPUT_CODE_POINTS = 2000
/** The counter shows once the text is longer than this. */
export const COUNTER_FROM = 1800

const codePoints = (text: string): number => {
  let count = 0
  for (const _ of text) count += 1
  return count
}

const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** "1,834 / 2000" past {@link COUNTER_FROM} code points, else ''. */
export function inputCounter(text: string): string {
  const length = codePoints(text)
  return length > COUNTER_FROM ? `${grouped(length)} / ${MAX_INPUT_CODE_POINTS}` : ''
}

export interface ClippedInput {
  readonly text: string
  /** Whether characters past the limit were dropped. */
  readonly clipped: boolean
}

/** Pasted text cut to the input limit (in code points, never inside a character). */
export function clipInput(text: string, max: number = MAX_INPUT_CODE_POINTS): ClippedInput {
  const chars = Array.from(text)
  return chars.length <= max ? { text, clipped: false } : { text: chars.slice(0, max).join(''), clipped: true }
}

/** Paragraphs of a translation: its non-empty lines. */
export function paragraphCount(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '').length
}
