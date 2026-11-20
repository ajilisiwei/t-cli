import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ulid } from '@t-cli/core/ulid';
import type { Database } from '../../src/db/client.ts';
import { cards, devices, items, itemSources, materials, notifyGrants, reviewLogs } from '../../src/db/schema.ts';
import { signAccessToken } from '../../src/http/auth.ts';
import { TEST_JWT_SECRET, type TestClock } from './app.ts';
import { createAccount, type TestAccount } from './fixtures.ts';

/**
 * Seed learning data straight into the database. The nightly pipeline that
 * normally creates items, cards and materials is a separate module; these
 * helpers produce rows of the same shapes (docs/api-v1.md, "Content shapes").
 */

/**
 * An account whose access token stays valid for a year, so tests can move
 * the clock across days and weeks without re-authenticating.
 */
export async function createLearner(db: Database, { now, kind = 'mp' }: { now: Date; kind?: 'cli' | 'mp' | 'h5' }): Promise<TestAccount> {
  const account = await createAccount(db, { kind, now });
  const token = await signAccessToken(TEST_JWT_SECRET, account, { now, ttlSeconds: 366 * 86_400 });
  return { ...account, headers: { authorization: `Bearer ${token}` } };
}

/** Another device (CLI by default) of the same account, with its own long-lived token. */
export async function addDevice(db: Database, account: TestAccount, { now, kind = 'cli' }: { now: Date; kind?: 'cli' | 'mp' | 'h5' }): Promise<TestAccount> {
  const deviceId = ulid();
  await db.insert(devices).values({
    id: deviceId,
    userId: account.userId,
    kind,
    name: `second ${kind}`,
    refreshHash: randomBytes(32).toString('hex'),
    refreshExpiresAt: new Date(now.getTime() + 60 * 86_400_000),
  });
  const token = await signAccessToken(TEST_JWT_SECRET, { userId: account.userId, deviceId, role: account.role }, { now, ttlSeconds: 366 * 86_400 });
  return { ...account, deviceId, headers: { authorization: `Bearer ${token}` } };
}

export type ItemType = 'word' | 'phrase' | 'grammar';
export type CardType = 'recognize' | 'produce' | 'cloze' | 'fix';

export const wordContent = (headword: string) => ({
  headword,
  ipa: `/${headword}/`,
  meanings: [{ pos: 'adj.', zh: `${headword} 的释义` }],
  examples: [
    { en: `A ${headword} example.`, zh: '一个例句。', fromUser: false },
    { en: `My own ${headword} sentence.`, zh: '我自己的句子。', fromUser: true },
  ],
  collocations: [`${headword} attention`],
  synonyms: [{ word: 'careful', note: '语气更弱' }],
  family: [`${headword}ly`],
});

export const phraseContent = (phrase: string) => ({
  phrase,
  zh: '左右为难',
  register: 'casual',
  alternatives: [
    { en: "can't decide between A and B", note: '更直白' },
    { en: 'be caught between A and B', note: '书面一些' },
  ],
  examples: [{ en: `I am ${phrase} two jobs.`, zh: '我在两份工作之间左右为难。', fromUser: false }],
});

export const grammarContent = (title: string) => ({
  title,
  rule: 'look forward to + 名词 / 动名词',
  wrong: 'I look forward to hear from you.',
  right: 'I look forward to hearing from you.',
  exercises: [
    { wrong: 'I look forward to see you.', right: 'I look forward to seeing you.' },
    { wrong: 'She looks forward to meet him.', right: 'She looks forward to meeting him.' },
    { wrong: 'We look forward to work with you.', right: 'We look forward to working with you.' },
  ],
});

/** Card faces per the contract's table, for the content above. */
export function facesFor(type: ItemType, cardType: CardType, display: string): { front: Record<string, unknown>; back: Record<string, unknown> } {
  if (type === 'word') {
    const content = wordContent(display);
    if (cardType === 'recognize') return { front: { text: display, ipa: content.ipa }, back: { text: 'adj. 释义', example: { en: content.examples[0]!.en, zh: content.examples[0]!.zh } } };
    if (cardType === 'produce') return { front: { text: 'adj. 释义' }, back: { text: display, ipa: content.ipa } };
    return { front: { text: `A ____ example.`, sub: '一个例句。' }, back: { text: `A ${display} example.`, sub: display } };
  }
  if (type === 'phrase') return { front: { text: 'I am ____ two jobs.', sub: '我在两份工作之间左右为难。' }, back: { text: `I am ${display} two jobs.`, sub: display } };
  const content = grammarContent(display);
  return { front: { text: content.wrong }, back: { text: content.right, sub: content.rule } };
}

const CARD_TYPES: Record<ItemType, CardType[]> = { word: ['recognize', 'produce', 'cloze'], phrase: ['cloze'], grammar: ['fix'] };
const CONTENT: Record<ItemType, (display: string) => Record<string, unknown>> = { word: wordContent, phrase: phraseContent, grammar: grammarContent };

export interface SeededItem {
  itemId: string;
  cardIds: string[];
}

/** An item with its content and its cards (all new, due at `createdAt`). */
export async function seedItem(
  db: Database,
  userId: string,
  {
    type = 'word',
    display,
    lookupCount = 1,
    errorCount = 0,
    status = 'ready',
    content,
    createdAt = new Date('2026-11-16T21:00:00Z'),
    lastSeenAt = createdAt,
    withCards = true,
  }: {
    type?: ItemType;
    display: string;
    lookupCount?: number;
    errorCount?: number;
    status?: 'pending' | 'ready' | 'needs_regen';
    content?: Record<string, unknown> | null;
    createdAt?: Date;
    lastSeenAt?: Date;
    withCards?: boolean;
  },
): Promise<SeededItem> {
  const itemId = ulid();
  await db.insert(items).values({
    userId,
    id: itemId,
    type,
    normKey: display.toLowerCase(),
    display,
    content: content === undefined ? CONTENT[type](display) : content,
    status,
    lookupCount,
    errorCount,
    firstSeenAt: createdAt,
    lastSeenAt,
    createdAt,
    updatedAt: createdAt,
  });
  const cardIds: string[] = [];
  if (withCards) {
    for (const cardType of CARD_TYPES[type]) {
      const id = ulid();
      cardIds.push(id);
      await db.insert(cards).values({ userId, id, itemId, cardType, ...facesFor(type, cardType, display), due: createdAt, createdAt });
    }
  }
  return { itemId, cardIds };
}

/** Insert a review log row as is (no replay; use `rate` to go through the API). */
export async function seedLog(
  db: Database,
  userId: string,
  { cardId, rating, reviewedAt, createdAt = reviewedAt }: { cardId: string; rating: number; reviewedAt: Date; createdAt?: Date },
): Promise<string> {
  const id = ulid({ time: reviewedAt.getTime() });
  await db.insert(reviewLogs).values({ userId, id, cardId, rating, reviewedAt, createdAt });
  return id;
}

export async function seedSource(db: Database, userId: string, itemId: string, entryId: string): Promise<void> {
  await db.insert(itemSources).values({ userId, itemId, entryId });
}

export async function seedMaterial(
  db: Database,
  userId: string,
  { kind = 'daily', date, content, createdAt = new Date(`${date}T22:00:00Z`) }: { kind?: 'daily' | 'weekly'; date: string; content: Record<string, unknown>; createdAt?: Date },
): Promise<void> {
  await db.insert(materials).values({ userId, kind, date, content, createdAt });
}

export async function seedGrant(db: Database, userId: string, templateId: string, available: number): Promise<void> {
  await db.insert(notifyGrants).values({ userId, templateId, available });
}

/** A daily material with a story. */
export function dailyMaterial(date: string, story: string | null = 'Tom kept meticulous notes every day.'): Record<string, unknown> {
  return {
    date,
    overview: { newWords: 1, newPhrases: 0, corrections: 0, streakDays: 3 },
    words: [],
    phrases: [],
    grammar: [],
    story: story === null ? null : { title: 'Notes', text: story, words: ['meticulous'], zh: '汤姆每天都仔细记笔记。' },
    mistakes: [],
  };
}

/** Rate `cardId` through the API at the clock's current time. */
export async function rate(
  app: FastifyInstance,
  account: TestAccount,
  clock: TestClock,
  cardId: string,
  rating: 1 | 2 | 3 | 4,
): Promise<{ id: string; state: string; due: string; mastered: boolean }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/reviews',
    headers: account.headers,
    payload: { logs: [{ id: ulid({ time: clock().getTime() }), cardId, rating, reviewedAt: clock().toISOString() }] },
  });
  if (res.statusCode !== 200) throw new Error(`rate failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { data: { cards: { id: string; state: string; due: string; mastered: boolean }[]; rejected: unknown[] } };
  const card = body.data.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`rate: card not returned (${JSON.stringify(body.data.rejected)})`);
  return card;
}
