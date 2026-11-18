import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
};

/**
 * One person. `lastSeq` is the per-account sync counter: writers take this
 * row's lock to allocate `entries.seq`, so seq order equals commit order and
 * a cursor-based pull can never skip a row (see docs, section 6).
 */
export const users = pgTable('users', {
  id: text().primaryKey(),
  role: text({ enum: ['admin', 'member'] }).notNull().default('member'),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  lastSeq: bigint({ mode: 'number' }).notNull().default(0),
  ...timestamps,
  deletedAt: timestamp({ withTimezone: true }),
});

/** A way to log in. Only WeChat mini-program openids for now. */
export const identities = pgTable(
  'identities',
  {
    provider: text({ enum: ['wechat_mp'] }).notNull(),
    subject: text().notNull(),
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] }), index('identities_user_idx').on(t.userId)],
);

export const invites = pgTable('invites', {
  code: text().primaryKey(),
  createdBy: text().references(() => users.id, { onDelete: 'set null' }),
  usedBy: text().references(() => users.id, { onDelete: 'set null' }),
  usedAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  ...timestamps,
});

/**
 * A logged-in client (CLI, mini-program, H5). Holds the current refresh-token
 * hash and the previous one, so replaying an already-rotated token is
 * detectable and revokes the device.
 */
export const devices = pgTable(
  'devices',
  {
    id: text().primaryKey(),
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['cli', 'mp', 'h5'] }).notNull(),
    name: text().notNull(),
    refreshHash: text().notNull(),
    prevRefreshHash: text(),
    refreshExpiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    lastSeenAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);

/** CLI device-authorization requests (RFC 8628 style). */
export const deviceAuthRequests = pgTable(
  'device_auth_requests',
  {
    deviceCodeHash: text().primaryKey(),
    userCode: text().notNull(),
    deviceName: text().notNull(),
    status: text({ enum: ['pending', 'approved', 'denied', 'consumed'] }).notNull().default('pending'),
    userId: text().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    approvedAt: timestamp({ withTimezone: true }),
    lastPolledAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  // A user code only has to be unique among requests still waiting for approval.
  (t) => [uniqueIndex('device_auth_pending_user_code_idx').on(t.userCode).where(sql`status = 'pending'`)],
);

/**
 * Raw records (see @t-cli/core/entry). Immutable once written. `createdAt` is
 * the client's instant; `utcOffsetMinutes` keeps the client's local offset so
 * the original ISO string — and the user's local day — can be reconstructed.
 */
export const entries = pgTable(
  'entries',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    id: text().notNull(),
    seq: bigint({ mode: 'number' }).notNull(),
    source: text({ enum: ['cli', 'mp'] }).notNull(),
    task: text({ enum: ['translate', 'check'] }).notNull(),
    kind: text({ enum: ['word', 'sentence', 'paragraph'] }).notNull(),
    input: text().notNull(),
    output: text().notNull(),
    srcLang: text({ enum: ['zh', 'en', 'other'] }),
    mode: text({ enum: ['simple', 'detail'] }).notNull(),
    correctedInput: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    utcOffsetMinutes: smallint().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] }), uniqueIndex('entries_user_seq_idx').on(t.userId, t.seq)],
);

/** Daily AI request counter per account (quota enforcement). */
export const aiUsage = pgTable(
  'ai_usage',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    day: date({ mode: 'string' }).notNull(),
    requests: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);
