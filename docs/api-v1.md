# t-cli sync service — API v1 contract

Single source of truth for the server (`apps/server`), the CLI sync client
(`apps/cli`) and the mini-program (M2). Change this file first, then the code.

## Conventions

- Base URL: configured per client (CLI: `TCLI_SERVER_URL` env or `serverUrl` in `~/.config/t-cli/config.json`).
- JSON endpoints answer with an envelope:
  - success: `{ "success": true, "data": <T>, "error": null }`
  - failure: `{ "success": false, "data": null, "error": { "code": "<CODE>", "message": "...", "details"?: ... } }`
- Clients branch on `error.code`, never on `message`.
- Authenticated endpoints need `Authorization: Bearer <accessToken>`. A missing, invalid or expired token — or the token of a revoked device or a deleted account, checked on every request — yields `401 UNAUTHORIZED`; the client then refreshes once and retries.
- Validation failures: `400 VALIDATION_FAILED`, `details` = `[{ path, message }]` (submitted values are never echoed).
- Rate limited: `429 RATE_LIMITED` with `details.retryAfterSeconds` and a `Retry-After` header. Unauthenticated auth endpoints are limited per client IP (30/min each).
- Text lengths count Unicode code points after trimming.
- Another account's resource is always `404 NOT_FOUND`, never `403` (no existence leaks).
- Timestamps in responses are ISO 8601 strings.

## Tokens

- `accessToken`: JWT (HS256), TTL 15 min, claims `sub` = user id, `did` = device id, `role`.
- `refreshToken`: opaque string `<deviceId>.<secret>`; the server stores only a hash. TTL 60 days, sliding: every refresh rotates it and extends the expiry.
- Token pair response (`TokenPair`):
  ```json
  { "accessToken": "...", "refreshToken": "...", "accessTokenExpiresIn": 900,
    "user": { "id": "01J...", "role": "member" }, "deviceId": "01J..." }
  ```
- Clients must refresh single-flight (never two refreshes with the same token concurrently).

## Auth

### `POST /v1/auth/wechat` — mini-program login (no auth)
Body: `{ "code": string, "inviteCode"?: string, "deviceName"?: string }` (`code` from `wx.login`).
- Known WeChat identity → `200 TokenPair` (creates a new `mp` device).
- Unknown identity without `inviteCode` → `403 INVITE_REQUIRED`.
- Invite missing, used or expired → `403 INVITE_INVALID`.
- Valid invite → creates the account (role `member`), consumes the invite, `200 TokenPair` with `user.isNew = true` (`false` for existing users; absent on refresh/device responses).
- Invite codes are matched case-insensitively after trimming; an empty `inviteCode` counts as absent.
- Deleted account → `403 ACCOUNT_DISABLED`.
- Each login creates an `mp` device; an account keeps at most 5 active `mp` devices (the least recently active is revoked).
- WeChat rejects the code → `401 WECHAT_CODE_INVALID`; WeChat unreachable or not configured → `503 WECHAT_UNAVAILABLE`.
- Development only: with `WECHAT_DEV_LOGIN=1` the server does not call WeChat and maps `code` = `dev:<name>` (`<name>` 1–32 of `[a-z0-9_-]`) to the openid `dev_<name>`; any other code → `401 WECHAT_CODE_INVALID`. The server refuses to start with `WECHAT_DEV_LOGIN=1` when `NODE_ENV=production`.

### `POST /v1/auth/refresh` (no auth)
Body: `{ "refreshToken": string }` → `200 TokenPair` (new pair; the old refresh token stops working).
- Unknown / expired / revoked → `401 REFRESH_INVALID`.
- Replay of an already-rotated token outside the retry grace window → device revoked, `401 REFRESH_REUSED`.
  A replay within 60 s of its rotation (a client retrying after a lost response) is not treated as theft.

### `POST /v1/auth/logout` (auth)
Revokes the calling device. `200 { "revoked": true }`.

### CLI device authorization (RFC 8628 style)
1. `POST /v1/auth/device/start` (no auth). Body: `{ "deviceName": string }` (1–64 chars).
   `200 { "deviceCode": string, "userCode": "123456", "expiresIn": 600, "interval": 5, "qrPayload": "tcli://device?code=123456" }`.
   `userCode` is 6 digits; the CLI shows it and a QR code of `qrPayload`.
2. The user approves in the mini-program (scans the QR or types the 6-digit code).
   - First the mini-program shows which device asks: `POST /v1/auth/device/lookup` (auth). Body: `{ "userCode": string }`.
     `200 { "deviceName": string, "expiresIn": number }` (seconds left); no pending request with that code (or a malformed code) → `404 NOT_FOUND`.
   - Then the decision: `POST /v1/auth/device/approve` (auth). Body: `{ "userCode": string, "approve": boolean }`.
     `200 { "deviceName": string, "approved": boolean }`; no pending request with that code (or a malformed code) → `404 NOT_FOUND`.
   - `lookup` and `approve` share one limit: at most 10 attempts per account per minute.
   (Before the mini-program exists, an admin approves via `apps/server/scripts/admin.ts approve-device <userCode> <userId>`.)
3. The CLI polls `POST /v1/auth/device/token` (no auth), Body: `{ "deviceCode": string }`, every `interval` seconds:
   - approved → `200 TokenPair` (creates a `cli` device; the request is consumed, a second poll gets `400 expired_token`);
   - `400` with `error.code` one of `authorization_pending`, `slow_down` (polled faster than `interval`; add 5 s), `expired_token` (also for an unknown `deviceCode`), `access_denied`.
   - `device/start` may answer `503 DEVICE_AUTH_BUSY` if no free user code could be allocated (practically never).

### `GET /v1/me` (auth)
`200 { "id", "role", "createdAt", "settings": Settings }`.

`Settings` = `{ "explanationLang"?: "zh"|"en" }` (absent → `"zh"`). Clients send it as `lang` to the AI proxy.

### `POST /v1/me/settings` (auth)
Body: a partial `Settings`; unknown keys → `400 VALIDATION_FAILED`. Merges into the stored settings (partial update; POST rather than PATCH because the mini-program's `wx.request` cannot send PATCH).
`200 { "settings": Settings }` (the full settings after the merge).

### `GET /v1/devices` (auth) / `DELETE /v1/devices/:id` (auth)
List: `200 { "devices": [{ "id", "kind": "cli"|"mp"|"h5", "name", "createdAt", "lastSeenAt", "revokedAt", "current": boolean }] }`.
Revoke: `200 { "revoked": true }`; a device of another account → `404 NOT_FOUND`.

## Record sync

### `POST /v1/entries` (auth) — push
Body: `{ "entries": Entry[] }`, 1–500 items, each an Entry as defined in `packages/core/src/entry.js` (validated server-side with `validateEntry`).
`200 { "accepted": string[], "rejected": [{ "index": number, "id": string|null, "errors": string[] }], "lastSeq": number }`.
- `accepted` lists every valid id in the batch, new or already stored: the client drops exactly these from its outbox.
- `rejected` entries will never be accepted as-is; the client moves them aside instead of retrying forever.
- Idempotent: pushing the same entries again stores nothing new.

### `GET /v1/entries?after=<seq>&limit=<n>` (auth) — pull
`limit` 1–500 (default 200). `200 { "entries": (Entry & { "seq": number })[], "nextAfter": number, "hasMore": boolean }`, ordered by `seq`.
Clients persist `nextAfter` as their pull cursor (separate from anything push-related).

### `GET /v1/entries/history?before=<seq>&limit=<n>` (auth) — browse, newest first
For record lists ("我的 → 记录"). `before` is optional (absent → start from the newest); `limit` 1–100 (default 30).
`200 { "entries": (Entry & { "seq": number })[], "nextBefore": number|null, "hasMore": boolean }`, ordered by `seq` descending.
Pass `nextBefore` as `before` to load the next page; it is `null` when `hasMore` is false.

### `srcLang`
An Entry's `srcLang` is `"zh"`, `"en"`, `"other"` or `null`. The translate direction follows from it: `zh` → English, anything else → Chinese.
Detection (`detectSourceLang` in `packages/core/src/detect.js`), first match wins:
1. any kana or Hangul → `other` (Japanese, Korean);
2. any Han character → `zh` (mixed Chinese/English counts as Chinese);
3. any letter of another non-Latin script (Cyrillic, Greek, Thai, …) → `other`;
4. otherwise → `en` (Latin script; treated as English).
Pure-Han Japanese is detected as `zh`; the user can flip the direction (see `direction` below).

## AI proxy

### `POST /v1/ai/translate` (auth) — streaming
Body: `{ "text": string, "task": "translate"|"check", "mode"?: "simple"|"detail" (default "simple"), "lang"?: "zh"|"en" (explanation language, default "zh"), "utcOffsetMinutes"?: number (client's local offset, default 480), "direction"?: "toEn"|"toZh" }`.
`text` is 1–2000 chars after trimming.
`direction` overrides the detected direction for `translate` (the user tapped the direction label); it is ignored for `check`. `toEn` → `srcLang` `zh`. `toZh` → the detected `srcLang`, or `other` when the text was detected as `zh`.

Errors before streaming starts are JSON envelopes: `400 VALIDATION_FAILED`, `401`, `429 RATE_LIMITED` (per-minute), `429 QUOTA_EXCEEDED` (daily quota, `details.limit`), `502 AI_UPSTREAM`, `503 AI_UNAVAILABLE`.

Success: `200`, `Content-Type: application/x-ndjson`, one JSON object per line. The first line is always `meta` (the client shows the direction label from it); clients ignore line types they do not know:
```
{"type":"meta","srcLang":"en","kind":"word"}
{"type":"delta","text":"prior"}
{"type":"delta","text":"itize /praɪˈɔːr.ə.taɪz/ 优先考虑"}
{"type":"done","entry":{"id":"01J...","seq":42,"kind":"word","correctedInput":"prioritize"}}
```
A failure after streaming started ends the body with `{"type":"error","code":"AI_UPSTREAM"|"INTERNAL","message":"..."}` (`INTERNAL`: the result could not be stored). Outputs are capped at 50 000 code points.
Deltas are the raw model text; the stored `output` is the same text trimmed with line breaks normalized to LF.
The server stores the finished result as an Entry with `source: "mp"`; aborted or failed requests store nothing.
Each request counts against the daily quota when it starts (the account's local day, from `utcOffsetMinutes`); requests refused with 429 or `503 AI_UNAVAILABLE` are not counted.
Responses carry `Cache-Control: no-store` and `X-Accel-Buffering: no`; a reverse proxy must not buffer this route.
Clients receive the body in byte chunks that can split a multi-byte UTF-8 character or a line: buffer bytes, decode UTF-8 incrementally, and parse only complete lines.

## Speech

### `POST /v1/tts` (auth) — read an entry aloud
Body: `{ "entryId": string }` (an entry of the calling account).
`200`, `Content-Type: audio/mpeg`, the mp3 bytes; `Cache-Control: private, max-age=86400`.
The server picks the text (`speakableForEntry` in `packages/core/src/speakable.js`), so it only ever reads the account's own records:
- `check` → the corrected text (first line of the output);
- `translate`, `srcLang` `zh` → the English output (as the CLI's `/say`: IPA and markdown stripped);
- `translate`, `srcLang` `en` → the English source: `correctedInput ?? input`;
- `translate`, `srcLang` `other` → the Chinese output.
Voice: text containing CJK → a Chinese voice, otherwise an American English voice.
Errors (JSON envelopes): `404 NOT_FOUND` (unknown entry or another account's), `422 NOTHING_TO_SPEAK` (empty text), `422 TEXT_TOO_LONG` (over 1000 code points), `429 RATE_LIMITED` (30 per account per minute), `502 TTS_UPSTREAM`, `503 TTS_UNAVAILABLE` (disabled by config).
Not counted against the AI daily quota. The server caches audio by voice and text in a bounded in-memory cache.

## Learning (M3–M5)

Built on the tables in `apps/server/src/db/schema.ts` (items, item_sources, cards, review_logs, materials, pipeline_state, notify_grants, job_runs; migration `0001_learning`). Every query filters on the caller's `user_id`; another account's id is `404 NOT_FOUND`.

**Local day.** Endpoints that need a local date take `utcOffsetMinutes` (query or body, -720…840, default 480). The nightly jobs use the offset of the user's most recent entry (default 480).

### Content shapes

`items.content`, by item type (explanations — `zh`, `note`, `rule`, `summary` — are written in the user's `settings.explanationLang`, default zh):

```ts
type WordContent    = { headword: string; ipa: string; meanings: { pos: string; zh: string }[];
                        examples: { en: string; zh: string; fromUser: boolean }[];   // 2; ≤1 fromUser
                        collocations: string[]; synonyms: { word: string; note: string }[]; family: string[] };
type PhraseContent  = { phrase: string; zh: string; register: 'formal' | 'neutral' | 'casual';
                        alternatives: { en: string; note: string }[];               // 2
                        examples: { en: string; zh: string; fromUser: boolean }[] };
type GrammarContent = { title: string; rule: string; wrong: string; right: string;
                        exercises: { wrong: string; right: string }[] };            // 3
```

`fromUser` examples may quote the user's own word/sentence records, never a paragraph-level record (materials never contain paragraph text).

Cards per item: word → `recognize`, `produce`, `cloze`; phrase → `cloze`; grammar → `fix` (`dictation` is reserved, not generated). Every card face has one shape, so clients render all types the same way:

```ts
type CardFace = { text: string; ipa?: string; sub?: string; example?: { en: string; zh: string } };
```

| cardType | front | back | read aloud (TTS) |
|---|---|---|---|
| recognize | `{ text: headword, ipa }` | `{ text: meanings, example }` | headword |
| produce | `{ text: meanings }` | `{ text: headword, ipa }` | headword |
| cloze | `{ text: sentence with "____", sub: its translation }` | `{ text: full sentence, sub: the answer }` | full sentence |
| fix | `{ text: wrong sentence }` | `{ text: right sentence, sub: rule }` | right sentence |

### Scheduling (FSRS)

`ts-fsrs` with `request_retention` 0.9, `maximum_interval` 36500, `enable_fuzz` false. Ratings: 1 忘记 (Again), 2 困难 (Hard), 3 记得 (Good), 4 简单 (Easy). A card's state is always the replay of its logs ordered by `(reviewed_at, id)`, so concurrent offline reviews from two devices both count. `mastered` = last scheduled interval > `MASTERED_DAYS` (180); mastered and suspended cards leave the queue. Daily limits per local day (D10): at most `REVIEW_NEW_PER_DAY` (15) new cards introduced (a card is introduced on the day of its first log) and `REVIEW_MAX_PER_DAY` (60) reviews of non-new cards.

### Review

`GET /v1/review/summary?utcOffsetMinutes=` →
`{ due, newAvailable, reviewDue, doneToday, estimatedMinutes, streakDays }`. `due` = cards the queue would serve now (limits applied) — the 复习 tab badge. `estimatedMinutes` = ceil(due × 8 s / 60).

`GET /v1/review/queue?utcOffsetMinutes=&limit=` (1–100, default 50) → `{ cards: QueueCard[] }`: due non-new cards first (oldest due first), then new cards by item weight (`errorCount × 2 + lookupCount`, desc).
```ts
type QueueCard = { id: string; itemId: string; itemType: 'word' | 'phrase' | 'grammar'; cardType: string;
                   front: CardFace; back: CardFace; state: 'new' | 'learning' | 'review' | 'relearning';
                   intervals: { '1': number; '2': number; '3': number; '4': number } };   // seconds until due if rated so
```

`POST /v1/reviews` — Body `{ logs: { id: ULID; cardId: string; rating: 1|2|3|4; reviewedAt: ISO; durationMs?: number }[] }` (1–200) →
`{ accepted: string[], rejected: { id: string|null, errors: string[] }[], cards: { id, state, due, mastered }[] }`.
Idempotent by log id (already stored = accepted). An unknown or foreign `cardId`, or `reviewedAt` more than 5 min in the future, is rejected (not a 404: it is a batch). `cards` = the new state of every touched card.

`DELETE /v1/reviews/:id` — undo. Allowed for 5 minutes after the server accepted the log, else `409 UNDO_EXPIRED`; unknown → 404. → `{ card: { id, state, due, mastered } }`.

`POST /v1/cards/:id/report` — "内容有误". Suspends the item's cards, sets the item `needs_regen` and starts regeneration (`ItemRegenerator`, not awaited) → `202 { regenerating: true }`. Regeneration rewrites the item content and the faces of its existing cards in place (same ids, scheduling kept), then unsuspends them. At most 10 reports per account per minute.

### Materials

`GET /v1/materials/daily?date=YYYY-MM-DD` (omit `date` → latest) → `{ date, content: DailyMaterial, createdAt }`, or 404.
`GET /v1/materials/weekly?date=YYYY-MM-DD` (the week's Monday; omit → latest) → `{ date, content: WeeklyReport, createdAt }`, or 404.
`GET /v1/materials?kind=daily|weekly&before=YYYY-MM-DD&limit=` (1–60, default 30) → `{ dates: string[] (desc), nextBefore: string|null }`.
```ts
type DailyMaterial = {
  date: string;
  overview: { newWords: number; newPhrases: number; corrections: number; streakDays: number };
  words:   ({ itemId: string } & WordContent)[];      // ≤ 12
  phrases: ({ itemId: string } & PhraseContent)[];    // ≤ 6
  grammar: ({ itemId: string } & GrammarContent)[];   // ≤ 4
  story: { title: string; text: string; words: string[]; zh: string } | null;   // ≈120 words using 5–8 of the day's words
  mistakes: { itemId: string; display: string; note: string; example: { en: string; zh: string } }[];  // ≤ 5
};
type WeeklyReport = {
  weekStart: string; weekEnd: string;
  totals: { entries: number; newItems: number; reviews: number };
  topErrors: { title: string; count: number }[];      // grammar items by errors this week, ≤ 5
  topLookups: { display: string; count: number }[];   // ≤ 10
  retention: { thisWeek: number | null; lastWeek: number | null };   // share of ratings ≥ 2 on non-new cards
  summary: string;
};
```

### Library and stats

`GET /v1/items?q=&type=word|phrase|grammar&level=new|learning|mastered&offset=&limit=` (limit 1–50, default 20) → `{ items: { id, type, display, lookupCount, errorCount, level, lastSeenAt }[], nextOffset: number|null }`. Without `q`: by `lastSeenAt` desc. With `q`: pg_trgm similarity on `display` (plus a prefix match), best first. `level`: `new` = every card new, `mastered` = every card mastered, otherwise `learning`.

`GET /v1/items/:id` → `{ id, type, display, status, content, lookupCount, errorCount, firstSeenAt, lastSeenAt, level, cards: { id, cardType, state, due, mastered, suspended }[], sources: { entryId, input, createdAt }[] }` (the 10 latest sources).

`GET /v1/stats?days=&utcOffsetMinutes=` (days 1–366, default 120) → `{ days: { date, entries, reviews }[], streakDays, retention: { weekStart, rate }[], totals: { entries, items, cards, mastered } }`. `days` lists only days with activity. `streakDays` = consecutive local days with ≥ 1 entry or review, ending today (or yesterday when today has none yet). `retention` = the last 12 weeks (share of ratings ≥ 2 on non-new cards; weeks without such ratings are omitted).

`GET /v1/entries/day?date=YYYY-MM-DD&utcOffsetMinutes=` → `{ entries: (Entry & { seq: number })[] }` — that local day's records, oldest first, at most 500. The CLI's `/history` uses it to show mini-program records.

### Account

Settings (`GET /v1/me`, `POST /v1/me/settings`) grow to
`{ explanationLang?: 'zh'|'en', autoSpeakWord?: boolean (default true), autoSpeakOnFlip?: boolean (default true), reminderHour?: number 0–23 | null (default null) }`.

`POST /v1/export` → `200 text/markdown; charset=utf-8` with `Content-Disposition: attachment; filename="t-cli-export-YYYYMMDD.md"`: every record grouped by local date (input and output), then the learning units. At most 3 per account per hour.

`POST /v1/me/delete` — Body `{ "confirm": "DELETE" }` → deletes the account and all of its data (cascade) and thereby every device → `{ deleted: true }`. Any other body → `400 VALIDATION_FAILED`. A later WeChat login of the same person needs a new invite.

### Reminders (WeChat subscribe messages)

`GET /v1/notify/config` → `{ reminderTemplateId: string|null }` (null → reminders are not configured; clients hide the option).
`POST /v1/notify/grant` — Body `{ templateId }` after `wx.requestSubscribeMessage` returned `accept` → `{ available: number }`. A template other than the configured one → 400.
Hourly job: for every account with `reminderHour` equal to the current local hour, at least one card due and a grant available, send one subscribe message that opens `pages/review/index`, and consume the grant. Config: `WECHAT_REMINDER_TEMPLATE_ID`, `WECHAT_REMINDER_DATA` (JSON of the template's data fields; the placeholders `{due}` and `{date}` are filled in). Unset → no job, config returns null.

### Speech (extended)

`POST /v1/tts` takes exactly one of `{ entryId }`, `{ cardId }`, `{ itemId }`, `{ material: { kind: 'daily', date, section: 'story' } }` (all of the caller's own). Card → the "read aloud" column above; item → word headword / phrase / grammar `right`; story → `story.text`. Same limits, errors and cache as before.

### AI quotas (extended)

Besides the daily request count, each account has a daily token budget for the AI proxy, `AI_TOKENS_PER_DAY` (default 300 000), counted from the upstream's reported usage (estimated as code points / 2 when missing). Exceeded → `429 QUOTA_EXCEEDED` with `details: { limit, kind: 'tokens' }` (the request quota now also sends `kind: 'requests'`).

### Nightly pipeline

Job `pipeline-nightly`, 05:00 Asia/Shanghai. For each account with entries newer than `pipeline_state.last_seq`:
1. **Extract** units (LLM JSON mode, zod-validated): a word record → one word item (head = `correctedInput` or the head term; unrecognizable words are skipped); a sentence record → ≤ 2 phrases; a check record → ≤ 2 grammar points (`errorCount` + 1); a paragraph record → ≤ 3 units in total, never quoting it. Upsert by `(user, type, normKey)`; every new source record adds an `item_sources` row and bumps `lookupCount`.
2. **Generate** content for new and `needs_regen` items, then their cards (state new, due now).
3. **Daily material** for the previous local day (the day the records were made).
4. **Weekly report** on Sundays (local) for Monday–Sunday.
5. Advance the cursor only past what succeeded. One account failing does not stop the others. A zod failure is retried twice, then the item is `needs_regen` and an alert goes out.
Tokens per account per run are capped by `AI_PIPELINE_TOKENS_PER_RUN` (default 200 000); hitting the cap ends that account's run early (cursor kept) and alerts. `apps/server/scripts/admin.ts run-pipeline [userId]` runs it now.

### Alerts

`ALERT_SMTP_URL` (e.g. `smtps://user:pass@smtp.example.com:465`), `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`; unset → log line only. Kinds: `job_failed`, `pipeline_user_failed`, `item_needs_regen`, `token_budget_exceeded`, `reminder_failed`. At most one mail per kind per hour. Alert text never contains user text.

## v2 (M6–M10)

Additive: every v1 endpoint keeps its behaviour for old clients unless a line below says otherwise. Design: `docs/v2-plan.html` (sections 4, 5, 7, 13). Tables: `notes`, `lexicon`, `items.stars` (migration `0002_v2_notes_lexicon`). Shapes in code: `apps/server/src/modules/lookup/lexicon.ts` (zod), `apps/miniprogram/miniprogram/lib/types.ts` (client).

Language codes are BCP 47. The learning language is `en` only in v2; the explanation language is the account's `settings.explanationLang` (default `zh`). New JSON fields are language-neutral: `gloss` holds explanation-language text, `text` / `def` / examples hold learning-language text (never `zh` / `en` field names).

### Lookup (点词查词)

#### `LexiconEntry`

The word detail, cached site-wide in `lexicon` (key: `lang`, `explainLang`, lemma key, `version` = `LEXICON_VERSION`, currently 1). Strings are trimmed; limits in code points.

```ts
type LexiconEntry = {
  lemma: string;                                    // 1–60, display form of the base form: "decision", "look forward to"
  ipa: { us: string; uk: string };                  // each "/…/", ≤ 80
  senses: { pos: string; gloss: string; def: string }[];   // 1–6; pos ≤ 20 ("n."), gloss ≤ 120, def ≤ 300 (one English sentence)
  forms: { label: string; form: string }[];         // ≤ 8; label ≤ 20 ("复数"), form ≤ 60
  collocations: { text: string; gloss: string }[];  // ≤ 8; text ≤ 80, gloss ≤ 120
  examples: { text: string; gloss: string }[];      // 2–4; each ≤ 300
  contrasts: { word: string; note: string }[];      // ≤ 4; word ≤ 60, note ≤ 200 (近义辨析)
  memory: string;                                   // ≤ 300; "" when there is none
};
```

No exam tags and no frequency. The lemma key (`lexicon.lemma`) is the lemma with curly quotes straightened, whitespace collapsed and lowercased — the same key as a word item's `normKey`. The lexicon is the one table without `user_id`: it stores no user id and no user sentence, only lemmas and AI-written dictionary content.

#### `POST /v1/lookup` (auth)

Body: `{ "word": string, "sentence"?: string, "entryId"?: string }` (unknown keys → 400).
- `word`: 1–64 code points after trimming; whitespace is collapsed and curly quotes straightened; must contain a Latin letter. A phrase of adjacent words (the user extended the selection) is a `word` too.
- `sentence`: the sentence the word was tapped in, ≤ 2000 code points; empty = absent.
- `entryId`: ULID of the caller's record the sentence comes from. An unknown or foreign id → `404 NOT_FOUND`. Only checked and logged (by id); nothing is stored for it.

`200`:
```json
{ "lemma": "decision", "lang": "en", "entry": LexiconEntry,
  "context": { "meaning": "决定（这里指公司做出的正式决定）", "phrase": { "text": "make a decision", "gloss": "做出决定" } },
  "cached": true }
```
- `lemma` = `entry.lemma` (decisions → decision). Clients open the word page and save word notes with it.
- `context` (在本句中) is `null` without `sentence`; otherwise `meaning` (≤ 200, explanation language) and `phrase` — the phrase of the sentence the word belongs to, `{ text ≤ 80 (as in the sentence), gloss ≤ 120 }`, or `null`. Context is generated per request and never cached.
- `cached`: the entry came from the lexicon (`true`) or was generated by this request (`false`). A hit increments `lexicon.hits`.

Flow: the server derives candidate lemma keys from `word` deterministically (the word itself, then English inflection rules) and reads the lexicon; a key derived by a rule is a hit only when its entry lists `word` among its inflections (`forms` with an inflection label), so "news" never resolves to "new". On a miss the model writes the entry; it is validated (`LexiconEntrySchema`, one retry) and stored under its own lemma's key (`ON CONFLICT DO NOTHING`: concurrent misses store one row) — only when that key is one of the candidates, or `word` is a single word its entry lists among its forms; an entry for an unrelated lemma (a corrected misspelling, or text crafted to steer the model) is answered but not cached. Glosses are in the account's explanation language, which is part of the cache key.

Quota: a request that calls the model (a lexicon miss, or any request with `sentence`) counts one request against the daily AI request quota (`AI_REQUESTS_PER_DAY`, the same counter as `/v1/ai/translate`), and its tokens count against `AI_TOKENS_PER_DAY`, on the account's local day at the offset of its most recent record (default 480; the body has no `utcOffsetMinutes`). A lexicon hit without `sentence` calls no model and is not counted. Per minute: at most `LOOKUP_REQUESTS_PER_MINUTE` (default 30) lookups per account.

Errors (JSON envelopes), checked in this order: `401`; `400 VALIDATION_FAILED`; `503 LOOKUP_DISABLED` (env `LOOKUP_ENABLED=0`; clients then hide tap-to-look-up for the session); `429 RATE_LIMITED`; `404 NOT_FOUND` (`entryId`); `429 QUOTA_EXCEEDED` (`details: { limit, kind }`); `503 AI_UNAVAILABLE` (no model configured); `502 AI_UPSTREAM` (model error, timeout, or an invalid entry after the retry); `422 NOT_A_WORD` (the model found no English word or phrase in `word`; nothing is cached; the request was counted). The server answers within the clients' 20 s JSON timeout or fails with `502` (env `LOOKUP_TIMEOUT_MS`, default 18 000, bounds the model calls). Logs carry sizes, timings, `cached` and the outcome — never the word or the sentence.

### Notes (笔记本)

A note is a word, phrase or sentence the user saved, with an importance of 1–4 stars (default 1 when saving). Ids are client ULIDs, so a client can save offline and retry: a repeated `PUT` never creates a second note.

```ts
type NoteKind = 'word' | 'phrase' | 'sentence';
type Note = {
  id: string;                 // ULID (client)
  kind: NoteKind;
  text: string;               // the learning-language side (English), whichever side the user typed
  translation: string | null; // the other side; null when unknown
  lang: 'en';
  stars: 1 | 2 | 3 | 4;
  lemma: string | null;       // word / phrase notes saved after a lookup
  entryId: string | null;     // the record it was saved from
  itemId: string | null;      // the learning unit it feeds (set by the server)
  seq: number;                // the note's latest change, for /v1/notes/changes
  createdAt: string; updatedAt: string; deletedAt: string | null;
};
```

#### `PUT /v1/notes/:id` (auth) — save or update

`:id` must be a ULID (else 400). Body (unknown keys → 400): `{ "kind": NoteKind, "text": string, "translation"?: string, "lang": "en", "stars": 1–4, "entryId"?: string, "lemma"?: string }`.
- `text`: `word` / `phrase` 1–64 code points, whitespace collapsed, curly quotes straightened, must contain a Latin letter (clients send the lookup's `lemma` as the text when there was a lookup); `sentence` 1–2000 code points, trimmed.
- `translation`: ≤ 2000 code points; empty counts as absent.
- `lang`: `"en"` is the only accepted value in v2.
- `entryId`: a ULID, stored as sent and not checked (the CLI may save before its record is pushed).
- `lemma`: 1–60 code points, word and phrase notes only (ignored for sentences).

Semantics:
- Unknown id → creates the note. Known id → `kind`, `text` and `lang` must equal the stored ones, else `409 NOTE_CONFLICT`; `stars` is replaced; `translation`, `entryId` and `lemma` are replaced when present and kept when absent. A `PUT` of a deleted note revives it (`deletedAt` = null).
- Every change assigns the note a new `seq` and `updatedAt`; a `PUT` that changes nothing returns the stored note unchanged (same `seq`).
- In the same transaction the server links the learning unit (`itemId`) and sets `items.stars` = the highest `stars` of the item's live notes:
  - `word` → the `word` item with `normKey` = the lemma key of `lemma ?? text` (the same item the nightly pipeline extracts). When the item has no content yet and the lexicon has an entry for that key (account's explanation language, current version), the content is built from it — `headword` = `lemma`, `ipa` = `ipa.us`, `meanings` = senses `{ pos, zh: gloss }`, `examples` = the first two `{ en: text, zh: gloss, fromUser: false }`, `collocations` = their `text`, `synonyms` = `contrasts`, `family` = the forms' `form` — and its cards are created at once. Otherwise the item stays `pending` and the nightly pipeline fills it.
  - `phrase` → the `phrase` item with the pipeline's phrase key; a new one is `pending` and filled by the nightly pipeline.
  - `sentence` → a `sentence` item: `normKey` = SHA-256 (hex) of the lowercased, whitespace-collapsed text (keeps the unique index small), `display` = text, `content` = `{ text, translation }` (no AI), `ready`. It gets one `recall` card when `translation` is not null; a sentence without a translation has nothing to recall from and gets no card.
  - Notes write no `item_sources` row and do not change `lookupCount` (records are linked by the pipeline as before).
- `200 { "note": Note }`. Errors: `400 VALIDATION_FAILED`, `401`, `409 NOTE_CONFLICT`.

#### `DELETE /v1/notes/:id` (auth) — 取消收藏

Soft delete: sets `deletedAt`, assigns a new `seq` and recomputes `items.stars` (0 when no live note is left). The item, its cards and their review history stay. `200 { "note": Note }`. Already deleted → `200` with the stored note (no new `seq`). Unknown or another account's → `404 NOT_FOUND` (an offline queue treats it as done).

#### `GET /v1/notes?kind=&stars=&before=&limit=` (auth) — the notebook

Live notes only, newest first by `id` (a ULID's time is when the client saved it). `kind` one of the three kinds (absent = all); `stars` 1–4, exact match (absent = all); `before` a note id (absent = from the newest); `limit` 1–100 (default 30).
`200 { "notes": Note[], "nextBefore": string|null, "hasMore": boolean }` — pass `nextBefore` as `before`; it is `null` when `hasMore` is false.

#### `GET /v1/notes/changes?after=<seq>&limit=<n>` (auth) — incremental sync

Every note with `seq > after`, deleted ones included (`deletedAt` set), in its latest state, ordered by `seq`. `after` ≥ 0 (default 0), `limit` 1–500 (default 200).
`200 { "notes": Note[], "nextAfter": number, "hasMore": boolean }` (as the entries pull). Clients persist `nextAfter`. Seqs are per account and allocated under the account row's lock, so seq order equals commit order and a cursor never skips a change. The mini-program and the CLI share this endpoint.

### Records (记录页)

#### `GET /v1/entries/days?from=&to=&utcOffsetMinutes=&source=` (auth)

`from`, `to`: local dates `YYYY-MM-DD`, required, `from` ≤ `to`, at most 366 days inclusive (else 400). `utcOffsetMinutes` as in "Local day" (default 480). `source`: `cli` | `mp` (absent = both).
`200 { "days": [{ "date": "2026-11-24", "count": 12 }] }` — the local dates in the range with at least one record (translations and checks), ascending.

#### `GET /v1/entries/history` gains filters

`?before=&limit=&date=&utcOffsetMinutes=&source=&q=`. New, all optional, combined with AND:
- `date`: one local date (at `utcOffsetMinutes`, default 480);
- `source`: `cli` | `mp`;
- `q`: 1–100 code points after trimming (empty = absent): a case-insensitive literal substring of the record's `input` (`%`, `_` and `\` match themselves), backed by the trigram index on `entries.input`.
Paging and the response are unchanged (seq descending, `nextBefore`).

### Speech in parts

`POST /v1/tts` takes an optional `part` (integer ≥ 0, default 0) beside any of its targets: `{ "entryId": "…", "part": 1 }`.
The server splits the speakable text into parts of at most 1000 code points: sentence ends are `.` `!` `?` `…` followed by whitespace, `。` `！` `？` `；`, and line breaks; consecutive sentences are packed greedily into a part; a sentence longer than 1000 code points is cut at its last whitespace before the limit, else at 1000. Parts are substrings of the text, trimmed; the split is deterministic, so clients fetch part 0, 1, … in turn. The voice is chosen once for the whole text, so every part sounds the same.
Every `200` carries `X-Speech-Part` (the part served) and `X-Speech-Parts` (how many there are). `part` ≥ the count → `422 PART_OUT_OF_RANGE` with `details: { parts }`. `422 TEXT_TOO_LONG` no longer occurs. A client that sends no `part` gets part 0 — for texts up to 1000 code points that is the whole text, as before. Each part is one request against the per-minute limit and is cached on its own.

### Settings

`Settings` (`GET /v1/me`, `POST /v1/me/settings`; strict, unknown keys → 400) gains these keys. Absent → the default, applied by clients. Clients save a change locally first and push it when online; at start-up a pending local change wins, otherwise the account's value applies (as the CLI already does for `explanationLang`).

| Key | Values | Default |
|---|---|---|
| `showDirection` | boolean — show the translate direction button | `false` |
| `accent` | `indigo` \| `pine` \| `plum` \| `ochre` \| `ink` (主题色) | `indigo` |
| `themeMode` | `system` (follow the phone) \| `time` \| `fixed` | `system` |
| `themeFixed` | `light` \| `dark` — the theme of `fixed` | `light` |
| `themeDayStart` | `"HH:MM"` (00:00–23:59) — `time`: light from here | `"07:00"` |
| `themeNightStart` | `"HH:MM"` — `time`: dark from here | `"19:00"` |
| `readingMode` | boolean (阅读模式) | `false` |
| `readingFontStep` | integer 0–3, reading-mode font size step (0 = normal) | `0` |
| `importanceReview` | boolean — schedule reviews by stars (按重要程度安排复习) | `true` |

`themeMode: "time"`: light while the local time is in `[themeDayStart, themeNightStart)` (wrapping past midnight when the start is later than the end), dark otherwise; equal times mean light all day.

### Review by importance (supersedes "Scheduling (FSRS)" and the queue order above)

Each card's `request_retention` comes from its item's `stars` (other FSRS parameters unchanged):

| `items.stars` | 0 (not saved) | 1 ★ | 2 ★ | 3 ★ | 4 ★ |
|---|---|---|---|---|---|
| retention | 0.85 | 0.90 | 0.92 | 0.94 | 0.95 |

`settings.importanceReview = false` → 0.90 for every card. A card's state is still the replay of its logs, now with the retention of its item's current stars, so changing a note's stars changes the next intervals without resetting progress. `QueueCard.intervals` use the card's retention.
Queue order: due non-new cards first (oldest due first, unchanged), then new cards by `items.stars` descending, then by item weight (`errorCount × 2 + lookupCount`, desc). Daily limits unchanged.
`QueueCard.itemType` gains `sentence`; `cardType` gains `recall`:

| cardType | front | back | read aloud (TTS) |
|---|---|---|---|
| recall | `{ text: translation }` | `{ text: sentence }` | sentence |

Daily material (nightly pipeline) picks 4 ★ items first, then 3 ★, for its words and story, before the usual weighting. `GET /v1/items` and `GET /v1/items/:id` gain `stars` (0–4); the `type` filter and `type` field gain `sentence`; item → TTS reads a sentence item's `text`.

### New error codes

| Status | Code | When |
|---|---|---|
| 503 | `LOOKUP_DISABLED` | `POST /v1/lookup` while `LOOKUP_ENABLED=0` |
| 422 | `NOT_A_WORD` | `POST /v1/lookup`: no English word or phrase recognized |
| 409 | `NOTE_CONFLICT` | `PUT /v1/notes/:id`: the id exists with another `kind`, `text` or `lang` |
| 422 | `PART_OUT_OF_RANGE` | `POST /v1/tts`: `part` ≥ the number of parts (`details.parts`) |
