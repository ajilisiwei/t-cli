import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getHistoryDir() {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      't-cli', 'history'
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    't-cli', 'history'
  );
}

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function getTimeString() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Append a translation or grammar-check entry to today's history file.
 * @param {'Translation'|'Grammar Check'} type
 * @param {string} input - the user's original text
 * @param {string} response - the raw API response (no ANSI codes)
 */
export function saveHistory(type, input, response) {
  try {
    const historyDir = getHistoryDir();
    fs.mkdirSync(historyDir, { recursive: true });

    const today = getTodayString();
    const filePath = path.join(historyDir, `${today}.md`);
    const time = getTimeString();

    let header = '';
    if (!fs.existsSync(filePath)) {
      header = `# t-cli Learning History — ${today}\n\n---\n`;
    }

    const entry = [
      '',
      `## [${time}] ${type}`,
      '',
      `**Input:** ${input}`,
      '',
      response.trim(),
      '',
      '---',
      ''
    ].join('\n');

    fs.appendFileSync(filePath, header + entry, 'utf8');
  } catch (_) {
    // Silent — never crash the REPL
  }
}

/**
 * List all history dates, newest first.
 * @returns {{ date: string, count: number }[]}
 */
export function listHistory() {
  try {
    const historyDir = getHistoryDir();
    if (!fs.existsSync(historyDir)) return [];

    return fs.readdirSync(historyDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .map(f => {
        const date = f.replace('.md', '');
        const content = fs.readFileSync(path.join(historyDir, f), 'utf8');
        const count = (content.match(/^## \[/gm) || []).length;
        return { date, count };
      });
  } catch (_) {
    return [];
  }
}

/**
 * Read a specific date's history file.
 * @param {string} date - YYYY-MM-DD
 * @returns {string|null}
 */
export function readHistory(date) {
  try {
    const filePath = path.join(getHistoryDir(), `${date}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}
