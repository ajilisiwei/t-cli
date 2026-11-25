import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { cards, users } from '../src/db/schema.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import type { Block, PdfDocument } from '../src/modules/export/document.ts';
import { countPdfPages } from '../src/modules/export/pdfPages.ts';
import { RenderFailedError, RendererUnavailableError, type PdfRenderer, type RenderResult } from '../src/modules/export/renderer.ts';
import { registerExportRoutes } from '../src/modules/export/routes.ts';
import {
  buildTestApp,
  fakeAlerter,
  fakeLlm,
  fakeRegenerator,
  fakeTts,
  fakeWechat,
  fixedClock,
  testConfig,
  type TestClock,
} from './helpers/app.ts';
import { captureLogs } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { prototypeDaily, prototypeDigest, prototypeExtend, skipWithoutTypst, TYPST_BIN, TYPST_FONT_PATH } from './helpers/exportFixtures.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { createLearner, seedItem, seedLog } from './helpers/learning.ts';

const DAY_MS = 86_400_000;
const URL_PDF = '/v1/exports/pdf';

interface FakeRenderer extends PdfRenderer {
  docs: PdfDocument[];
  next: (doc: PdfDocument) => Promise<RenderResult>;
}

const fakePdf = (pages: number): RenderResult => ({ pdf: Buffer.from(`%PDF-1.7 fake ${pages}`), pages, queueMs: 0, renderMs: 1 });

/** Plain SQL: `materials.kind` gains digest and extend with the v3 migration; the column is text. */
async function insertMaterial(t: TestDatabase, userId: string, kind: string, date: string, content: Record<string, unknown>): Promise<void> {
  await t.sql`insert into materials (user_id, kind, date, content) values (${userId}, ${kind}, ${date}, ${JSON.stringify(content)}::jsonb)`;
}

function fakeRenderer(): FakeRenderer {
  const renderer: FakeRenderer = {
    docs: [],
    next: async () => fakePdf(3),
    async render(doc) {
      renderer.docs.push(doc);
      return renderer.next(doc);
    },
  };
  return renderer;
}

describe('POST /v1/exports/pdf', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;
  let renderer: FakeRenderer;
  let logs: { text(): string };

  before(async () => {
    t = await createTestDatabase();
    clock = fixedClock(); // 2026-11-17 10:00 +08:00
    renderer = fakeRenderer();
    app = Fastify({ logger: { level: 'info' } });
    registerErrorHandler(app);
    const deps = {
      config: testConfig(),
      db: t.db,
      clock,
      wechat: fakeWechat(),
      llm: fakeLlm(),
      tts: fakeTts(),
      regenerator: fakeRegenerator(),
      alerter: fakeAlerter(),
    };
    await registerExportRoutes(app, deps, { renderer });
    await app.ready();
    logs = captureLogs(app);
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  const learner = () => createLearner(t.db, { now: clock() });
  const post = (account: TestAccount | null, payload: unknown) =>
    app.inject({ method: 'POST', url: URL_PDF, headers: account?.headers ?? {}, payload: payload as Record<string, unknown> });
  const lastDoc = (): PdfDocument => {
    const doc = renderer.docs[renderer.docs.length - 1];
    if (!doc) throw new Error('nothing rendered');
    return doc;
  };
  const block = <K extends Block['kind']>(doc: PdfDocument, kind: K): Extract<Block, { kind: K }> | undefined =>
    doc.sections[0]?.blocks.find((b): b is Extract<Block, { kind: K }> => b.kind === kind);
  const seedMaterial = async (userId: string, kind: 'daily' | 'digest' | 'extend', date: string, content: Record<string, unknown>) => {
    await insertMaterial(t, userId, kind, date, content);
  };

  test('requires a token; validates the body without echoing it', async () => {
    assert.equal((await post(null, { scope: 'checklist' })).statusCode, 401);
    const account = await learner();
    for (const body of [{}, { scope: 'material' }, { scope: 'cards', materials: [] }, { scope: 'material', materials: [{ kind: 'weekly', date: '2026-11-16' }] }]) {
      const res = await post(account, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
    assert.ok(!(await post(account, { scope: 'secret-scope-value' })).body.includes('secret-scope-value'));
  });

  test('a material: PDF bytes, file name, page header; word notes from the account', async () => {
    const account = await learner();
    const mitigate = await seedItem(t.db, account.userId, { display: 'mitigate', lookupCount: 1 });
    const concise = await seedItem(t.db, account.userId, { display: 'concise', stars: 3 });
    for (const days of [2, 5]) {
      await seedLog(t.db, account.userId, { cardId: mitigate.cardIds[0]!, rating: 1, reviewedAt: new Date(clock().getTime() - days * DAY_MS) });
    }
    await seedLog(t.db, account.userId, { cardId: mitigate.cardIds[0]!, rating: 1, reviewedAt: new Date(clock().getTime() - 40 * DAY_MS) });
    const content = prototypeDaily('2026-11-16');
    const ids = [mitigate.itemId, concise.itemId];
    const words = (content.words as { itemId: string }[]).map((word, index) => ({ ...word, itemId: ids[index] ?? word.itemId }));
    await seedMaterial(account.userId, 'daily', '2026-11-16', { ...content, words });

    const res = await post(account, { scope: 'material', materials: [{ kind: 'daily', date: '2026-11-16' }] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('学习资料_1116.pdf')}`);
    assert.equal(res.headers['x-pdf-pages'], '3');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body, '%PDF-1.7 fake 3');

    const doc = lastDoc();
    assert.equal(doc.scope, 'material');
    assert.equal(doc.layout, 'practice');
    assert.deepEqual(block(doc, 'words')!.rows.slice(0, 3).map((row) => row.note), ['复习时忘了 2 次', '笔记本 · 3 星', ''], 'lapses in the last 30 days, stars');
    assert.ok(doc.answers.length > 0);
  });

  test('settings.materialParts limits what a material shows', async () => {
    const account = await learner();
    await t.db.update(users).set({ settings: { materialParts: ['words', 'story'] } }).where(eq(users.id, account.userId));
    await seedMaterial(account.userId, 'daily', '2026-11-16', prototypeDaily('2026-11-16'));
    assert.equal((await post(account, { scope: 'material', materials: [{ kind: 'daily', date: '2026-11-16' }], layout: 'read' })).statusCode, 200);
    assert.deepEqual(lastDoc().sections[0]!.blocks.map((b) => b.kind), ['words', 'story', 'mistakes']);
    assert.deepEqual(block(lastDoc(), 'words')!.rows.map((row) => row.term).slice(-1), ['solve'], 'no phrases');
  });

  test('a collection of daily, digest and extension; cards; 404 for a missing or foreign material', async () => {
    const account = await learner();
    const other = await learner();
    await seedMaterial(account.userId, 'daily', '2026-11-16', prototypeDaily('2026-11-16'));
    await seedMaterial(account.userId, 'digest', '2026-11-15', prototypeDigest('2026-11-15'));
    await seedMaterial(account.userId, 'extend', '2026-11-16', prototypeExtend());
    await seedMaterial(other.userId, 'daily', '2026-11-14', prototypeDaily('2026-11-14'));

    const refs = [
      { kind: 'extend', date: '2026-11-16' },
      { kind: 'daily', date: '2026-11-16' },
      { kind: 'digest', date: '2026-11-15' },
    ];
    const res = await post(account, { scope: 'material', materials: refs });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('学习资料合集_1115-1116.pdf')}`);
    assert.deepEqual(lastDoc().sections.map((s) => s.kicker.split(' · ')[0]), ['拓展资料', '每日资料', '7 天合集'], 'request order');

    const cardsRes = await post(account, { scope: 'cards', materials: refs.slice(0, 2), ipa: false });
    assert.equal(cardsRes.statusCode, 200);
    assert.equal(cardsRes.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('单词卡_1116.pdf')}`);
    assert.equal(lastDoc().cards.length, 14);
    assert.ok(lastDoc().cards.every((card) => card.ipa === ''));

    const rendered = renderer.docs.length;
    for (const materials of [[{ kind: 'daily', date: '2026-11-13' }], [{ kind: 'daily', date: '2026-11-14' }], [refs[1], { kind: 'extend', date: '2026-11-15' }]]) {
      const missing = await post(account, { scope: 'material', materials });
      assert.equal(missing.statusCode, 404, JSON.stringify(materials));
      assert.equal(missing.json().error.code, 'NOT_FOUND');
    }
    assert.equal(renderer.docs.length, rendered, 'nothing rendered for a 404');
  });

  test('checklist without materials: due today and forgotten ≥ 2 times in 30 days, words and phrases only, ≤ 24', async () => {
    const account = await learner();
    const other = await learner();
    const now = clock().getTime();
    const seed = async (
      userId: string,
      display: string,
      { type = 'word', state = 2, due = now, lapses = [], suspended = false, mastered = false }: {
        type?: 'word' | 'phrase' | 'grammar';
        state?: number;
        due?: number;
        lapses?: number[];
        suspended?: boolean;
        mastered?: boolean;
      } = {},
    ) => {
      const item = await seedItem(t.db, userId, { type, display });
      await t.db.update(cards).set({ state, due: new Date(due), suspended, mastered }).where(inArray(cards.id, item.cardIds));
      for (const daysAgo of lapses) {
        await seedLog(t.db, userId, { cardId: item.cardIds[0]!, rating: 1, reviewedAt: new Date(now - daysAgo * DAY_MS) });
      }
    };
    // Local day 2026-11-17 (+08:00) ends at 2026-11-17T16:00Z; now is 02:00Z.
    await seed(account.userId, 'alpha', { due: now - DAY_MS });
    await seed(account.userId, 'beta', { state: 0 });
    await seed(account.userId, 'gamma', { due: now + 7 * DAY_MS, lapses: [3, 10] });
    await seed(account.userId, 'delta', { due: now + 7 * DAY_MS, lapses: [3] });
    await seed(account.userId, 'on the fence', { type: 'phrase', due: now + 6 * 3_600_000 });
    await seed(account.userId, 'zeta', { suspended: true });
    await seed(account.userId, 'eta', { mastered: true });
    await seed(account.userId, 'tense', { type: 'grammar' });
    await seed(account.userId, 'theta', { due: now + 7 * DAY_MS, lapses: [40, 41, 42] });
    await seed(account.userId, 'iota', { due: now + 15 * 3_600_000 });
    await seed(other.userId, 'kappa', { due: now - DAY_MS, lapses: [1, 2] });

    const res = await post(account, { scope: 'checklist' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('自测清单_1117.pdf')}`);
    assert.deepEqual(lastDoc().checklist.rows.map((row) => row.term), ['gamma', 'alpha', 'on the fence']);
    assert.equal(lastDoc().checklist.rows[0]!.ipa, '/gamma/');
    assert.equal(lastDoc().checklist.rows[0]!.gloss, 'adj. gamma 的释义');

    // utcOffsetMinutes moves "today": at UTC-8 it is still 2026-11-16 there, whose end is before iota's due.
    assert.equal((await post(account, { scope: 'checklist', utcOffsetMinutes: -480 })).headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('自测清单_1116.pdf')}`);

    const many = await learner();
    for (let i = 0; i < 26; i += 1) await seed(many.userId, `word${String(i).padStart(2, '0')}`, { due: now - (i + 1) * 60_000 });
    await post(many, { scope: 'checklist' });
    assert.equal(lastDoc().checklist.rows.length, 24);

    const none = await learner();
    assert.equal((await post(none, { scope: 'checklist' })).statusCode, 200);
    assert.equal(lastDoc().checklist.rows.length, 0);
    assert.notEqual(lastDoc().empty, '');
  });

  test('renderer outcomes: > 40 pages → 422, failure → 502, not installed → 503', async () => {
    const account = await learner();
    await seedMaterial(account.userId, 'daily', '2026-11-16', prototypeDaily('2026-11-16'));
    const body = { scope: 'material', materials: [{ kind: 'daily', date: '2026-11-16' }] };
    try {
      renderer.next = async () => fakePdf(40);
      assert.equal((await post(account, body)).statusCode, 200);
      renderer.next = async () => fakePdf(41);
      const tooMany = await post(account, body);
      assert.equal(tooMany.statusCode, 422);
      assert.deepEqual(tooMany.json().error.details, { pages: 41 });
      assert.equal(tooMany.json().error.code, 'TOO_MANY_PAGES');

      renderer.next = async () => {
        throw new RenderFailedError('timeout');
      };
      const failed = await post(account, body);
      assert.equal(failed.statusCode, 502);
      assert.equal(failed.json().error.code, 'EXPORT_FAILED');

      renderer.next = async () => {
        throw new RendererUnavailableError('typst is not installed');
      };
      const unavailable = await post(account, body);
      assert.equal(unavailable.statusCode, 503);
      assert.equal(unavailable.json().error.code, 'EXPORT_UNAVAILABLE');
    } finally {
      renderer.next = async () => fakePdf(3);
    }
  });

  test('10 exports per account per hour', async () => {
    const account = await learner();
    const other = await learner();
    for (let i = 0; i < 10; i += 1) assert.equal((await post(account, { scope: 'checklist' })).statusCode, 200, `export ${i + 1}`);
    const limited = await post(account, { scope: 'checklist' });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) > 3000);
    assert.equal((await post(other, { scope: 'checklist' })).statusCode, 200, 'per account');
    clock.advance(3_600_001);
    assert.equal((await post(account, { scope: 'checklist' })).statusCode, 200, 'an hour later');
  });

  test('logs carry outcome, pages and timings, never content', async () => {
    const text = logs.text();
    assert.match(text, /"msg":"pdf export"/);
    assert.match(text, /"outcome":"ok"/);
    assert.match(text, /"pages":3/);
    assert.match(text, /"outcome":"too_many_pages"/);
    for (const secret of ['mitigate', 'Quiet Monday', '团队', 'gamma', 'circle back', '学习资料']) {
      assert.ok(!text.includes(secret), `log leaks ${secret}`);
    }
  });
});

describe('POST /v1/exports/pdf through the app', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test('without Typst installed → 503 EXPORT_UNAVAILABLE', async () => {
    const app = await buildTestApp(t.db, { config: testConfig({ TYPST_BIN: '/nonexistent/typst', TYPST_FONT_PATH: '/nonexistent/fonts' }) });
    try {
      const account = await createLearner(t.db, { now: new Date() });
      const res = await app.inject({ method: 'POST', url: URL_PDF, headers: account.headers, payload: { scope: 'checklist' } });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error.code, 'EXPORT_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });

  test('end to end with Typst: a real PDF whose X-Pdf-Pages matches its pages', { skip: skipWithoutTypst }, async () => {
    const clock = fixedClock();
    const app = await buildTestApp(t.db, { clock, config: testConfig({ TYPST_BIN, TYPST_FONT_PATH }) });
    try {
      const account = await createLearner(t.db, { now: clock() });
      await insertMaterial(t, account.userId, 'daily', '2026-11-16', prototypeDaily('2026-11-16'));
      for (const [scope, pages] of [['material', 3], ['cards', 2], ['checklist', 1]] as const) {
        const res = await app.inject({ method: 'POST', url: URL_PDF, headers: account.headers, payload: { scope, materials: [{ kind: 'daily', date: '2026-11-16' }] } });
        assert.equal(res.statusCode, 200, res.body);
        const pdf = res.rawPayload;
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
        assert.equal(countPdfPages(pdf), pages, scope);
        assert.equal(res.headers['x-pdf-pages'], String(pages));
      }
    } finally {
      await app.close();
    }
  });
});
