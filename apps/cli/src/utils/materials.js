/**
 * Terminal text for the cloud learning materials (docs/api-v1.md,
 * "Materials"): DailyMaterial for /notes and WeeklyReport for /weekly.
 *
 * The content is external data, so every field is read defensively: a
 * missing or mistyped field drops that line, never the whole material.
 * Output is a list of blocks; the REPL appends each as one message.
 */

/** @typedef {{ text: string, bold?: boolean }} Block */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INDENT = '  ';

/** @param {unknown} value @returns {string} */
const str = (value) => (typeof value === 'string' ? value.trim() : '');
/** @param {unknown} value @returns {any[]} */
const arr = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value @returns {Record<string, any>} */
const obj = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {number|null} */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Indent every line of a multi-line string.
 * @param {string} text
 * @param {string} [prefix]
 * @returns {string}
 */
function indent(text, prefix = INDENT) {
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

/**
 * "e.g. <en>" plus the translation aligned under it.
 * @param {unknown} example
 * @param {string} [suffix]
 * @returns {string[]}
 */
function exampleLines(example, suffix = '') {
  const { en, zh } = { en: str(obj(example).en), zh: str(obj(example).zh) };
  if (!en) return [];
  return [`e.g. ${en}${suffix}`, ...(zh ? [`     ${zh}`] : [])];
}

/**
 * A section: a bold heading block and a body block (omitted when empty).
 * @param {string} heading
 * @param {string[]} entries already formatted, one per item
 * @returns {Block[]}
 */
function section(heading, entries) {
  if (entries.length === 0) return [];
  return [{ text: heading, bold: true }, { text: entries.join('\n') }];
}

/**
 * @param {string} first first line of the item (after the bullet)
 * @param {string[]} rest further lines, indented under it
 * @returns {string}
 */
function bullet(first, rest) {
  return [`• ${first}`, ...rest.map((line) => indent(line))].join('\n');
}

/** @param {unknown} raw @returns {string|null} */
function formatWord(raw) {
  const word = obj(raw);
  const headword = str(word.headword);
  if (!headword) return null;
  const ipa = str(word.ipa);
  const meanings = arr(word.meanings)
    .map((m) => [str(obj(m).pos), str(obj(m).zh)].filter(Boolean).join(' '))
    .filter(Boolean);
  const examples = arr(word.examples).flatMap((e) => exampleLines(e, obj(e).fromUser === true ? '  (from your records)' : ''));
  const collocations = arr(word.collocations).map(str).filter(Boolean);
  const synonyms = arr(word.synonyms)
    .map((s) => [str(obj(s).word), str(obj(s).note)].filter(Boolean).join(' — '))
    .filter(Boolean);
  const family = arr(word.family).map(str).filter(Boolean);
  const rest = [
    ...(meanings.length ? [meanings.join('；')] : []),
    ...examples,
    ...(collocations.length ? [`Collocations: ${collocations.join(', ')}`] : []),
    ...(synonyms.length ? [`Synonyms: ${synonyms.join('; ')}`] : []),
    ...(family.length ? [`Word family: ${family.join(', ')}`] : []),
  ];
  return bullet(ipa ? `${headword}  ${/^[/[]/.test(ipa) ? ipa : `/${ipa}/`}` : headword, rest);
}

/** @param {unknown} raw @returns {string|null} */
function formatPhrase(raw) {
  const phrase = obj(raw);
  const text = str(phrase.phrase);
  if (!text) return null;
  const register = str(phrase.register);
  const alternatives = arr(phrase.alternatives)
    .map((a) => [str(obj(a).en), str(obj(a).note)].filter(Boolean).join(' — '))
    .filter(Boolean);
  const rest = [
    ...(str(phrase.zh) ? [str(phrase.zh)] : []),
    ...(alternatives.length ? [`Alternatives: ${alternatives.join('; ')}`] : []),
    ...arr(phrase.examples).flatMap((e) => exampleLines(e, obj(e).fromUser === true ? '  (from your records)' : '')),
  ];
  return bullet(register ? `${text}  [${register}]` : text, rest);
}

/** @param {unknown} raw @returns {string|null} */
function formatGrammar(raw) {
  const point = obj(raw);
  const title = str(point.title);
  if (!title) return null;
  const exercises = arr(point.exercises)
    .map((e) => [str(obj(e).wrong), str(obj(e).right)])
    .filter(([wrong]) => wrong)
    .map(([wrong, right], i) => `${INDENT}${i + 1}. ${wrong}${right ? `  →  ${right}` : ''}`);
  const rest = [
    ...(str(point.rule) ? [str(point.rule)] : []),
    ...(str(point.wrong) ? [`✗ ${str(point.wrong)}`] : []),
    ...(str(point.right) ? [`✓ ${str(point.right)}`] : []),
    ...(exercises.length ? ['Practice:', ...exercises] : []),
  ];
  return bullet(title, rest);
}

/** @param {unknown} raw @returns {string|null} */
function formatMistake(raw) {
  const mistake = obj(raw);
  const display = str(mistake.display);
  if (!display) return null;
  const note = str(mistake.note);
  return bullet(note ? `${display} — ${note}` : display, exampleLines(mistake.example));
}

/**
 * @param {unknown} raw
 * @returns {Block[]}
 */
function storySection(raw) {
  const story = obj(raw);
  const text = str(story.text);
  if (!text) return [];
  const title = str(story.title);
  const words = arr(story.words).map(str).filter(Boolean);
  const body = [
    indent(text),
    ...(str(story.zh) ? ['', indent(str(story.zh))] : []),
    ...(words.length ? ['', `${INDENT}Words: ${words.join(', ')}`] : []),
  ];
  return [{ text: title ? `Story · ${title}` : 'Story', bold: true }, { text: body.join('\n') }];
}

/**
 * @param {readonly unknown[]} items
 * @param {(item: unknown) => string|null} format
 * @returns {string[]}
 */
function formatAll(items, format) {
  return items.map(format).filter((text) => text !== null);
}

/**
 * Blocks for a DailyMaterial.
 * @param {{ date: string, content: unknown }} material
 * @returns {Block[]}
 */
export function formatDailyMaterial({ date, content }) {
  const daily = obj(content);
  return [{ text: `Daily material · ${str(daily.date) || date}`, bold: true }, ...materialBlocks(daily)];
}

/**
 * Blocks for a DigestMaterial (the 7-day digest of the weekly mode): the
 * daily material's sections plus the units forgotten in review.
 * @param {{ date: string, content: unknown }} digest
 * @returns {Block[]}
 */
export function formatDigest({ date, content }) {
  const digest = obj(content);
  const range = obj(digest.range);
  const end = str(range.end) || date;
  const start = str(range.start) || shiftDate(end, -(DIGEST_DAYS - 1));
  const recap = formatAll(arr(digest.review), formatRecap);
  return [
    { text: `7-day digest · ${start} – ${end}`, bold: true },
    ...materialBlocks(digest),
    ...section(`Forgotten in review (${recap.length})`, recap),
  ];
}

/** Days a digest covers (its date is the last one). */
export const DIGEST_DAYS = 7;

/**
 * The digest that covers `date`: the earliest digest date d with
 * d - 6 <= date <= d, or null.
 * @param {string[]} digestDates YYYY-MM-DD, any order
 * @param {string} date YYYY-MM-DD
 * @returns {string|null}
 */
export function digestCovering(digestDates, date) {
  const covering = digestDates
    .filter((end) => end >= date && shiftDate(end, -(DIGEST_DAYS - 1)) <= date)
    .sort();
  return covering[0] ?? null;
}

/**
 * `date` moved by `days` calendar days (YYYY-MM-DD, no time zone involved).
 * @param {string} date
 * @param {number} days
 * @returns {string}
 */
export function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function formatRecap(value) {
  const recap = obj(value);
  const display = str(recap.display);
  if (!display) return null;
  const gloss = str(recap.gloss);
  const lapses = num(recap.lapses);
  return `${display}${gloss ? ` — ${gloss}` : ''}${lapses ? ` (forgot ${lapses}×)` : ''}`;
}

/**
 * The overview line and the sections shared by daily materials and digests.
 * @param {Record<string, unknown>} daily
 * @returns {Block[]}
 */
function materialBlocks(daily) {
  const overview = obj(daily.overview);
  const stats = [
    ['new words', num(overview.newWords)],
    ['new phrases', num(overview.newPhrases)],
    ['corrections', num(overview.corrections)],
    ['streak', num(overview.streakDays), 'days'],
  ]
    .filter(([, value]) => value !== null)
    .map(([label, value, unit]) => `${label} ${value}${unit ? ` ${unit}` : ''}`);

  const words = formatAll(arr(daily.words), formatWord);
  const phrases = formatAll(arr(daily.phrases), formatPhrase);
  const grammar = formatAll(arr(daily.grammar), formatGrammar);
  const mistakes = formatAll(arr(daily.mistakes), formatMistake);
  const body = [
    ...section(`Words (${words.length})`, words),
    ...section(`Phrases (${phrases.length})`, phrases),
    ...section(`Grammar (${grammar.length})`, grammar),
    ...storySection(daily.story),
    ...section(`Mistakes to watch (${mistakes.length})`, mistakes),
  ];

  return [
    ...(stats.length ? [{ text: capitalize(stats.join(' · ')) }] : []),
    ...(body.length ? body : [{ text: 'This material has no items.' }]),
  ];
}

/**
 * Blocks for a WeeklyReport.
 * @param {{ date: string, content: unknown }} report
 * @returns {Block[]}
 */
export function formatWeeklyReport({ date, content }) {
  const weekly = obj(content);
  const start = str(weekly.weekStart) || date;
  const end = str(weekly.weekEnd);
  const totals = obj(weekly.totals);
  const retention = obj(weekly.retention);
  const stats = [
    ['records', num(totals.entries)],
    ['new items', num(totals.newItems)],
    ['reviews', num(totals.reviews)],
  ]
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label} ${value}`);

  const topErrors = arr(weekly.topErrors)
    .map((e) => [str(obj(e).title), num(obj(e).count)])
    .filter(([title]) => title)
    .map(([title, count], i) => `${INDENT}${i + 1}. ${title}${count !== null ? ` ×${count}` : ''}`);
  const topLookups = arr(weekly.topLookups)
    .map((e) => [str(obj(e).display), num(obj(e).count)])
    .filter(([display]) => display)
    .map(([display, count]) => `${display}${count !== null ? ` ×${count}` : ''}`);
  const summary = str(weekly.summary);

  return [
    { text: `Weekly report · ${end ? `${start} – ${end}` : `week of ${start}`}`, bold: true },
    ...(stats.length ? [{ text: capitalize(stats.join(' · ')) }] : []),
    { text: `Retention (remembered share of reviews): this week ${percent(retention.thisWeek)} · last week ${percent(retention.lastWeek)}` },
    ...section('Most frequent mistakes', topErrors),
    ...section('Most looked up', topLookups.length ? [indent(topLookups.join(' · '))] : []),
    ...section('Summary', summary ? [indent(summary)] : []),
  ];
}

/**
 * A share (0–1) as a percentage; "—" when unknown.
 * @param {unknown} share
 * @returns {string}
 */
export function percent(share) {
  const value = num(share);
  if (value === null) return '—';
  return `${Math.round((value <= 1 ? value * 100 : value))}%`;
}

/**
 * The Monday (ISO week start) of the week containing a YYYY-MM-DD date.
 * @param {string} date
 * @returns {string|null} null for a malformed or impossible date
 */
export function weekStartOf(date) {
  const match = DATE_RE.exec(date);
  if (!match) return null;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (day.toISOString().slice(0, 10) !== date) return null;
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

/** @param {string} text @returns {string} */
function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
