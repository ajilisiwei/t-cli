// Outbox push: batching, acked-id removal (with lines appended while the
// request is in flight), rejected entries moved aside, and the background
// scheduler's single-flight + backoff. Temp XDG_CONFIG_HOME per test, fake
// HTTP server on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createEntry } from '@t-cli/core/entry';
import {
  appendEntries,
  countRejected,
  getOutboxPath,
  getRejectedPath,
  readOutbox,
  readSyncState,
  replaceOutboxContent,
  updateSyncState,
} from '../src/entryLog.js';
import { authFromTokenPair, writeAuth } from '../src/sync/authStore.js';
import { SyncError, createSyncClient } from '../src/sync/client.js';
import { applyPushResult, pushOutbox, selectBatch } from '../src/sync/push.js';
import { computeBackoffMs, createSyncer } from '../src/sync/syncer.js';

// ---------------------------------------------------------------- helpers

function useTempConfig(t) {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-push-'));
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

let counter = 0;
function makeEntry(overrides = {}) {
  counter += 1;
  return createEntry({
    source: 'cli', task: 'translate', input: `sample input ${counter}`, output: `sample output ${counter}`,
    mode: 'simple', srcLang: 'en', createdAt: new Date(Date.UTC(2026, 10, 17, 1, 0, counter % 60)), ...overrides,
  });
}

const ok = (data) => ({ status: 200, body: { success: true, data, error: null } });
const fail = (status, code) => ({ status, body: { success: false, data: null, error: { code, message: code } } });

/**
 * A fake push endpoint. By default accepts every valid entry; `hooks.onPush`
 * may act before the reply (e.g. append to the outbox) or override it.
 */
async function startFakeApi(t, hooks = {}) {
  const pushes = [];
  const stored = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      let reply;
      if (req.url === '/v1/entries' && req.method === 'POST') {
        pushes.push(body.entries);
        reply = (await hooks.onPush?.(body.entries, pushes.length)) ?? defaultPush(body.entries, stored);
      } else {
        reply = fail(404, 'NOT_FOUND');
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const auth = authFromTokenPair({
    accessToken: 'access-1', refreshToken: 'd.r1', accessTokenExpiresIn: 900, user: { id: 'u1', role: 'member' }, deviceId: 'd',
  }, { serverUrl: url, now: Date.now() });
  assert.equal(writeAuth(auth).ok, true);
  return { url, pushes, stored, client: createSyncClient({ serverUrl: url }) };
}

function defaultPush(entries, stored) {
  const accepted = [];
  const rejected = [];
  entries.forEach((entry, index) => {
    if (entry.task === 'quiz') rejected.push({ index, id: entry.id, errors: ['task must be one of translate/check'] });
    else {
      accepted.push(entry.id);
      stored.add(entry.id);
    }
  });
  return ok({ accepted, rejected, lastSeq: stored.size });
}

const outboxText = () => (fs.existsSync(getOutboxPath()) ? fs.readFileSync(getOutboxPath(), 'utf8') : '');

// ---------------------------------------------------------------- pure helpers

test('selectBatch: count and byte limits, invalid lines skipped and counted', () => {
  const entries = [makeEntry(), makeEntry(), makeEntry()];
  const content = ['not json', ...entries.map((e) => JSON.stringify(e)), '{"v":1}', ''].join('\n');
  const batch = selectBatch(content, { maxEntries: 2 });
  assert.deepEqual(batch.items.map((i) => i.entry.id), entries.slice(0, 2).map((e) => e.id));
  assert.deepEqual(batch.items.map((i) => i.lineIndex), [1, 2]);
  assert.equal(batch.pending, 3);
  assert.equal(batch.invalidLines, 2);

  const lineBytes = Buffer.byteLength(JSON.stringify(entries[0]));
  const bySize = selectBatch(content, { maxEntries: 200, maxBytes: lineBytes + 10 });
  assert.equal(bySize.items.length, 1, 'byte cap');
  assert.equal(selectBatch(content, { maxEntries: 200, maxBytes: 1 }).items.length, 1, 'always at least one entry');
});

test('applyPushResult: drops accepted ids of the batch only, moves rejected by index', () => {
  const [a, b, c, outside] = [makeEntry(), makeEntry(), makeEntry(), makeEntry()];
  const content = [a, b, c, outside].map((e) => JSON.stringify(e)).join('\n') + '\n';
  const items = selectBatch(content, { maxEntries: 3 }).items;
  const result = {
    accepted: [a.id, c.id, outside.id], // `outside` was not in the batch: must stay
    rejected: [{ index: 1, id: b.id, errors: ['nope'] }, { index: 2, id: 'mismatch', errors: ['x'] }],
    lastSeq: 2,
  };
  const applied = applyPushResult(content, items, result, { rejectedAt: '2026-11-17T00:00:00.000Z' });
  assert.equal(applied.content, `${JSON.stringify(outside)}\n`);
  assert.deepEqual(applied.accepted.sort(), [a.id, c.id].sort());
  assert.equal(applied.rejectedLines.length, 1);
  assert.deepEqual(JSON.parse(applied.rejectedLines[0]), { rejectedAt: '2026-11-17T00:00:00.000Z', errors: ['nope'], entry: JSON.parse(JSON.stringify(b)) });

  const kept = applyPushResult(content, items, result, { rejectedAt: 'x', moveRejected: false });
  assert.ok(kept.content.includes(b.id), 'rejected line kept when it cannot be moved aside');
});

test('replaceOutboxContent: keeps a concurrent tail, refuses other changes', (t) => {
  useTempConfig(t);
  const [a, b, c] = [makeEntry(), makeEntry(), makeEntry()];
  appendEntries([a, b]);
  const original = outboxText();
  appendEntries([c]); // appended after `original` was read
  const result = replaceOutboxContent({ original, rewritten: `${JSON.stringify(b)}\n` });
  assert.equal(result.ok, true);
  assert.deepEqual(readOutbox().entries.map((e) => e.id), [b.id, c.id]);

  const stale = outboxText();
  fs.writeFileSync(getOutboxPath(), `${JSON.stringify(a)}\n`); // rewritten by someone else
  const refused = replaceOutboxContent({ original: stale, rewritten: '' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /changed other than by appending/);
  assert.equal(outboxText(), `${JSON.stringify(a)}\n`);
});

// ---------------------------------------------------------------- pushOutbox

test('pushOutbox: batches of 200, acked entries removed, re-push sends nothing', async (t) => {
  useTempConfig(t);
  const api = await startFakeApi(t);
  const entries = Array.from({ length: 450 }, () => makeEntry());
  appendEntries(entries);

  const summary = await pushOutbox({ client: api.client });
  assert.equal(summary.error, null);
  assert.deepEqual(api.pushes.map((batch) => batch.length), [200, 200, 50]);
  assert.deepEqual(api.pushes.flat().map((e) => e.id), entries.map((e) => e.id));
  assert.equal(summary.accepted, 450);
  assert.equal(summary.remaining, 0);
  assert.deepEqual(readOutbox().entries, []);

  const again = await pushOutbox({ client: api.client });
  assert.equal(again.attempted, false);
  assert.equal(api.pushes.length, 3, 'nothing re-sent');
});

test('pushOutbox: an entry appended while the request is in flight survives the rewrite', async (t) => {
  useTempConfig(t);
  const late = makeEntry({ input: 'appended during push' });
  const api = await startFakeApi(t, {
    onPush: (entries, n) => {
      if (n === 1) appendEntries([late]); // the TUI records a new result meanwhile
      if (n === 2) return fail(503, 'HTTP_503'); // stop before the next batch is sent
      return undefined;
    },
  });
  const first = [makeEntry(), makeEntry()];
  appendEntries(first);

  const summary = await pushOutbox({ client: api.client });
  assert.equal(summary.accepted, 2);
  assert.equal(summary.error?.status, 503);
  assert.deepEqual(readOutbox().entries.map((e) => e.id), [late.id], 'only the acked ids were removed');
  assert.deepEqual(api.pushes[1].map((e) => e.id), [late.id], 'the late entry was picked up by the next batch');
});

test('pushOutbox: rejected entries move to outbox.rejected.jsonl; invalid local lines stay', async (t) => {
  useTempConfig(t);
  const good = makeEntry();
  const bad = { ...makeEntry(), task: 'quiz' }; // locally invalid too, so write it raw
  const serverOnlyBad = makeEntry({ input: 'server rejects this one' });
  fs.mkdirSync(path.dirname(getOutboxPath()), { recursive: true });
  fs.writeFileSync(getOutboxPath(), [JSON.stringify(good), JSON.stringify(bad), 'garbage', JSON.stringify(serverOnlyBad)].join('\n') + '\n');

  const rejecting = await startFakeApi(t, {
    onPush: (entries) => ok({
      accepted: entries.filter((e) => e.id !== serverOnlyBad.id).map((e) => e.id),
      rejected: entries.flatMap((e, index) => (e.id === serverOnlyBad.id ? [{ index, id: e.id, errors: ['input or output too long'] }] : [])),
      lastSeq: 1,
    }),
  });
  const summary = await pushOutbox({ client: rejecting.client });
  assert.equal(summary.error, null);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.invalidLines, 2);
  assert.deepEqual(rejecting.pushes[0].map((e) => e.id), [good.id, serverOnlyBad.id], 'locally invalid lines are never sent');
  assert.equal(outboxText(), [JSON.stringify(bad), 'garbage', ''].join('\n'), 'invalid lines left in place');
  assert.equal(countRejected(), 1);
  const moved = JSON.parse(fs.readFileSync(getRejectedPath(), 'utf8').trim());
  assert.equal(moved.entry.id, serverOnlyBad.id);
  assert.deepEqual(moved.errors, ['input or output too long']);
});

test('pushOutbox: a rewrite conflict leaves the outbox alone and reports a local error', async (t) => {
  useTempConfig(t);
  const replacement = `${JSON.stringify(makeEntry())}\n`;
  const api = await startFakeApi(t, {
    onPush: () => {
      fs.writeFileSync(getOutboxPath(), replacement); // e.g. another process rewrote it
      return undefined;
    },
  });
  appendEntries([makeEntry()]);
  const summary = await pushOutbox({ client: api.client });
  assert.equal(summary.error?.code, 'LOCAL_IO');
  assert.equal(outboxText(), replacement);
});

// ---------------------------------------------------------------- scheduler

test('computeBackoffMs: exponential with jitter, capped', () => {
  const opts = (random) => ({ baseMs: 10_000, maxMs: 300_000, random: () => random });
  assert.equal(computeBackoffMs(1, opts(0)), 5_000);
  assert.equal(computeBackoffMs(1, opts(1)), 10_000);
  assert.equal(computeBackoffMs(3, opts(1)), 40_000);
  assert.equal(computeBackoffMs(10, opts(1)), 300_000);
  assert.equal(computeBackoffMs(50, opts(0)), 150_000);
  assert.equal(computeBackoffMs(0, opts(1)), 0);
});

function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fireAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
  };
}

const summaryOk = { attempted: true, batches: 1, accepted: 1, rejected: 0, remaining: 0, invalidLines: 0, error: null };
const networkError = () => new SyncError({ kind: 'network', code: 'NETWORK', message: 'network error (ECONNREFUSED)' });

test('syncer: backoff after network errors, retry by timer, reset on success', async (t) => {
  useTempConfig(t);
  updateSyncState({ liveSince: '2026-11-17T09:00:00+08:00' });
  let now = 1_000_000;
  const timers = fakeTimers();
  const results = [{ ...summaryOk, accepted: 0, remaining: 1, error: networkError() }, { ...summaryOk, error: networkError() }, summaryOk];
  let calls = 0;
  const syncer = createSyncer({
    client: { getAuth: () => ({}) },
    push: async () => results[calls++],
    now: () => now,
    timers,
    random: () => 1,
  });
  t.after(() => syncer.dispose());

  await syncer.requestPush();
  let snap = syncer.getSnapshot();
  assert.equal(snap.phase, 'backoff');
  assert.equal(snap.failures, 1);
  assert.equal(snap.nextRetryAt, now + 10_000);
  assert.deepEqual([...timers.pending.values()].map((p) => p.ms), [10_000]);

  assert.equal(await syncer.requestPush(), null, 'a new record during backoff does not push');
  assert.equal(calls, 1);

  now += 10_000;
  timers.fireAll();
  await waitFor(() => calls === 2 && syncer.getSnapshot().phase !== 'pushing');
  snap = syncer.getSnapshot();
  assert.equal(snap.failures, 2);
  assert.deepEqual([...timers.pending.values()].map((p) => p.ms), [20_000], 'doubles');

  const forced = await syncer.requestPush({ force: true }); // /sync now skips the backoff
  assert.equal(forced, summaryOk);
  snap = syncer.getSnapshot();
  assert.deepEqual([snap.phase, snap.failures, snap.nextRetryAt, timers.pending.size], ['idle', 0, null, 0]);

  const state = readSyncState();
  assert.equal(state.liveSince, '2026-11-17T09:00:00+08:00', 'liveSince kept');
  assert.equal(state.lastPush.ok, true);
  assert.equal(state.lastPush.accepted, 1);
});

test('syncer: single-flight, one follow-up pass for requests made during a push', async (t) => {
  useTempConfig(t);
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let release;
  const syncer = createSyncer({
    client: { getAuth: () => ({}) },
    push: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await new Promise((resolve) => { release = resolve; });
      active -= 1;
      return summaryOk;
    },
    timers: fakeTimers(),
  });
  t.after(() => syncer.dispose());

  const first = syncer.requestPush();
  const second = syncer.requestPush();
  const third = syncer.requestPush();
  assert.equal(syncer.getSnapshot().phase, 'pushing');
  release();
  await Promise.all([first, second, third]);
  assert.equal(calls, 2, 'one push plus one follow-up for the requests made meanwhile');
  assert.equal(maxActive, 1, 'never two pushes at once');
});

test('syncer: auth failures do not retry; logged out does nothing', async (t) => {
  useTempConfig(t);
  const timers = fakeTimers();
  let loggedIn = true;
  let calls = 0;
  const syncer = createSyncer({
    client: { getAuth: () => (loggedIn ? {} : null) },
    push: async () => {
      calls += 1;
      return { ...summaryOk, error: new SyncError({ kind: 'auth', code: 'REFRESH_INVALID', message: 'please /login again' }) };
    },
    timers,
  });
  t.after(() => syncer.dispose());
  await syncer.requestPush();
  assert.equal(timers.pending.size, 0);
  assert.equal(syncer.getSnapshot().last.error.code, 'REFRESH_INVALID');
  loggedIn = false;
  assert.equal(await syncer.requestPush({ force: true }), null);
  assert.equal(calls, 1);
});

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
