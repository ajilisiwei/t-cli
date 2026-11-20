/**
 * Glue for the commands that read the account's learning data: /weekly, the
 * cloud side of /notes and the phone records of /history. The REPL injects
 * how to talk to the user (`say`, the message log) and how to show a
 * spinner (`withLoading`); nothing here touches stdin/stdout.
 *
 * Every call is optional for the REPL's flow: "not logged in", "offline"
 * and "the server has none" come back as empty results (with a dim note
 * where useful), so the local behaviour stays the fallback.
 */
import { fetchDailyMaterial, fetchDayEntries, fetchWeeklyReport, listMaterialDates } from './learning.js';
import { syncOffLines } from './status.js';
import { formatDailyMaterial, formatWeeklyReport, weekStartOf } from '../utils/materials.js';
import { phoneEntries } from '../utils/historyMerge.js';

/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/** @typedef {import('./settings.js').ServerSetting} ServerSetting */
/** @typedef {import('./learning.js').DayEntry} DayEntry */
/** @typedef {(text: string, options?: { color?: string, dim?: boolean, bold?: boolean }) => void} Say */
/** @typedef {<T>(label: string, task: () => Promise<T>) => Promise<T>} WithLoading */

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {{ client: SyncClient | null, server: ServerSetting, say: Say, withLoading: WithLoading,
 *           today: () => string }} deps
 */
export function createLearningCommands({ client, server, say, withLoading, today }) {
  /** The client when logged in, else null (sync off or logged out). */
  const loggedInClient = () => (client && client.getAuth() ? client : null);

  /**
   * That local day's mini-program records; [] when logged out or offline.
   * @param {string} date
   * @returns {Promise<DayEntry[]>}
   */
  async function loadPhoneRecords(date) {
    const api = loggedInClient();
    if (!api) return [];
    try {
      const entries = await withLoading(`Loading phone records for ${date}...`, () => fetchDayEntries(api, date));
      return phoneEntries(entries);
    } catch (error) {
      say(`Phone records unavailable (${errorMessage(error)}); showing this computer's history only.`, { dim: true });
      return [];
    }
  }

  /**
   * Show the account's daily material for `date`. False when there is none to
   * show (logged out, offline, 404): /notes then falls back to a local note.
   * @param {string} date
   * @returns {Promise<boolean>}
   */
  async function showDailyMaterial(date) {
    const api = loggedInClient();
    if (!api) return false;
    let material;
    try {
      material = await withLoading(`Loading daily material for ${date}...`, () => fetchDailyMaterial(api, date));
    } catch (error) {
      say(`Cloud material unavailable (${errorMessage(error)}); using local notes.`, { dim: true });
      return false;
    }
    if (!material) {
      say(`No cloud material for ${date}; using local notes.`, { dim: true });
      return false;
    }
    for (const block of formatDailyMaterial(material)) say(block.text, { color: 'magenta', bold: Boolean(block.bold) });
    say(`From your account (made nightly from your records). /notes regen ${date} writes a local AI note instead.`, { dim: true });
    return true;
  }

  /** List the dates that have a cloud daily material (nothing when logged out). */
  async function listDailyMaterials() {
    const api = loggedInClient();
    if (!api) return;
    let dates;
    try {
      dates = await withLoading('Loading cloud materials...', () => listMaterialDates(api, { kind: 'daily' }));
    } catch (error) {
      say(`Cloud materials unavailable (${errorMessage(error)}).`, { dim: true });
      return;
    }
    if (dates.length === 0) return;
    const current = today();
    const lines = ['Daily Materials (cloud)', ...dates.map((date) => (date === current ? `${date} (today)` : date))];
    lines.push('Use /notes <YYYY-MM-DD> to read.');
    say(lines.join('\n'), { color: 'magenta' });
  }

  /**
   * /weekly [today|YYYY-MM-DD]: the latest report, or the week of a date.
   * @param {string} arg
   */
  async function runWeekly(arg) {
    const weekStart = arg ? weekStartOf(arg === 'today' ? today() : arg) : null;
    if (arg && !weekStart) {
      say('Tip: Use /weekly for the latest report, or /weekly <YYYY-MM-DD> for the week of that date.', { color: 'yellow' });
      return;
    }
    if (!client) {
      for (const line of syncOffLines(server)) say(line, { color: 'yellow' });
      return;
    }
    const api = loggedInClient();
    if (!api) {
      say('Not logged in. Weekly reports come from your account: run /login first.', { color: 'yellow' });
      return;
    }

    let report;
    try {
      report = await withLoading(
        weekStart ? `Loading the report for the week of ${weekStart}...` : 'Loading the latest weekly report...',
        () => fetchWeeklyReport(api, weekStart),
      );
    } catch (error) {
      say(`Could not load the weekly report: ${errorMessage(error)}`, { color: 'red' });
      return;
    }
    if (!report) {
      say(
        weekStart
          ? `No weekly report for the week of ${weekStart}.`
          : 'No weekly report yet. Reports are made on Sunday night for Monday to Sunday.',
        { color: 'yellow' },
      );
      return;
    }
    for (const block of formatWeeklyReport(report)) say(block.text, { color: 'cyan', bold: Boolean(block.bold) });
  }

  return { loadPhoneRecords, showDailyMaterial, listDailyMaterials, runWeekly };
}
