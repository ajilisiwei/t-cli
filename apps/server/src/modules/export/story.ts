import { findTarget } from '../pipeline/text.ts';
import { paragraphsOf } from './format.ts';
import type { Segment } from './document.ts';

/**
 * A story or passage as paragraphs of runs, with the first occurrence of
 * each of `words` (any inflection of a word's first token, as the pipeline
 * matches them) marked bold. The text itself is never altered.
 */
export function storySegments(text: string, words: readonly string[]): Segment[][] {
  const paragraphs = paragraphsOf(text);
  const ranges: { start: number; end: number }[][] = paragraphs.map(() => []);
  for (const word of words) {
    for (const [index, paragraph] of paragraphs.entries()) {
      const hit = findTarget(paragraph, word);
      if (!hit) continue;
      const range = { start: hit.index, end: hit.index + hit.text.length };
      const taken = ranges[index] ?? [];
      if (!taken.some((other) => range.start < other.end && other.start < range.end)) {
        ranges[index] = [...taken, range];
      }
      break;
    }
  }
  return paragraphs.map((paragraph, index) => splitRuns(paragraph, ranges[index] ?? []));
}

function splitRuns(paragraph: string, ranges: readonly { start: number; end: number }[]): Segment[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const runs: Segment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start > cursor) runs.push({ t: paragraph.slice(cursor, range.start), b: false });
    runs.push({ t: paragraph.slice(range.start, range.end), b: true });
    cursor = range.end;
  }
  if (cursor < paragraph.length) runs.push({ t: paragraph.slice(cursor), b: false });
  return runs;
}
