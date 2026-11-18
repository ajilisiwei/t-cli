/**
 * Reading structure out of raw model output for display.
 *
 * The prompts (packages/core/src/prompts.js) fix two shapes the screens rely on:
 *  - a word lookup's first line is "term /IPA/" plus, for an English source,
 *    the Chinese gloss: "meticulous /məˈtɪkjələs/ 一丝不苟的";
 *  - a detail-mode check puts the corrected text alone on the first line,
 *    then a blank line, then the analysis.
 */

export interface FirstLineSplit {
  /** First non-empty line, trimmed, without `**` markers. */
  readonly first: string
  /** Everything after it, trimmed. */
  readonly rest: string
}

const LINE_BREAK = /\r\n|\r|\n/

export function splitFirstLine(output: string): FirstLineSplit {
  const lines = output.split(LINE_BREAK)
  const index = lines.findIndex((line) => line.trim() !== '')
  if (index === -1) return { first: '', rest: '' }
  return {
    first: (lines[index] ?? '').replace(/\*\*/g, '').trim(),
    rest: lines.slice(index + 1).join('\n').trim(),
  }
}

export interface WordHeadline {
  /** The English head term ("meticulous"). */
  readonly head: string
  /** The IPA without slashes ("məˈtɪkjələs"). */
  readonly ipa: string
  /** Text after the IPA on the same line (the Chinese gloss), possibly empty. */
  readonly gloss: string
  /** The lines after the first one. */
  readonly rest: string
}

// Same head-term shape as `extractHeadTerm` in packages/core/src/spelling.js
// (test/output.test.ts keeps the two in agreement), plus the IPA and the gloss.
const HEADLINE_RE = /^([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*)*)\s*\/([^/\n]+)\/\s*(.*)$/

/** Parses a word lookup's "term /IPA/ gloss" first line; null when it is not one. */
export function parseWordHeadline(output: string): WordHeadline | null {
  const { first, rest } = splitFirstLine(output)
  const match = HEADLINE_RE.exec(first)
  if (match === null) return null
  return { head: match[1] ?? '', ipa: (match[2] ?? '').trim(), gloss: (match[3] ?? '').trim(), rest }
}

/**
 * Light cleanup for showing an explanation as plain text: bold/italic markers
 * and heading hashes go, list markers and line breaks stay.
 */
export function cleanMarkdown(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\*\*|__/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Counts Unicode code points, as the server does for its length limits. */
export function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}
