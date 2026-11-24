// /note and /notebook: the notes endpoints, their text and the command glue,
// against a local fake HTTP server. Every test gets its own XDG_CONFIG_HOME,
// so the real ~/.config/t-cli is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ULID_RE, ulid } from '@t-cli/core/ulid';
import { authFromTokenPair, writeAuth } from '../src/sync/authStore.js';
import { SyncError, createSyncClient } from '../src/sync/client.js';
import { NOTEBOOK_PAGE_SIZE, fetchNotes, saveNote, toNote } from '../src/sync/notebook.js';
import { createNotebookCommands } from '../src/sync/notebookCommands.js';
import { formatNotebook, formatSavedNote, parseNotebookKind, parseStarsArg, preview, starMarks } from '../src/utils/notebookText.js';

// ---------------------------------------------------------------- helpers

function useTempConfig(t) {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-notebook-'));
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const ok = (data) => ({ status: 200, body: { success: true, data, error: null } });
const fail = (status, code) => ({ status, body: { success: false, data: null, error: { code, message: `${code} message` } } });

/** Local fake API server; `handler(req)` returns { status, body }. */
async function startFakeServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization ?? null, body: raw ? JSON.parse(raw) : undefined };
      requests.push(record);
      const reply = await handler(record, requests);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function loggedInClient(url) {
  const pair = { accessToken: 'access-1', refreshToken: 'device-1.refresh-1', accessTokenExpiresIn: 900, user: { id: 'user-1', role: 'member' }, deviceId: 'device-1' };
  assert.equal(writeAuth(authFromTokenPair(pair, { serverUrl: url, now: Date.now() })).ok, true);
  return createSyncClient({ serverUrl: url });
}

const NOTE = (overrides = {}) => ({
  id: ulid(), kind: 'word', text: 'decision', translation: '决定', lang: 'en', stars: 1,
  lemma: null, entryId: null, itemId: 'item-1', seq: 1,
  createdAt: '2026-11-24T08:00:00.000Z', updatedAt: '2026-11-24T08:00:00.000Z', deletedAt: null, ...overrides,
});

/**
 * A fake notes server with the contract's PUT semantics: unknown id creates,
 * known id must keep kind/text/lang (else 409), stars are replaced.
 */
function notesHandler(store = new Map()) {
  return (req) => {
    const match = /^\/v1\/notes\/([^/]+)$/.exec(req.path);
    if (req.method === 'PUT' && match) {
      const id = match[1];
      const known = store.get(id);
      const { kind, text, lang, stars, translation = null, entryId = null } = req.body;
      if (known && (known.kind !== kind || known.text !== text || known.lang !== lang)) return fail(409, 'NOTE_CONFLICT');
      const note = NOTE({ ...(known ?? {}), id, kind, text, lang, stars, translation: translation ?? known?.translation ?? null, entryId: entryId ?? known?.entryId ?? null, seq: (known?.seq ?? 0) + 1 });
      store.set(id, note);
      return ok({ note });
    }
    if (req.method === 'GET' && req.path === '/v1/notes') {
      const limit = Number(req.query.limit ?? 30);
      const all = [...store.values()]
        .filter((n) => !req.query.kind || n.kind === req.query.kind)
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      const notes = all.slice(0, limit);
      const hasMore = all.length > limit;
      return ok({ notes, hasMore, nextBefore: hasMore ? notes.at(-1).id : null });
    }
    return fail(404, 'NOT_FOUND');
  };
}

function harness(client, server = { ok: true, url: 'http://x', source: 'env', insecure: false }) {
  const said = [];
  const loading = [];
  const commands = createNotebookCommands({
    client,
    server,
    say: (text, options = {}) => said.push({ text, ...options }),
    withLoading: async (label, task) => {
      loading.push(label);
      return task();
    },
  });
  return { commands, said, loading };
}

const WORD_RESULT = Object.freeze({
  task: 'translate', input: 'acheived', output: 'achieved /əˈtʃiːvd/ 实现了', srcLang: 'en', simple: true,
  entryId: '01JENTRY0000000000000000AA', noteId: null, stars: null,
});

// ---------------------------------------------------------------- endpoints

test('saveNote: PUT /v1/notes/:id with the contract body; optional fields only when present', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, notesHandler());
  const client = loggedInClient(api.url);
  const id = ulid();

  const saved = await saveNote(client, id, { kind: 'word', text: 'decision', translation: '决定', stars: 2, entryId: '01JENTRY0000000000000000AA' });
  assert.equal(api.requests[0].method, 'PUT');
  assert.equal(api.requests[0].path, `/v1/notes/${id}`);
  assert.equal(api.requests[0].authorization, 'Bearer access-1');
  assert.deepEqual(api.requests[0].body, { kind: 'word', text: 'decision', lang: 'en', stars: 2, translation: '决定', entryId: '01JENTRY0000000000000000AA' });
  assert.equal(saved.id, id);
  assert.equal(saved.stars, 2);

  await saveNote(client, ulid(), { kind: 'sentence', text: 'It works.', translation: null, stars: 1, entryId: 'not-a-ulid' });
  assert.deepEqual(api.requests[1].body, { kind: 'sentence', text: 'It works.', lang: 'en', stars: 1 });

  await assert.rejects(saveNote(client, 'nope', { kind: 'word', text: 'x', translation: null, stars: 1 }), TypeError);
  assert.equal(api.requests.length, 2, 'an invalid id is never sent');
});

test('saveNote: error envelopes surface as SyncError codes; malformed answers are BAD_RESPONSE', async (t) => {
  useTempConfig(t);
  const replies = [fail(409, 'NOTE_CONFLICT'), ok({ note: { id: 'x' } })];
  const api = await startFakeServer(t, () => replies.shift());
  const client = loggedInClient(api.url);
  const fields = { kind: 'word', text: 'decision', translation: null, stars: 1 };
  await assert.rejects(saveNote(client, ulid(), fields), (e) => e instanceof SyncError && e.code === 'NOTE_CONFLICT' && e.status === 409);
  await assert.rejects(saveNote(client, ulid(), fields), (e) => e instanceof SyncError && e.code === 'BAD_RESPONSE');
});

test('fetchNotes: first page of 20, kind filter, malformed notes dropped', async (t) => {
  useTempConfig(t);
  const good = NOTE({ id: '01JNOTE0000000000000000002', stars: 3 });
  const api = await startFakeServer(t, (req) => (req.query.kind === 'phrase'
    ? ok({ nope: true })
    : ok({ notes: [good, { id: 'bad', kind: 'word', text: 'x', stars: 9 }], nextBefore: good.id, hasMore: true })));
  const client = loggedInClient(api.url);

  const page = await fetchNotes(client);
  assert.equal(api.requests[0].path, '/v1/notes');
  assert.deepEqual(api.requests[0].query, { limit: String(NOTEBOOK_PAGE_SIZE) });
  assert.equal(NOTEBOOK_PAGE_SIZE, 20);
  assert.deepEqual(page.notes.map((n) => n.id), [good.id]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextBefore, good.id);

  await fetchNotes(client, { kind: 'sentence', before: good.id, limit: 5 });
  assert.deepEqual(api.requests[1].query, { limit: '5', kind: 'sentence', before: good.id });

  await assert.rejects(fetchNotes(client, { kind: 'phrase' }), (e) => e instanceof SyncError && e.code === 'BAD_RESPONSE');
});

test('toNote: requires id, a known kind, text and 1-4 stars; empty optionals become null', () => {
  assert.equal(toNote(null), null);
  assert.equal(toNote(NOTE({ kind: 'idiom' })), null);
  assert.equal(toNote(NOTE({ text: '  ' })), null);
  assert.equal(toNote(NOTE({ stars: 0 })), null);
  assert.equal(toNote(NOTE({ stars: 2.5 })), null);
  const note = toNote(NOTE({ translation: '', lemma: 'decide' }));
  assert.equal(note.translation, null);
  assert.equal(note.lemma, 'decide');
});

// ---------------------------------------------------------------- text

test('parseStarsArg / parseNotebookKind: accepted forms', () => {
  assert.deepEqual(parseStarsArg(''), { ok: true, stars: null });
  assert.deepEqual(parseStarsArg(' 3 '), { ok: true, stars: 3 });
  for (const bad of ['0', '5', '2.5', 'three', '1 2']) assert.deepEqual(parseStarsArg(bad), { ok: false }, bad);

  assert.deepEqual(parseNotebookKind(''), { ok: true, kind: null });
  assert.deepEqual(parseNotebookKind('Word'), { ok: true, kind: 'word' });
  assert.deepEqual(parseNotebookKind('phrases'), { ok: true, kind: 'phrase' });
  assert.deepEqual(parseNotebookKind('sentence'), { ok: true, kind: 'sentence' });
  assert.deepEqual(parseNotebookKind('idioms'), { ok: false });
});

test('starMarks / preview / formatSavedNote', () => {
  assert.equal(starMarks(1), '★☆☆☆');
  assert.equal(starMarks(4), '★★★★');
  assert.equal(starMarks(9), '★★★★');
  assert.equal(preview('a  b\nc', 10), 'a b c');
  assert.equal(preview('abcdefghij', 5), 'abcd…');
  const note = toNote(NOTE({ stars: 3 }));
  assert.equal(formatSavedNote(note, null), 'Saved to your notebook (word): ★★★☆  decision');
  assert.equal(formatSavedNote(note, 3), 'Already in your notebook (word): ★★★☆  decision');
  assert.equal(formatSavedNote(note, 1), 'Stars updated (word): ★★★☆  decision');
});

test('formatNotebook: rows with stars, the kind column only when unfiltered, footers', () => {
  const notes = [
    toNote(NOTE({ stars: 2 })),
    toNote(NOTE({ kind: 'sentence', text: 'She doesn\'t like it.', translation: null, stars: 1 })),
  ];
  const all = formatNotebook({ notes, hasMore: false }, null);
  assert.deepEqual(all.map((b) => b.text), [
    'Notebook (newest first)',
    '★★☆☆  word      decision  决定\n★☆☆☆  sentence  She doesn\'t like it.',
    '2 notes.',
  ]);
  assert.equal(all[0].bold, true);
  assert.equal(all[2].dim, true);

  const words = formatNotebook({ notes: notes.slice(0, 1), hasMore: true }, 'word');
  assert.deepEqual(words.map((b) => b.text), [
    'Notebook · words (newest first)',
    '★★☆☆  decision  决定',
    'Showing the newest 1. The whole notebook is in the mini-program (笔记本).',
  ]);

  assert.equal(formatNotebook({ notes: [], hasMore: false }, 'phrase')[0].text, 'No phrase notes yet.');
  assert.equal(formatNotebook({ notes: [], hasMore: false }, null)[0].text, 'Your notebook is empty.');
});

// ---------------------------------------------------------------- /note glue

test('/note: saves the last result with a ULID; /note 3 on the same result updates the same note', async (t) => {
  useTempConfig(t);
  const store = new Map();
  const api = await startFakeServer(t, notesHandler(store));
  const { commands, said, loading } = harness(loggedInClient(api.url));

  const saved = await commands.runNote('', WORD_RESULT);
  assert.match(saved.noteId, ULID_RE);
  assert.equal(saved.stars, 1);
  assert.notEqual(saved, WORD_RESULT, 'the last result is replaced, not mutated');
  assert.equal(WORD_RESULT.noteId, null);
  assert.deepEqual(api.requests[0].body, {
    kind: 'word', text: 'achieved', lang: 'en', stars: 1, translation: '实现了', entryId: WORD_RESULT.entryId,
  });
  assert.deepEqual(loading, ['Saving to your notebook...']);
  assert.deepEqual(said.at(-1), { text: 'Saved to your notebook (word): ★☆☆☆  achieved', color: 'green' });

  const starred = await commands.runNote('3', saved);
  assert.equal(api.requests[1].path, `/v1/notes/${saved.noteId}`);
  assert.equal(api.requests[1].body.stars, 3);
  assert.equal(starred.noteId, saved.noteId);
  assert.equal(starred.stars, 3);
  assert.equal(store.size, 1, 'one note, updated in place');
  assert.equal(said.at(-1).text, 'Stars updated (word): ★★★☆  achieved');

  // No argument on a saved note keeps its stars (it does not reset them to 1).
  const again = await commands.runNote('', starred);
  assert.equal(api.requests[2].body.stars, 3);
  assert.equal(again.stars, 3);
  assert.equal(said.at(-1).text, 'Already in your notebook (word): ★★★☆  achieved');
});

test('/note: grammar checks and sentences become sentence notes', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, notesHandler());
  const { commands } = harness(loggedInClient(api.url));
  await commands.runNote('2', { ...WORD_RESULT, task: 'check', input: 'She don\'t like it.', output: 'She doesn\'t like it.' });
  assert.deepEqual(api.requests[0].body, { kind: 'sentence', text: 'She doesn\'t like it.', lang: 'en', stars: 2, entryId: WORD_RESULT.entryId });
  await commands.runNote('', { ...WORD_RESULT, input: '我们明天再讨论吧。', output: 'Let\'s discuss it tomorrow.', srcLang: 'zh', entryId: null });
  assert.deepEqual(api.requests[1].body, { kind: 'sentence', text: 'Let\'s discuss it tomorrow.', lang: 'en', stars: 1, translation: '我们明天再讨论吧。' });
});

test('/note: a failed save keeps the id, so the retry PUTs the same note', async (t) => {
  useTempConfig(t);
  const store = new Map();
  const handler = notesHandler(store);
  let down = true;
  const api = await startFakeServer(t, (req) => (down ? fail(503, 'UNAVAILABLE') : handler(req)));
  const { commands, said } = harness(loggedInClient(api.url));

  const failed = await commands.runNote('2', WORD_RESULT);
  assert.match(failed.noteId, ULID_RE);
  assert.equal(failed.stars, null, 'not saved yet');
  assert.equal(said.at(-1).color, 'red');
  assert.match(said.at(-1).text, /^Could not save the note: .*Run \/note again to retry\.$/);

  down = false;
  const retried = await commands.runNote('2', failed);
  assert.equal(api.requests.at(-1).path, `/v1/notes/${failed.noteId}`);
  assert.equal(retried.noteId, failed.noteId);
  assert.equal(retried.stars, 2);
  assert.equal(said.at(-1).text, 'Saved to your notebook (word): ★★☆☆  achieved');
});

test('/note: tips for bad stars, no result, and results that cannot be notes; no request is sent', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, notesHandler());
  const { commands, said } = harness(loggedInClient(api.url));

  assert.equal(await commands.runNote('5', WORD_RESULT), WORD_RESULT);
  assert.match(said.at(-1).text, /^Tip: Use \/note/);
  assert.equal(await commands.runNote('', null), null);
  assert.match(said.at(-1).text, /^Nothing to save yet/);
  const other = { ...WORD_RESULT, input: 'ありがとう', output: '谢谢', srcLang: 'other' };
  assert.equal(await commands.runNote('', other), other);
  assert.match(said.at(-1).text, /^Only English/);
  assert.equal(api.requests.length, 0);
});

test('/note and /notebook: sync off and logged out explain what to do', async (t) => {
  useTempConfig(t);
  const off = harness(null, { ok: false, reason: 'unset' });
  assert.equal(await off.commands.runNote('', WORD_RESULT), WORD_RESULT);
  assert.match(off.said[0].text, /^Sync is off/);
  await off.commands.runNotebook('');
  assert.match(off.said.at(-1).text, /^Sync is off/);

  const loggedOut = harness(createSyncClient({ serverUrl: 'http://127.0.0.1:9' }));
  assert.equal(await loggedOut.commands.runNote('2', WORD_RESULT), WORD_RESULT);
  assert.deepEqual(loggedOut.said, [{ text: 'Not logged in. The notebook is kept in your account: run /login first, then /note again.', color: 'yellow' }]);
  await loggedOut.commands.runNotebook('word');
  assert.match(loggedOut.said.at(-1).text, /run \/login first, then \/notebook again\.$/);
  assert.equal(loggedOut.said.length, 2);
});

// ---------------------------------------------------------------- /notebook glue

test('/notebook: lists the newest notes with stars; kind filter; errors and bad kinds', async (t) => {
  useTempConfig(t);
  const store = new Map();
  for (let i = 0; i < 22; i += 1) {
    const id = `01JNOTE00000000000000000${String(i).padStart(2, '0')}`;
    store.set(id, NOTE({ id, text: `word${i}`, stars: (i % 4) + 1, kind: i === 21 ? 'sentence' : 'word', translation: i === 21 ? null : '词' }));
  }
  let broken = false;
  const handler = notesHandler(store);
  const api = await startFakeServer(t, (req) => (broken ? fail(500, 'INTERNAL') : handler(req)));
  const { commands, said, loading } = harness(loggedInClient(api.url));

  await commands.runNotebook('');
  assert.deepEqual(api.requests[0].query, { limit: '20' });
  assert.deepEqual(loading, ['Loading your notebook...']);
  assert.equal(said[0].text, 'Notebook (newest first)');
  const rows = said[1].text.split('\n');
  assert.equal(rows.length, 20);
  assert.equal(rows[0], '★★☆☆  sentence  word21', 'newest first');
  assert.equal(rows[1], '★☆☆☆  word      word20  词');
  assert.match(said[2].text, /^Showing the newest 20\./);

  said.length = 0;
  await commands.runNotebook('sentences');
  assert.equal(api.requests[1].query.kind, 'sentence');
  assert.deepEqual(said.map((s) => s.text), ['Notebook · sentences (newest first)', '★★☆☆  word21', '1 note.']);

  said.length = 0;
  await commands.runNotebook('idiom');
  assert.match(said[0].text, /^Tip: Use \/notebook/);
  assert.equal(api.requests.length, 2);

  broken = true;
  said.length = 0;
  await commands.runNotebook('');
  assert.deepEqual(said, [{ text: 'Could not load the notebook: INTERNAL message', color: 'red' }]);
});
