import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getNotesDir() {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      't-cli', 'notes'
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    't-cli', 'notes'
  );
}

/**
 * List all AI-generated note dates, newest first.
 * @returns {{ date: string }[]}
 */
export function listGeneratedNotes() {
  try {
    const notesDir = getNotesDir();
    if (!fs.existsSync(notesDir)) return [];

    return fs.readdirSync(notesDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .map(f => ({ date: f.replace('.md', '') }));
  } catch (_) {
    return [];
  }
}

/**
 * Read a previously generated note.
 * @param {string} date - YYYY-MM-DD
 * @returns {string|null}
 */
export function readGeneratedNote(date) {
  try {
    const filePath = path.join(getNotesDir(), `${date}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Save (overwrite) an AI-generated note for a given date.
 * @param {string} date - YYYY-MM-DD
 * @param {string} content - full Markdown content
 */
export function saveGeneratedNote(date, content) {
  try {
    const notesDir = getNotesDir();
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, `${date}.md`), content, 'utf8');
  } catch (error) {
    console.error(`\x1b[33mWarning: Failed to save note: ${error.message}\x1b[0m`);
  }
}
