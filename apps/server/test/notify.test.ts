import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { insertEntries } from '../src/db/entriesRepo.ts';
import { identities, notifyGrants, users } from '../src/db/schema.ts';
import type { AppDeps } from '../src/deps.ts';
import { createScheduler } from '../src/lib/scheduler.ts';
import { fillReminderData, reminderConfig } from '../src/modules/notify/config.ts';
import { MAX_AVAILABLE_GRANTS } from '../src/modules/notify/grants.ts';
import {
  createWechatReminderSender,
  registerNotifyJobs,
  REMINDER_JOB,
  REMINDER_PAGE,
  ReminderSendError,
  runReminders,
  type ReminderMessage,
  type ReminderSender,
} from '../src/modules/notify/index.ts';
import {
  buildTestApp,
  fakeAlerter,
  fakeLlm,
  fakeRegenerator,
  fakeTts,
  fakeWechat,
  fixedClock,
  testConfig,
  type FakeAlerter,
  type TestClock,
} from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { makeEntry, type TestAccount } from './helpers/fixtures.ts';
import { createLearner, seedGrant, seedItem } from './helpers/learning.ts';

const TEMPLATE = 'tmpl-review-reminder';
const DATA = JSON.stringify({ thing1: '今天有 {due} 张卡片待复习', date2: '{date}' });
const REMINDER_ENV = { WECHAT_REMINDER_TEMPLATE_ID: TEMPLATE, WECHAT_REMINDER_DATA: DATA };
const LIMITS = { newPerDay: 15, reviewsPerDay: 60 };
const silentLog = { info: () => undefined, error: () => undefined };

interface FakeSender extends ReminderSender {
  sent: ReminderMessage[];
}

/** Records messages; `fail` decides per message whether (and how) WeChat refuses it. */
function fakeSender(fail: (message: ReminderMessage) => ReminderSendError | null = () => null): FakeSender {
  const sent: ReminderMessage[] = [];
  return {
    sent,
    async send(message) {
      const error = fail(message);
      if (error) throw error;
      sent.push(message);
    },
  };
}

describe('reminder configuration (pure)', () => {
  test('both variables set → a template and its fields; either unset → off', () => {
    assert.deepEqual(reminderConfig(testConfig(REMINDER_ENV)), { templateId: TEMPLATE, fields: { thing1: '今天有 {due} 张卡片待复习', date2: '{date}' } });
    assert.equal(reminderConfig(testConfig()), null);
    assert.equal(reminderConfig(testConfig({ WECHAT_REMINDER_TEMPLATE_ID: TEMPLATE })), null);
    assert.deepEqual(reminderConfig(testConfig({ ...REMINDER_ENV, WECHAT_REMINDER_DATA: '{"thing1":{"value":"{due}"}}' }))?.fields, { thing1: '{due}' });
  });

  test('malformed data fails loudly, naming the variable but never its value', () => {
    for (const data of ['not json', '[]', '{}', '{"thing1":1}', '{"bad key":"x"}']) {
      assert.throws(() => reminderConfig(testConfig({ ...REMINDER_ENV, WECHAT_REMINDER_DATA: data })), (error: Error) => {
        assert.match(error.message, /WECHAT_REMINDER_DATA/);
        assert.ok(!error.message.includes(data));
        return true;
      });
    }
  });

  test('placeholders are filled in every field', () => {
    assert.deepEqual(fillReminderData({ a: '{due} 张 · {due}', b: '{date}', c: 'plain' }, { due: 12, date: '2026-11-07' }), {
      a: { value: '12 张 · 12' },
      b: { value: '2026年11月7日' },
      c: { value: 'plain' },
    });
  });
});

describe('reminder routes: GET /v1/notify/config, POST /v1/notify/grant', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function appWith(ctx: TestContext, env: Record<string, string>) {
    const app = await buildTestApp(t.db, { config: testConfig(env) });
    ctx.after(() => app.close());
    return app;
  }

  test('config: the template when configured, null otherwise', async (ctx) => {
    const account = await createLearner(t.db, { now: new Date() });
    const on = await appWith(ctx, REMINDER_ENV);
    const off = await appWith(ctx, {});
    assert.deepEqual((await on.inject({ method: 'GET', url: '/v1/notify/config', headers: account.headers })).json().data, { reminderTemplateId: TEMPLATE });
    assert.deepEqual((await off.inject({ method: 'GET', url: '/v1/notify/config', headers: account.headers })).json().data, { reminderTemplateId: null });
    assert.equal((await on.inject({ method: 'GET', url: '/v1/notify/config' })).statusCode, 401);
  });

  test('grant: each accept adds one; another template (or reminders off) is 400', async (ctx) => {
    const app = await appWith(ctx, REMINDER_ENV);
    const off = await appWith(ctx, {});
    const account = await createLearner(t.db, { now: new Date() });
    const grant = (who: TestAccount, templateId: unknown, target = app) =>
      target.inject({ method: 'POST', url: '/v1/notify/grant', headers: who.headers, payload: { templateId } });

    assert.deepEqual((await grant(account, TEMPLATE)).json(), { success: true, data: { available: 1 }, error: null });
    assert.equal((await grant(account, TEMPLATE)).json().data.available, 2);
    for (const templateId of ['other-template', '', 42]) {
      const res = await grant(account, templateId);
      assert.equal(res.statusCode, 400, String(templateId));
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
    assert.equal((await grant(account, TEMPLATE, off)).statusCode, 400);
    const [row] = await t.db.select().from(notifyGrants).where(eq(notifyGrants.userId, account.userId));
    assert.equal(row?.available, 2);

    await t.db.update(notifyGrants).set({ available: MAX_AVAILABLE_GRANTS }).where(eq(notifyGrants.userId, account.userId));
    assert.equal((await grant(account, TEMPLATE)).json().data.available, MAX_AVAILABLE_GRANTS, 'capped');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/notify/grant', payload: { templateId: TEMPLATE } })).statusCode, 401);
  });
});

describe('reminder job', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  /** 20:00 at UTC+8 = 12:00Z = 07:00 at UTC-5. */
  const EVENING = new Date('2026-11-17T20:00:00+08:00');
  const reminder = reminderConfig(testConfig(REMINDER_ENV))!;
  let openidCounter = 0;

  /** An account with a WeChat identity, a reminder hour, records made at `offset`, cards due and `grants` grants. */
  async function reminderUser({
    hour,
    grants = 1,
    offset = '+08:00',
    cards = true,
    identity = true,
  }: { hour: number | null; grants?: number; offset?: string; cards?: boolean; identity?: boolean }): Promise<{ userId: string; openid: string }> {
    const account = await createLearner(t.db, { now: EVENING });
    openidCounter += 1;
    const openid = `openid-reminder-${openidCounter}`;
    if (identity) await t.db.insert(identities).values({ provider: 'wechat_mp', subject: openid, userId: account.userId });
    await t.db.update(users).set({ settings: hour === null ? {} : { reminderHour: hour } }).where(eq(users.id, account.userId));
    await insertEntries(t.db, account.userId, [{ ...makeEntry(), createdAt: `2026-11-16T09:00:00${offset}` }]);
    if (cards) await seedItem(t.db, account.userId, { type: 'word', display: `word ${openidCounter}` });
    if (grants > 0) await seedGrant(t.db, account.userId, TEMPLATE, grants);
    return { userId: account.userId, openid };
  }

  const grantOf = async (userId: string) =>
    (await t.db.select().from(notifyGrants).where(and(eq(notifyGrants.userId, userId), eq(notifyGrants.templateId, TEMPLATE))))[0];

  const run = (sender: ReminderSender, alerter: FakeAlerter, now = EVENING) => runReminders({ db: t.db, alerter }, { sender, reminder, limits: LIMITS, now });

  test('sends one message to accounts whose local hour it is, with cards due and a grant; consumes the grant', async () => {
    const due = await reminderUser({ hour: 20 });
    const utcMinus5 = await reminderUser({ hour: 7, offset: '-05:00' });
    // None of these get one: no grant, another hour, nothing due, no hour set, no WeChat identity, deleted.
    await reminderUser({ hour: 20, grants: 0 });
    await reminderUser({ hour: 21 });
    const nothingDue = await reminderUser({ hour: 20, cards: false });
    await reminderUser({ hour: null });
    await reminderUser({ hour: 20, identity: false });
    const deleted = await reminderUser({ hour: 20 });
    await t.db.update(users).set({ deletedAt: EVENING }).where(eq(users.id, deleted.userId));

    const sender = fakeSender();
    const alerter = fakeAlerter();
    const result = await run(sender, alerter);
    const mine = sender.sent.filter((m) => m.openid.startsWith('openid-reminder-'));
    assert.deepEqual(mine.map((m) => m.openid).sort(), [due.openid, utcMinus5.openid].sort());
    const message = mine.find((m) => m.openid === due.openid)!;
    assert.deepEqual(message, {
      openid: due.openid,
      templateId: TEMPLATE,
      page: REMINDER_PAGE,
      data: { thing1: { value: '今天有 3 张卡片待复习' }, date2: { value: '2026年11月17日' } },
    });
    assert.equal(mine.find((m) => m.openid === utcMinus5.openid)?.data.date2?.value, '2026年11月17日');
    assert.equal(result.sent, 2);
    assert.equal(alerter.alerts.length, 0);

    assert.equal((await grantOf(due.userId))?.available, 0);
    assert.equal((await grantOf(due.userId))?.lastSentAt?.toISOString(), EVENING.toISOString());
    assert.equal((await grantOf(nothingDue.userId))?.available, 1, 'nothing due: the grant is kept');

    // The same hour again (or a restart): nothing more is sent.
    const again = fakeSender();
    await t.db.update(notifyGrants).set({ available: 5 }).where(and(eq(notifyGrants.userId, due.userId), eq(notifyGrants.templateId, TEMPLATE)));
    await run(again, alerter, new Date(EVENING.getTime() + 30 * 60_000));
    assert.equal(again.sent.filter((m) => m.openid === due.openid).length, 0, 'at most one reminder a day');
    await run(again, alerter, new Date(EVENING.getTime() + 86_400_000));
    assert.equal(again.sent.filter((m) => m.openid === due.openid).length, 1, 'the next day it is sent again');
  });

  test('a failed send gives the grant back and raises one reminder_failed alert without user data', async () => {
    const failing = await reminderUser({ hour: 20 });
    const refused = await reminderUser({ hour: 20, grants: 3 });
    const sender = fakeSender((message) => {
      if (message.openid === failing.openid) return new ReminderSendError('WeChat rejected the subscribe message', 40003);
      if (message.openid === refused.openid) return new ReminderSendError('WeChat rejected the subscribe message', 43101);
      return null;
    });
    const alerter = fakeAlerter();
    const result = await run(sender, alerter, new Date(EVENING.getTime() + 2 * 86_400_000));
    assert.ok(result.failed >= 1);
    assert.equal((await grantOf(failing.userId))?.available, 1, 'given back');
    assert.equal((await grantOf(failing.userId))?.lastSentAt, null);
    assert.equal((await grantOf(refused.userId))?.available, 0, 'WeChat says none left: reset');
    assert.equal(alerter.alerts.length, 1);
    assert.equal(alerter.alerts[0]?.kind, 'reminder_failed');
    assert.match(alerter.alerts[0]!.message, /errcode 40003/);
    assert.ok(!alerter.alerts[0]!.message.includes('openid'));
    assert.ok(!alerter.alerts[0]!.message.includes(failing.userId));
  });

  test('the hourly job is registered only when reminders are configured, and runs on the hour', async () => {
    const build = (env: Record<string, string>, clock: TestClock, alerter: FakeAlerter): AppDeps => ({
      config: testConfig(env),
      db: t.db,
      clock,
      wechat: fakeWechat(),
      llm: fakeLlm(),
      tts: fakeTts(),
      regenerator: fakeRegenerator(),
      alerter,
    });
    const clock = fixedClock(new Date('2026-11-25T19:59:00+08:00'));
    const alerter = fakeAlerter();

    const off = createScheduler({ db: t.db, clock, log: silentLog, alerter });
    registerNotifyJobs(off, build({}, clock, alerter), fakeSender());
    assert.equal(await off.runNow(REMINDER_JOB), 'unknown');

    const user = await reminderUser({ hour: 20 });
    const sender = fakeSender();
    const on = createScheduler({ db: t.db, clock, log: silentLog, alerter });
    registerNotifyJobs(on, build(REMINDER_ENV, clock, alerter), sender);
    await on.tick();
    clock.set(new Date('2026-11-25T20:00:10+08:00'));
    await on.tick();
    assert.equal(sender.sent.filter((m) => m.openid === user.openid).length, 1);
    await on.tick();
    assert.equal(sender.sent.filter((m) => m.openid === user.openid).length, 1, 'once per hour');
  });
});

describe('WeChat reminder sender (fake fetch)', () => {
  const SECRET = 'app-secret-must-not-leak';
  const config = testConfig({ WECHAT_APPID: 'wx-app-id', WECHAT_SECRET: SECRET });
  const message: ReminderMessage = { openid: 'openid-x', templateId: TEMPLATE, page: REMINDER_PAGE, data: { thing1: { value: '3' } } };

  interface Call {
    url: string;
    body: Record<string, unknown>;
  }

  function fakeFetch(handler: (call: Call, index: number) => unknown): { fetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      calls.push(call);
      return new Response(JSON.stringify(handler(call, calls.length - 1)), { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    return { fetch: impl, calls };
  }

  const tokenReply = (token: string) => ({ access_token: token, expires_in: 7200 });
  const isToken = (call: Call) => call.url === 'https://api.weixin.qq.com/cgi-bin/stable_token';

  test('the secret goes only in the stable_token body; the token is cached until shortly before expiry', async () => {
    const clock = fixedClock();
    let tokens = 0;
    const { fetch, calls } = fakeFetch((call) => (isToken(call) ? tokenReply(`token-${++tokens}`) : { errcode: 0, errmsg: 'ok' }));
    const sender = createWechatReminderSender(config, { fetch, clock });
    await sender.send(message);
    await sender.send(message);
    assert.equal(calls.filter(isToken).length, 1, 'cached');
    assert.deepEqual(calls[0]?.body, { grant_type: 'client_credential', appid: 'wx-app-id', secret: SECRET, force_refresh: false });
    for (const call of calls) assert.ok(!call.url.includes(SECRET), 'never in a URL');
    const send = calls[1]!;
    assert.equal(send.url, 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=token-1');
    assert.deepEqual(send.body, { touser: 'openid-x', template_id: TEMPLATE, page: REMINDER_PAGE, data: { thing1: { value: '3' } }, lang: 'zh_CN' });

    clock.advance(7200 * 1000 - 4 * 60_000);
    await sender.send(message);
    assert.equal(calls.filter(isToken).length, 2, 'refreshed 5 minutes before expiry');
    assert.ok(calls.at(-1)?.url.endsWith('access_token=token-2'));
  });

  test('a revoked token is replaced once; WeChat errors surface as errcodes without secrets', async () => {
    let tokens = 0;
    let sends = 0;
    const { fetch, calls } = fakeFetch((call) => {
      if (isToken(call)) return tokenReply(`token-${++tokens}`);
      sends += 1;
      return sends === 1 ? { errcode: 40001, errmsg: 'invalid credential' } : { errcode: 43101, errmsg: 'user refuse to accept the msg' };
    });
    const sender = createWechatReminderSender(config, { fetch });
    await assert.rejects(sender.send(message), (error: unknown) => {
      assert.ok(error instanceof ReminderSendError);
      assert.equal(error.errcode, 43101);
      assert.ok(!error.message.includes(SECRET) && !error.message.includes('token-'));
      return true;
    });
    assert.equal(calls.filter(isToken).length, 2);
    assert.equal(sends, 2);

    const down = createWechatReminderSender(config, { fetch: (async () => { throw new Error(`connect ECONNREFUSED ${SECRET}`); }) as typeof fetch });
    await assert.rejects(down.send(message), (error: unknown) => error instanceof ReminderSendError && !error.message.includes(SECRET));
    const unconfigured = createWechatReminderSender(testConfig(), { fetch });
    await assert.rejects(unconfigured.send(message), /credentials are not configured/);
  });
});
