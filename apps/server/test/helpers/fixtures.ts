import { randomBytes } from 'node:crypto';
import { createEntry, type Entry } from '@t-cli/core/entry';
import { ulid } from '@t-cli/core/ulid';
import type { Database } from '../../src/db/client.ts';
import { devices, users } from '../../src/db/schema.ts';
import { signAccessToken, type Role } from '../../src/http/auth.ts';
import { TEST_JWT_SECRET } from './app.ts';

export interface TestAccount {
  userId: string;
  deviceId: string;
  role: Role;
  headers: { authorization: string };
}

/**
 * Insert a user with one device and return a valid Bearer header for it.
 * Bypasses the login flow on purpose: route tests other than auth's own
 * should not depend on WeChat login.
 */
export async function createAccount(
  db: Database,
  { role = 'member', kind = 'cli', now = new Date() }: { role?: Role; kind?: 'cli' | 'mp' | 'h5'; now?: Date } = {},
): Promise<TestAccount> {
  const userId = ulid();
  const deviceId = ulid();
  await db.insert(users).values({ id: userId, role });
  await db.insert(devices).values({
    id: deviceId,
    userId,
    kind,
    name: `test ${kind}`,
    refreshHash: randomBytes(32).toString('hex'),
    refreshExpiresAt: new Date(now.getTime() + 60 * 86_400_000),
  });
  const token = await signAccessToken(TEST_JWT_SECRET, { userId, deviceId, role }, { now, ttlSeconds: 900 });
  return { userId, deviceId, role, headers: { authorization: `Bearer ${token}` } };
}

let counter = 0;

/** A valid CLI entry; each call gets a distinct input and id. */
export function makeEntry(overrides: Partial<Parameters<typeof createEntry>[0]> = {}): Entry {
  counter += 1;
  return createEntry({
    source: 'cli',
    task: 'translate',
    input: `sample input ${counter}`,
    output: `sample output ${counter}`,
    mode: 'simple',
    srcLang: 'en',
    createdAt: new Date('2026-11-17T09:00:00+08:00'),
    ...overrides,
  });
}
