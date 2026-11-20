// /review orchestration (src/sync/useReview.js) mounted headlessly with Ink
// against a local fake server: posting each rating, undo on the server,
// retries when the session ends, leftovers carried to the next /review.
// Keys are fed through `handleKey` exactly as the REPL's useInput does.
// Temp XDG_CONFIG_HOME per test; the real ~/.config/t-cli is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { authFromTokenPair, writeAuth } from '../src/sync/authStore.js';
import { createSyncClient } from '../src/sync/client.js';
import { ENTER_GRACE_MS, useReview } from '../src/sync/useReview.js';

const SERVER_ON = Object.freeze({ ok: true, url: 'http://x', source: 'env', insecure: false });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function useTempConfig(t) {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-review-'));
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const ok = (data) => ({ status: 200, body: { success: true, data, error: null } });
const fail = (status, code) => ({ status, body: { success: false, data: null, error: { code, message: `${code} message` } } });

async function startFakeServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const record = { method: req.method, path: new URL(req.url, 'http://x').pathname, body: raw ? JSON.parse(raw) : undefined };
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
  return createSyncClient({ serverUrl: url, timeoutMs: 2000 });
}

const CARD = (n) => ({
  id: `card-${n}`, itemId: `item-${n}`, itemType: 'word', cardType: 'recognize', state: 'review',
  front: { text: `FRONT_${n}` }, back: { text: `BACK_${n}` }, intervals: { 1: 600, 2: 86400, 3: 259200, 4: 5184000 },
});

/** A server with a queue of `cards`; `onReviews` / `onUndo` may override replies. */
function reviewServer(t, { cards = [CARD(1), CARD(2)], onReviews, onUndo } = {}) {
  return startFakeServer(t, async (req, all) => {
    if (req.path === '/v1/review/queue') return ok({ cards });
    if (req.method === 'POST' && req.path === '/v1/reviews') {
      const override = onReviews ? await onReviews(req, all) : null;
      return override ?? ok({ accepted: req.body.logs.map((log) => log.id), rejected: [], cards: [] });
    }
    if (req.method === 'DELETE') {
      const override = onUndo ? await onUndo(req, all) : null;
      return override ?? ok({ card: { id: 'card-1', state: 'review', due: 'x', mastered: false } });
    }
    return fail(404, 'NOT_FOUND');
  });
}

/** Mount useReview in a headless Ink app; `said` collects the notices. */
function mountReview(t, { client, server = SERVER_ON }) {
  const said = [];
  const handle = { api: null };
  function Probe() {
    handle.api = useReview({ client, server, notify: (text) => said.push(text) });
    return null;
  }
  const stdout = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  stdout.columns = 100;
  stdout.rows = 40;
  const instance = render(React.createElement(Probe), { stdout, patchConsole: false, exitOnCtrlC: false });
  t.after(() => instance.unmount());
  const press = (input) => handle.api.handleKey(input, { return: input === '\r', escape: false });
  return { said, handle, press };
}

/** Wait until `predicate()` holds (React commits and HTTP round trips are async). */
async function until(predicate, what, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(10);
  }
}

const reviews = (api) => api.requests.filter((r) => r.method === 'POST' && r.path === '/v1/reviews');

test('review: flip, rate, undo on the server, rate again, finish with a summary', async (t) => {
  useTempConfig(t);
  const api = await reviewServer(t);
  const { said, handle, press } = mountReview(t, { client: loggedInClient(api.url) });

  await handle.api.start();
  assert.ok(said.includes('Review: 2 cards. Enter/space flips · 1–4 rates · u undoes · q quits.'));
  assert.ok(said.includes('FRONT_1'));
  await until(() => handle.api.active, 'the session to render');
  assert.equal(handle.api.statusLine, 'Card 1/2 · Enter/space flip · u undo · q quit');

  press('3'); // rating the front does nothing
  assert.equal(reviews(api).length, 0);
  press(' ');
  assert.ok(said.includes('BACK_1'));
  press('3');
  assert.ok(said.includes('→ 3 记得 · next review in 3 天'));
  await until(() => reviews(api).length === 1, 'the first post');
  const first = reviews(api)[0].body.logs[0];
  assert.match(first.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(first.cardId, 'card-1');
  assert.equal(first.rating, 3);
  assert.ok(Number.isInteger(first.durationMs) && first.durationMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(first.reviewedAt)));

  await delay(30); // let the accepted outcome land
  press('u');
  await until(() => said.some((s) => s.startsWith('Undone: 3 记得 on card 1')), 'the undo');
  const undo = api.requests.find((r) => r.method === 'DELETE');
  assert.equal(undo.path, `/v1/reviews/${first.id}`);

  press('\r'); // Enter flips too
  press('4');
  press(' ');
  press('2');
  assert.ok(said.some((s) => s.startsWith('All 2 cards rated.')));
  press('q');
  await until(() => !handle.api.active && said.some((s) => s.startsWith('Review done')), 'the summary');
  assert.match(said.find((s) => s.startsWith('Review done')), /^Review done: 2 cards · remembered 2\/2 \(100%\) · \d+ s$/);
  assert.deepEqual(reviews(api).map((r) => [r.body.logs[0].cardId, r.body.logs[0].rating]), [['card-1', 3], ['card-1', 4], ['card-2', 2]]);
});

test('review: failed posts are retried when the session ends', async (t) => {
  useTempConfig(t);
  let down = true;
  const api = await reviewServer(t, { onReviews: () => (down ? fail(503, 'UNAVAILABLE') : null) });
  const { said, handle, press } = mountReview(t, { client: loggedInClient(api.url) });

  await handle.api.start();
  press(' ');
  press('1');
  press(' ');
  press('3');
  await until(() => reviews(api).length === 2, 'both posts');
  await delay(30);
  down = false;
  press('q');
  await until(() => said.some((s) => s.startsWith('Review done')), 'the summary');
  const retry = reviews(api).at(-1).body.logs;
  assert.deepEqual(retry.map((log) => log.cardId), ['card-1', 'card-2'], 'one batch with both failed logs');
  assert.ok(!said.some((s) => s.includes('not saved')), 'nothing left unsent');
  assert.match(said.find((s) => s.startsWith('Review done')), /remembered 1\/2 \(50%\)/);
});

test('review: ratings that still fail are kept in memory and saved by the next /review', async (t) => {
  useTempConfig(t);
  let down = true;
  const api = await reviewServer(t, { cards: [CARD(1)], onReviews: () => (down ? fail(503, 'UNAVAILABLE') : null) });
  const { said, handle, press } = mountReview(t, { client: loggedInClient(api.url) });

  await handle.api.start();
  press(' ');
  press('4');
  await until(() => reviews(api).length === 1, 'the post');
  press('q');
  await until(() => said.some((s) => s.startsWith('Review done')), 'the summary');
  assert.ok(said.some((s) => s.startsWith('1 rating was not saved')));
  const unsentId = reviews(api)[0].body.logs[0].id;

  down = false;
  await handle.api.start();
  assert.ok(said.includes('Saved 1 rating from the earlier review.'));
  // Posts: the rating, the end-of-session retry, then the next /review's retry.
  assert.equal(reviews(api).length, 3);
  assert.deepEqual(reviews(api).at(-1).body.logs.map((log) => log.id), [unsentId], 'the same log id again (idempotent)');
});

test('review: a typed "3⏎" rates once without flipping the next card; a chunked "2\\r" rates', async (t) => {
  useTempConfig(t);
  const api = await reviewServer(t, { cards: [CARD(1), CARD(2), CARD(3)] });
  const { said, handle, press } = mountReview(t, { client: loggedInClient(api.url) });

  await handle.api.start();
  press(' ');
  press('3');
  press('\r'); // the Enter of "3⏎": ignored
  assert.ok(!said.includes('BACK_2'), 'card 2 was not flipped');
  await delay(ENTER_GRACE_MS + 50);
  press('\r'); // a deliberate Enter later flips
  assert.ok(said.includes('BACK_2'));

  handle.api.handleKey('2\r', { return: false, escape: false });
  assert.ok(said.includes('FRONT_3'));
  await until(() => reviews(api).length === 2, 'both posts');
  assert.deepEqual(reviews(api).map((r) => r.body.logs[0].rating), [3, 2]);
});

test('review: undo after the server window shows UNDO_EXPIRED and keeps the rating', async (t) => {
  useTempConfig(t);
  const api = await reviewServer(t, { onUndo: () => fail(409, 'UNDO_EXPIRED') });
  const { said, handle, press } = mountReview(t, { client: loggedInClient(api.url) });

  await handle.api.start();
  press(' ');
  press('3');
  await until(() => reviews(api).length === 1, 'the post');
  await delay(30);
  press('u');
  await until(() => said.some((s) => s.startsWith('Too late to undo')), 'the expiry notice');
  await until(() => !handle.api.busy, 'idle again');
  assert.equal(handle.api.statusLine, 'Card 2/2 · Enter/space flip · u undo · q quit', 'still on card 2');
});

test('review: undo right after rating waits for the in-flight post, then deletes it', async (t) => {
  useTempConfig(t);
  const api = await reviewServer(t, { onReviews: async () => { await delay(150); return null; } });
  const { said, handle, press } = mountReview(t, { client: loggedInClient(api.url) });

  await handle.api.start();
  press(' ');
  press('2');
  press('u'); // the post is still in flight
  await until(() => handle.api.busy, 'the wait');
  press('3'); // swallowed while busy
  await until(() => said.some((s) => s.startsWith('Undone: 2 困难 on card 1')), 'the undo');
  assert.equal(api.requests.filter((r) => r.method === 'DELETE').length, 1);
  assert.equal(reviews(api).length, 1, 'the key pressed while busy did nothing');
});

test('review: clear messages when sync is off, logged out, or nothing is due', async (t) => {
  useTempConfig(t);
  const off = mountReview(t, { client: null, server: { ok: false, reason: 'unset' } });
  await off.handle.api.start();
  assert.match(off.said[0], /^Sync is off/);
  assert.equal(off.handle.api.handleKey('q', {}), false, 'no session: keys are not consumed');

  const loggedOut = mountReview(t, { client: createSyncClient({ serverUrl: 'http://127.0.0.1:9' }) });
  await loggedOut.handle.api.start();
  assert.match(loggedOut.said[0], /^Not logged in/);

  const api = await reviewServer(t, { cards: [] });
  const empty = mountReview(t, { client: loggedInClient(api.url) });
  await empty.handle.api.start();
  assert.match(empty.said[0], /^Nothing to review right now/);
  assert.equal(empty.handle.api.active, false);
});
