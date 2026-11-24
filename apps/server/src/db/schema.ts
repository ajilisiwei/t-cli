import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
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
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    uniqueIndex('entries_user_seq_idx').on(t.userId, t.seq),
    // v2 record page: per-day counts and the `date` filter (docs/api-v1.md, "v2").
    index('entries_user_created_idx').on(t.userId, t.createdAt),
    // v2 record search `q` (pg_trgm, created by migration 0001).
    index('entries_input_trgm_idx').using('gin', sql`${t.input} gin_trgm_ops`),
  ],
);

/** Daily AI request counter per account (quota enforcement). */
export const aiUsage = pgTable(
  'ai_usage',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    day: date({ mode: 'string' }).notNull(),
    requests: integer().notNull().default(0),
    /** Interactive (AI proxy) tokens, prompt + completion, for the daily token budget. */
    tokens: integer().notNull().default(0),
    /** Nightly pipeline tokens spent on this account (reported, budgeted per run). */
    pipelineTokens: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

// ---------------------------------------------------------------------------
// M3–M5: learning units, cards, reviews, materials (docs/api-v1.md, "Learning").
// Every table carries user_id and every query must filter on it.
// ---------------------------------------------------------------------------

/**
 * A learning unit ("Item") extracted from raw records or saved as a note: a
 * word, a phrase (reusable sentence pattern), a grammar point or (v2) a
 * sentence. One row per (user, type, normKey); each further source record
 * bumps lookupCount. `content` is the AI-generated detail, shaped per type
 * (see the contract); a sentence's content is the note's text and
 * translation, without AI.
 */
export const items = pgTable(
  'items',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    id: text().notNull(),
    type: text({ enum: ['word', 'phrase', 'grammar', 'sentence'] }).notNull(),
    /** Dedup key: lowercased lemma / normalized phrase / grammar rule slug / SHA-256 of a normalized sentence. */
    normKey: text().notNull(),
    /** What lists show: the headword, the phrase, or the grammar point's title. */
    display: text().notNull(),
    content: jsonb().$type<Record<string, unknown>>(),
    status: text({ enum: ['pending', 'ready', 'needs_regen'] }).notNull().default('pending'),
    lookupCount: integer().notNull().default(0),
    /** Source records that were grammar checks (mistakes) — weighs the item up. */
    errorCount: integer().notNull().default(0),
    /**
     * Importance (v2): the highest `stars` of the account's notes on this item
     * that are not deleted, 0 when there is none. Updated in the same
     * transaction as the note; drives the review retention and new-card order.
     */
    stars: smallint().notNull().default(0),
    firstSeenAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull(),
    model: text(),
    version: integer().notNull().default(1),
    ...timestamps,
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    uniqueIndex('items_user_type_key_idx').on(t.userId, t.type, t.normKey),
    // Fuzzy search in 词库 (pg_trgm; the extension is created by the migration).
    index('items_display_trgm_idx').using('gin', sql`${t.display} gin_trgm_ops`),
  ],
);

/** Which raw records produced an item (an entry can produce several items). */
export const itemSources = pgTable(
  'item_sources',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    itemId: text().notNull(),
    entryId: text().notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemId, t.entryId] }), index('item_sources_entry_idx').on(t.userId, t.entryId)],
);

/**
 * A review card generated from an item. The FSRS columns are the card's
 * current state; it is always re-derived by replaying review_logs in
 * reviewed_at order (FSRS is deterministic), so two devices reviewing
 * offline never overwrite each other.
 */
export const cards = pgTable(
  'cards',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    id: text().notNull(),
    itemId: text().notNull(),
    /** `recall` (v2): a sentence card, translation on the front, the sentence on the back. */
    cardType: text({ enum: ['recognize', 'produce', 'cloze', 'fix', 'dictation', 'recall'] }).notNull(),
    front: jsonb().$type<Record<string, unknown>>().notNull(),
    back: jsonb().$type<Record<string, unknown>>().notNull(),
    /** FSRS state: 0 new, 1 learning, 2 review, 3 relearning. */
    state: smallint().notNull().default(0),
    due: timestamp({ withTimezone: true }).notNull(),
    stability: doublePrecision().notNull().default(0),
    difficulty: doublePrecision().notNull().default(0),
    elapsedDays: integer().notNull().default(0),
    scheduledDays: integer().notNull().default(0),
    reps: integer().notNull().default(0),
    lapses: integer().notNull().default(0),
    lastReview: timestamp({ withTimezone: true }),
    /** Interval passed MASTERED_DAYS: out of the queue ("已掌握"). */
    mastered: boolean().notNull().default(false),
    /** Reported as wrong ("内容有误") and waiting for regeneration: out of the queue. */
    suspended: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('cards_user_due_idx').on(t.userId, t.due),
    index('cards_user_item_idx').on(t.userId, t.itemId),
  ],
);

/** One rating. Append-only (undo within the grace window deletes it). Client ULID ids make pushes idempotent. */
export const reviewLogs = pgTable(
  'review_logs',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    id: text().notNull(),
    cardId: text().notNull(),
    /** 1 again (忘记), 2 hard (困难), 3 good (记得), 4 easy (简单). */
    rating: smallint().notNull(),
    reviewedAt: timestamp({ withTimezone: true }).notNull(),
    durationMs: integer(),
    deviceId: text(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] }), index('review_logs_user_card_idx').on(t.userId, t.cardId, t.reviewedAt)],
);

/** AI-written reading material: one daily per local date, one weekly per week (date = the week's Monday). */
export const materials = pgTable(
  'materials',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['daily', 'weekly'] }).notNull(),
    date: date({ mode: 'string' }).notNull(),
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    model: text(),
    version: integer().notNull().default(1),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.date] })],
);

/** Per-account pipeline cursor: entries with seq > lastSeq have not been processed yet. */
export const pipelineState = pgTable('pipeline_state', {
  userId: text().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  lastSeq: bigint({ mode: 'number' }).notNull().default(0),
  lastRunAt: timestamp({ withTimezone: true }),
  lastError: text(),
});

/** One-time WeChat subscribe-message grants (每次用户同意 = 可发 1 条). */
export const notifyGrants = pgTable(
  'notify_grants',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    templateId: text().notNull(),
    available: integer().notNull().default(0),
    lastSentAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.templateId] })],
);

/** Scheduler bookkeeping: a job runs at most once per run key (e.g. its local date) across restarts. */
export const jobRuns = pgTable('job_runs', {
  name: text().primaryKey(),
  lastRunKey: text(),
  lastRunAt: timestamp({ withTimezone: true }),
  lastError: text(),
});

// ---------------------------------------------------------------------------
// v2: notes (the notebook) and the shared lexicon cache (docs/api-v1.md, "v2").
// ---------------------------------------------------------------------------

/**
 * A note: a word, phrase or sentence the user saved, with an importance of
 * 1–4 stars. The id is a client ULID, so a repeated PUT never creates a
 * second row. Deleting is soft (`deletedAt`) so incremental sync can carry it.
 *
 * `seq` orders the account's note changes for `GET /v1/notes/changes`: every
 * write (create, update, delete) assigns the note a new seq, allocated as
 * max(seq) + 1 while holding the account row's lock (as entries do), so seq
 * order equals commit order and an `after` cursor never skips a change.
 * `entryId` is the record it was saved from, kept as sent (the record may not
 * have been pushed yet); `itemId` the learning unit it feeds.
 */
export const notes = pgTable(
  'notes',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    id: text().notNull(),
    kind: text({ enum: ['word', 'phrase', 'sentence'] }).notNull(),
    /** The learning-language side (English), whichever side the user typed. */
    text: text().notNull(),
    /** The other side (the explanation language); null when unknown. */
    translation: text(),
    /** BCP 47 code of `text`; only `en` in v2. */
    lang: text().notNull(),
    /** 1–4. */
    stars: smallint().notNull(),
    /** Word and phrase notes: the lexicon lemma `POST /v1/lookup` returned. */
    lemma: text(),
    entryId: text(),
    itemId: text(),
    seq: bigint({ mode: 'number' }).notNull(),
    ...timestamps,
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    // Incremental sync (`after` cursor) and the next seq (max + 1).
    uniqueIndex('notes_user_seq_idx').on(t.userId, t.seq),
    // The notebook list: newest first (ULID order) within a kind, live notes only.
    index('notes_user_kind_idx').on(t.userId, t.kind, t.id).where(sql`deleted_at is null`),
    // Recomputing items.stars from the notes of one item.
    index('notes_user_item_idx').on(t.userId, t.itemId),
  ],
);

/**
 * Shared word-detail cache (lexicon entries, the "LexiconEntry" JSON of the
 * contract). Deliberately NOT per user — the one exception to "every table
 * carries user_id": it holds no user id and no user sentence, only a lemma
 * and AI-written dictionary content, so sharing it leaks nothing.
 * `lemma` is the normalized key (see modules/lookup/lexicon.ts); `version`
 * is the content format, so a format change never serves stale shapes.
 */
export const lexicon = pgTable(
  'lexicon',
  {
    /** Learning language of the lemma (BCP 47), `en` in v2. */
    lang: text().notNull(),
    /** Language of glosses and notes: the account's explanationLang (zh / en). */
    explainLang: text().notNull(),
    lemma: text().notNull(),
    version: integer().notNull(),
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    model: text(),
    /** Cache hits served (lookups that found this row), for the hit-rate metric. */
    hits: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.lang, t.explainLang, t.lemma, t.version] })],
);
