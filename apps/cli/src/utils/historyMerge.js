/**
 * /history <date> with phone records: the local Markdown file's entries and
 * that day's mini-program records (`GET /v1/entries/day`, source "mp"),
 * merged into one list by time. Pure; the REPL reads the file and fetches.
 *
 * Local entries are rendered verbatim (heading + body, as the file has
 * them), so nothing the file holds is lost; phone entries are rendered in
 * the same Markdown shape and marked "(phone)".
 */
import { detectDateBasis, reconstructCreatedAt, splitBlocks } from './historyParser.js';

/** @typedef {import('../sync/learning.js').DayEntry} DayEntry */

export const PHONE_SOURCE = 'mp';
const SEPARATOR = '---';

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Records from the phone only (the CLI's own records are already in the file).
 * @param {readonly DayEntry[]} entries
 * @returns {DayEntry[]}
 */
export function phoneEntries(entries) {
  return entries.filter((entry) => entry.source === PHONE_SOURCE);
}

/**
 * @param {readonly string[]} lines
 * @returns {string[]} without leading/trailing blank lines and the trailing `---`
 */
function trimBlock(lines) {
  const out = [...lines];
  const isBlank = (line) => line.trim() === '';
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  if (out.length && out[out.length - 1].trim() === SEPARATOR) out.pop();
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  while (out.length && isBlank(out[0])) out.shift();
  return out;
}

/**
 * @param {DayEntry} entry
 * @param {number} order tie-break after local entries (1, 2, … in server order)
 * @returns {{ at: number, order: number, text: string }}
 */
function phoneItem(entry, order) {
  const at = Date.parse(entry.createdAt);
  const time = new Date(at);
  const type = entry.task === 'check' ? 'Grammar Check' : 'Translation';
  const text = [
    `## [${pad2(time.getHours())}:${pad2(time.getMinutes())}] ${type} (phone)`,
    '',
    `**Input:** ${entry.input.trim()}`,
    '',
    entry.output.trim(),
  ].join('\n');
  return { at, order, text };
}

/**
 * Merge a day's local history file with phone records, oldest first. Ties
 * keep local entries before phone ones (local times have minute precision).
 * @param {{ date: string, localContent: string|null, remoteEntries: readonly DayEntry[] }} input
 * @returns {{ text: string, local: number, phone: number }}
 */
export function mergeDayHistory({ date, localContent, remoteEntries }) {
  const basis = localContent ? detectDateBasis(localContent) : 'local';
  const localItems = (localContent ? splitBlocks(localContent) : []).map((block) => {
    let at;
    try {
      at = reconstructCreatedAt(date, block.time, basis).createdAt.getTime();
    } catch {
      at = Number.NaN;
    }
    const text = [`## [${block.time}] ${block.type}`, '', ...trimBlock(block.lines)].join('\n');
    return { at, order: 0, text };
  });
  const phone = phoneEntries(remoteEntries).map((entry, i) => phoneItem(entry, i + 1));

  const merged = [...localItems, ...phone]
    .map((item, position) => ({ ...item, position }))
    .toSorted((a, b) => compareTime(a.at, b.at) || a.order - b.order || a.position - b.position);

  const counts = `${localItems.length} from this computer, ${phone.length} from phone`;
  const header = `# t-cli Learning History — ${date} (${counts})`;
  const text = [header, ...merged.map((item) => item.text)].join(`\n\n${SEPARATOR}\n\n`);
  return { text, local: localItems.length, phone: phone.length };
}

/**
 * Compare instants at minute precision (local entries carry no seconds);
 * unparseable times sort last.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function compareTime(a, b) {
  const aValid = Number.isFinite(a);
  const bValid = Number.isFinite(b);
  if (!aValid || !bValid) return Number(!aValid) - Number(!bValid);
  return Math.floor(a / 60_000) - Math.floor(b / 60_000);
}
