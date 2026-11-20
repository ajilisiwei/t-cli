// Learning endpoints (review, materials, day entries, settings), settings
// sync and the /weekly · /notes · /history glue, against a local fake HTTP
// server. Every test gets its own XDG_CONFIG_HOME, so the real
// ~/.config/t-cli is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { authFromTokenPair, writeAuth } from '../src/sync/authStore.js';
import { SyncError, createSyncClient } from '../src/sync/client.js';
import {
  classifyReviewError,
  classifyReviewResult,
  fetchDailyMaterial,
  fetchDayEntries,
  fetchReviewQueue,
  fetchSettings,
  fetchWeeklyReport,
  listMaterialDates,
  pushSettings,
  submitReviewLogs,
  toQueueCard,
  undoReviewLog,
  utcOffsetMinutes,
} from '../src/sync/learning.js';
import { flushPendingSettings, markLangPending, reconcileSettings, syncStatePendingStore } from '../src/sync/settingsSync.js';
import { createLearningCommands } from '../src/sync/learningCommands.js';
import { readSyncState } from '../src/entryLog.js';

// ---------------------------------------------------------------- helpers

function useTempConfig(t) {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-learning-'));
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const ok = (data) => ({ status: 200, body: { success: true, data, error: null } });
const fail = (status, code) => ({ status, body: { success: false, data: null, error: { code, message: `${code} message` } } });

/** Local fake API server; `handler(req)` returns { status, body } or 'hang'. */
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
      if (reply === 'hang') return;
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

function loggedInClient(url, options = {}) {
  const pair = { accessToken: 'access-1', refreshToken: 'device-1.refresh-1', accessTokenExpiresIn: 900, user: { id: 'user-1', role: 'member' }, deviceId: 'device-1' };
  assert.equal(writeAuth(authFromTokenPair(pair, { serverUrl: url, now: Date.now() })).ok, true);
  return createSyncClient({ serverUrl: url, ...options });
}

const CARD = (n, overrides = {}) => ({
  id: `card-${n}`, itemId: `item-${n}`, itemType: 'word', cardType: 'recognize',
  front: { text: `word${n}`, ipa: 'wɜːd' }, back: { text: 'n. 单词', example: { en: 'A word.', zh: '一个词。' } },
  state: 'new', intervals: { 1: 60, 2: 600, 3: 86400, 4: 259200 }, ...overrides,
});

const LOG = (n) => ({ id: `01JLOG${String(n).padStart(20, '0')}`, cardId: `card-${n}`, rating: 3, reviewedAt: '2026-11-20T01:00:00.000Z', durationMs: 1200 });

// ---------------------------------------------------------------- review

test('fetchReviewQueue: sends the local offset and limit, keeps well-formed cards only', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, () => ok({ cards: [CARD(1), { id: 'broken' }, CARD(2, { intervals: { 1: 'x' } })] }));
  const client = loggedInClient(api.url);
  const cards = await fetchReviewQueue(client, { limit: 20 });
  assert.equal(api.requests[0].path, '/v1/review/queue');
  assert.equal(api.requests[0].query.limit, '20');
  assert.equal(api.requests[0].query.utcOffsetMinutes, String(utcOffsetMinutes()));
  assert.equal(api.requests[0].authorization, 'Bearer access-1');
  assert.deepEqual(cards.map((c) => c.id), ['card-1', 'card-2']);
  assert.equal(cards[0].intervals['3'], 86400);
  assert.equal(cards[1].intervals['1'], null);
  assert.equal(cards[0].front.ipa, 'wɜːd');
  assert.deepEqual(cards[0].back.example, { en: 'A word.', zh: '一个词。' });
});

test('fetchReviewQueue: malformed answers are protocol errors', async (t) => {
  useTempConfig(t);
  const replies = [ok({ nope: true }), ok({ cards: [{ id: 'x' }] })];
  const api = await startFakeServer(t, () => replies.shift());
  const client = loggedInClient(api.url);
  await assert.rejects(fetchReviewQueue(client), (e) => e instanceof SyncError && e.code === 'BAD_RESPONSE');
  await assert.rejects(fetchReviewQueue(client), (e) => e instanceof SyncError && e.code === 'BAD_RESPONSE');
});

test('toQueueCard: rejects cards without id or text faces; drops empty optional fields', () => {
  assert.equal(toQueueCard(null), null);
  assert.equal(toQueueCard({ id: 'a', front: { text: 'x' } }), null);
  assert.equal(toQueueCard({ id: '', front: { text: 'x' }, back: { text: 'y' } }), null);
  const card = toQueueCard({ id: 'a', front: { text: 'x', ipa: ' ', sub: '' }, back: { text: 'y', example: { en: 'e' } } });
  assert.deepEqual({ ...card.front }, { text: 'x' });
  assert.deepEqual(card.back.example, { en: 'e', zh: '' });
  assert.deepEqual({ ...card.intervals }, { 1: null, 2: null, 3: null, 4: null });
});

test('submitReviewLogs: posts the logs and classifies accepted / rejected / unacknowledged', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => ok({
    accepted: [req.body.logs[0].id],
    rejected: [{ id: req.body.logs[1].id, errors: ['unknown card'] }],
    cards: [],
  }));
  const client = loggedInClient(api.url);
  const logs = [LOG(1), LOG(2), LOG(3)];
  const outcomes = await submitReviewLogs(client, logs);
  assert.equal(api.requests[0].method, 'POST');
  assert.equal(api.requests[0].path, '/v1/reviews');
  assert.deepEqual(api.requests[0].body, { logs });
  assert.deepEqual(outcomes, [
    { id: logs[0].id, status: 'accepted', error: null },
    { id: logs[1].id, status: 'rejected', error: 'unknown card' },
    { id: logs[2].id, status: 'failed', error: 'not acknowledged' },
  ]);
});

test('submitReviewLogs: transient and auth failures leave logs failed; other HTTP errors reject them', async (t) => {
  useTempConfig(t);
  const replies = [fail(503, 'UNAVAILABLE'), fail(400, 'VALIDATION_FAILED')];
  const api = await startFakeServer(t, () => replies.shift());
  const client = loggedInClient(api.url);
  assert.equal((await submitReviewLogs(client, [LOG(1)]))[0].status, 'failed');
  const rejected = await submitReviewLogs(client, [LOG(1)]);
  assert.equal(rejected[0].status, 'rejected');
  assert.match(rejected[0].error, /VALIDATION_FAILED/);

  const loggedOut = createSyncClient({ serverUrl: 'http://127.0.0.1:9' });
  fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 't-cli', 'auth.json'));
  assert.equal((await submitReviewLogs(loggedOut, [LOG(1)]))[0].status, 'failed');
});

test('classifyReviewResult / classifyReviewError: malformed answers and plain errors are retryable', () => {
  assert.equal(classifyReviewResult([LOG(1)], { accepted: 'x' })[0].status, 'failed');
  assert.equal(classifyReviewError([LOG(1)], new Error('boom'))[0].status, 'failed');
  const network = new SyncError({ kind: 'network', code: 'NETWORK', message: 'network error' });
  assert.equal(classifyReviewError([LOG(1)], network)[0].status, 'failed');
  const conflict = new SyncError({ kind: 'http', code: 'CONFLICT', status: 409, message: 'conflict' });
  assert.equal(classifyReviewError([LOG(1)], conflict)[0].status, 'rejected');
});

test('undoReviewLog: DELETE /v1/reviews/:id; UNDO_EXPIRED and NOT_FOUND surface as codes', async (t) => {
  useTempConfig(t);
  const replies = [ok({ card: { id: 'card-1', state: 'new', due: '2026-11-20T00:00:00Z', mastered: false } }), fail(409, 'UNDO_EXPIRED'), fail(404, 'NOT_FOUND')];
  const api = await startFakeServer(t, () => replies.shift());
  const client = loggedInClient(api.url);
  await undoReviewLog(client, 'LOG/1');
  assert.equal(api.requests[0].method, 'DELETE');
  assert.equal(api.requests[0].path, '/v1/reviews/LOG%2F1');
  await assert.rejects(undoReviewLog(client, 'a'), (e) => e.code === 'UNDO_EXPIRED' && e.status === 409);
  await assert.rejects(undoReviewLog(client, 'a'), (e) => e.code === 'NOT_FOUND' && e.status === 404);
});

// ---------------------------------------------------------------- materials, day entries

test('materials: daily/weekly by date or latest; 404 is null; list filters dates', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => {
    if (req.path === '/v1/materials') return ok({ dates: ['2026-11-19', 'bad', 7, '2026-11-18'], nextBefore: null });
    if (req.query.date === '2026-01-01') return fail(404, 'NOT_FOUND');
    if (req.query.date === '2026-01-02') return ok({ date: '2026-01-02', content: 'not an object' });
    return ok({ date: req.query.date ?? '2026-11-19', content: { date: 'x' }, createdAt: '2026-11-20T05:00:00Z' });
  });
  const client = loggedInClient(api.url);

  const latest = await fetchDailyMaterial(client, null);
  assert.equal(api.requests[0].path, '/v1/materials/daily');
  assert.deepEqual(api.requests[0].query, {});
  assert.deepEqual(latest, { date: '2026-11-19', content: { date: 'x' }, createdAt: '2026-11-20T05:00:00Z' });

  const weekly = await fetchWeeklyReport(client, '2026-11-09');
  assert.equal(api.requests[1].path, '/v1/materials/weekly');
  assert.equal(api.requests[1].query.date, '2026-11-09');
  assert.equal(weekly.date, '2026-11-09');

  assert.equal(await fetchDailyMaterial(client, '2026-01-01'), null);
  await assert.rejects(fetchDailyMaterial(client, '2026-01-02'), (e) => e.code === 'BAD_RESPONSE');

  assert.deepEqual(await listMaterialDates(client, { kind: 'daily' }), ['2026-11-19', '2026-11-18']);
  assert.deepEqual(api.requests.at(-1).query, { kind: 'daily', limit: '14' });
});

test('fetchDayEntries: date + that day\'s offset; malformed entries dropped', async (t) => {
  useTempConfig(t);
  const good = { id: '01J1', source: 'mp', task: 'translate', input: 'hi', output: '你好', createdAt: '2026-11-19T08:00:00+08:00', seq: 4 };
  const api = await startFakeServer(t, () => ok({ entries: [good, { ...good, id: '01J2', createdAt: 'nope' }, { ...good, id: '01J3', input: ' ' }, 'x'] }));
  const client = loggedInClient(api.url);
  const entries = await fetchDayEntries(client, '2026-11-19');
  assert.equal(api.requests[0].path, '/v1/entries/day');
  assert.deepEqual(api.requests[0].query, { date: '2026-11-19', utcOffsetMinutes: String(utcOffsetMinutes('2026-11-19')) });
  assert.deepEqual(entries.map((e) => e.id), ['01J1']);
});

test('utcOffsetMinutes: east-positive minutes of the process time zone', () => {
  assert.equal(utcOffsetMinutes(), -new Date().getTimezoneOffset() || 0);
  assert.equal(utcOffsetMinutes('2026-07-01'), -new Date(2026, 6, 1, 12).getTimezoneOffset() || 0);
});

// ---------------------------------------------------------------- settings

test('fetchSettings / pushSettings: GET /v1/me and POST /v1/me/settings', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => (req.method === 'GET'
    ? ok({ id: 'user-1', role: 'member', createdAt: 'x', settings: { explanationLang: 'zh' } })
    : ok({ settings: { explanationLang: req.body.explanationLang, autoSpeakWord: true } })));
  const client = loggedInClient(api.url);
  assert.deepEqual(await fetchSettings(client), { explanationLang: 'zh' });
  assert.deepEqual(await pushSettings(client, { explanationLang: 'en' }), { explanationLang: 'en', autoSpeakWord: true });
  assert.equal(api.requests[1].path, '/v1/me/settings');
  assert.deepEqual(api.requests[1].body, { explanationLang: 'en' });
});

test('settings sync: a pending /lang change is pushed at startup instead of reading the server', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => (req.method === 'POST' ? ok({ settings: req.body }) : ok({ settings: { explanationLang: 'zh' } })));
  const client = loggedInClient(api.url);
  markLangPending('en');
  assert.deepEqual(readSyncState().pendingSettings, { explanationLang: 'en' });

  const result = await reconcileSettings({ client, localLang: 'en' });
  assert.deepEqual(result, { action: 'pushed' });
  assert.deepEqual(api.requests.map((r) => `${r.method} ${r.path}`), ['POST /v1/me/settings']);
  assert.equal(syncStatePendingStore.read(), null);
});

test('settings sync: offline, the local change stays pending and wins', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, () => fail(503, 'UNAVAILABLE'));
  const client = loggedInClient(api.url);
  markLangPending('en');
  const flushed = await flushPendingSettings({ client });
  assert.equal(flushed.ok, false);
  const result = await reconcileSettings({ client, localLang: 'en' });
  assert.equal(result.action, 'push_failed');
  assert.deepEqual(syncStatePendingStore.read(), { explanationLang: 'en' });
  assert.ok(api.requests.every((r) => r.method === 'POST'), 'never reads the server while a change is pending');
});

test('settings sync: an explicit server language different from the local one is applied; absent is not', async (t) => {
  useTempConfig(t);
  const replies = [
    ok({ settings: { explanationLang: 'zh' } }),
    ok({ settings: { explanationLang: 'en' } }),
    ok({ settings: {} }),
    ok({ settings: { explanationLang: 'fr' } }),
  ];
  const api = await startFakeServer(t, () => replies.shift());
  const client = loggedInClient(api.url);
  assert.deepEqual(await reconcileSettings({ client, localLang: 'en' }), { action: 'apply', lang: 'zh' });
  assert.deepEqual(await reconcileSettings({ client, localLang: 'en' }), { action: 'unchanged' });
  assert.deepEqual(await reconcileSettings({ client, localLang: 'en' }), { action: 'unchanged' });
  assert.deepEqual(await reconcileSettings({ client, localLang: 'en' }), { action: 'unchanged' });
});

test('settings sync: a /lang change made while GET /v1/me is in flight wins over the server value', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, () => {
    markLangPending('en'); // the user runs /lang en meanwhile
    return ok({ settings: { explanationLang: 'zh' } });
  });
  const client = loggedInClient(api.url);
  assert.deepEqual(await reconcileSettings({ client, localLang: 'en' }), { action: 'unchanged' });
  assert.equal(api.requests.length, 1);
});

test('settings sync: a newer pending change is not cleared by an older push', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => {
    markLangPending('zh'); // changed again while the push of "en" was in flight
    return ok({ settings: req.body });
  });
  const client = loggedInClient(api.url);
  markLangPending('en');
  assert.deepEqual(await flushPendingSettings({ client }), { ok: true, pushed: true });
  assert.deepEqual(syncStatePendingStore.read(), { explanationLang: 'zh' });
  assert.equal(api.requests.length, 1);
});

// ---------------------------------------------------------------- command glue

function commandHarness(client, server = { ok: true, url: 'http://x', source: 'env', insecure: false }) {
  const said = [];
  const loading = [];
  const commands = createLearningCommands({
    client,
    server,
    say: (text, options = {}) => said.push({ text, ...options }),
    withLoading: async (label, task) => {
      loading.push(label);
      return task();
    },
    today: () => '2026-11-20',
  });
  return { commands, said, loading };
}

test('/weekly: latest, a date\'s week (Monday), 404 and bad dates', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => (req.query.date === '2026-11-02'
    ? fail(404, 'NOT_FOUND')
    : ok({ date: req.query.date ?? '2026-11-09', content: { weekStart: req.query.date ?? '2026-11-09', weekEnd: '2026-11-15', totals: { entries: 3 }, summary: 'Good week.' } })));
  const { commands, said, loading } = commandHarness(loggedInClient(api.url));

  await commands.runWeekly('');
  assert.deepEqual(api.requests[0].query, {});
  assert.match(said[0].text, /Weekly report · 2026-11-09 – 2026-11-15/);
  assert.ok(said.some((s) => s.text.includes('Good week.')));
  assert.equal(loading.length, 1);

  await commands.runWeekly('2026-11-12'); // a Thursday
  assert.equal(api.requests[1].query.date, '2026-11-09');

  said.length = 0;
  await commands.runWeekly('2026-11-05');
  assert.equal(api.requests[2].query.date, '2026-11-02');
  assert.deepEqual(said.map((s) => s.text), ['No weekly report for the week of 2026-11-02.']);

  said.length = 0;
  await commands.runWeekly('2026-02-31');
  assert.match(said[0].text, /^Tip: Use \/weekly/);
  assert.equal(api.requests.length, 3);
});

test('/weekly: clear messages when sync is off or not logged in', async (t) => {
  useTempConfig(t);
  const off = commandHarness(null, { ok: false, reason: 'unset' });
  await off.commands.runWeekly('');
  assert.match(off.said[0].text, /^Sync is off/);

  const loggedOut = commandHarness(createSyncClient({ serverUrl: 'http://127.0.0.1:9' }));
  await loggedOut.commands.runWeekly('');
  assert.match(loggedOut.said[0].text, /^Not logged in/);
});

test('/notes cloud: shows the material when there is one, falls back (false) on 404, errors and logout', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => {
    if (req.query.date === '2026-11-19') return ok({ date: '2026-11-19', content: { date: '2026-11-19', words: [{ headword: 'meticulous', ipa: 'məˈtɪkjələs', meanings: [{ pos: 'adj.', zh: '一丝不苟的' }] }] } });
    if (req.query.date === '2026-11-18') return fail(500, 'INTERNAL');
    return fail(404, 'NOT_FOUND');
  });
  const { commands, said } = commandHarness(loggedInClient(api.url));

  assert.equal(await commands.showDailyMaterial('2026-11-19'), true);
  assert.equal(said[0].text, 'Daily material · 2026-11-19');
  assert.ok(said.some((s) => s.text.includes('meticulous  /məˈtɪkjələs/')));

  said.length = 0;
  assert.equal(await commands.showDailyMaterial('2026-11-20'), false);
  assert.deepEqual(said.map((s) => s.text), ['No cloud material for 2026-11-20; using local notes.']);

  said.length = 0;
  assert.equal(await commands.showDailyMaterial('2026-11-18'), false);
  assert.match(said[0].text, /^Cloud material unavailable/);

  const loggedOut = commandHarness(createSyncClient({ serverUrl: 'http://127.0.0.1:9' }));
  fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 't-cli', 'auth.json'));
  assert.equal(await loggedOut.commands.showDailyMaterial('2026-11-19'), false);
  assert.equal(loggedOut.said.length, 0, 'logged out: the local flow runs silently');
});

test('/notes listing and /history phone records via the glue', async (t) => {
  useTempConfig(t);
  const mp = { id: '01J1', source: 'mp', task: 'translate', input: 'hi', output: '你好', createdAt: '2026-11-19T08:00:00+08:00' };
  const api = await startFakeServer(t, (req) => {
    if (req.path === '/v1/materials') return ok({ dates: ['2026-11-20', '2026-11-19'], nextBefore: null });
    return ok({ entries: [mp, { ...mp, id: '01J2', source: 'cli' }] });
  });
  const { commands, said } = commandHarness(loggedInClient(api.url));
  await commands.listDailyMaterials();
  assert.equal(said[0].text, 'Daily Materials (cloud)\n2026-11-20 (today)\n2026-11-19\nUse /notes <YYYY-MM-DD> to read.');
  const phone = await commands.loadPhoneRecords('2026-11-19');
  assert.deepEqual(phone.map((e) => e.id), ['01J1']);
});
