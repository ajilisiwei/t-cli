/**
 * What 复制 puts on the clipboard (v2 plan, "通用"): only the part a user
 * pastes somewhere else.
 *  - translation of a sentence or paragraph → the translation;
 *  - word lookup → the gloss line only, without the head word, IPA or any
 *    explanation ("concise /kənˈsaɪs/ adj. 简洁的" → "adj. 简洁的"); a Chinese
 *    source has no gloss, so its English word is the translation
 *    ("deadline /ˈdɛdˌlaɪn/" → "deadline");
 *  - check → the corrected text (the first line of the output).
 *
 * Pure: no `wx`, no value imports (the first-line and headline rules mirror
 * lib/output.ts).
 */
import type { EntryKind, EntryTask } from './types'

export interface CopySource {
  readonly task: EntryTask
  readonly kind: EntryKind | null
  /** The raw model output. */
  readonly output: string
}

const LINE_BREAK = /\r\n|\r|\n/
const HEADLINE_RE = /^(.*?)\s*\/[^/\n]+\/\s*(.*)$/

const firstLine = (output: string): string =>
  (output.split(LINE_BREAK).find((line) => line.trim() !== '') ?? '').replace(/\*\*/g, '').trim()

/** The gloss of a word lookup's "term /IPA/ gloss" line; the term when there is no gloss. */
const wordGloss = (output: string): string => {
  const line = firstLine(output)
  const match = HEADLINE_RE.exec(line)
  if (match === null) return line
  const term = (match[1] ?? '').trim()
  const gloss = (match[2] ?? '').trim()
  return gloss !== '' ? gloss : term
}

/** The text to copy; '' when there is nothing. */
export function copyText(source: CopySource): string {
  if (source.output.trim() === '') return ''
  if (source.task === 'check') return firstLine(source.output)
  if (source.kind === 'word') return wordGloss(source.output)
  return source.output.replace(/\r\n?/g, '\n').trim()
}
