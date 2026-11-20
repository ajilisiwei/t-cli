# t-cli sync service — API v1 contract

Single source of truth for the server (`apps/server`), the CLI sync client
(`apps/cli`) and the mini-program (M2). Change this file first, then the code.

## Conventions

- Base URL: configured per client (CLI: `TCLI_SERVER_URL` env or `serverUrl` in `~/.config/t-cli/config.json`).
- JSON endpoints answer with an envelope:
  - success: `{ "success": true, "data": <T>, "error": null }`
  - failure: `{ "success": false, "data": null, "error": { "code": "<CODE>", "message": "...", "details"?: ... } }`
- Clients branch on `error.code`, never on `message`.
- Authenticated endpoints need `Authorization: Bearer <accessToken>`. A missing, invalid or expired token yields `401 UNAUTHORIZED`; the client then refreshes once and retries.
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
2. The user approves in the mini-program: `POST /v1/auth/device/approve` (auth). Body: `{ "userCode": string, "approve": boolean }`.
   `200 { "deviceName": string, "approved": boolean }`; no pending request with that code (or a malformed code) → `404 NOT_FOUND`. At most 10 attempts per account per minute.
   (Before the mini-program exists, an admin approves via `apps/server/scripts/admin.ts approve-device <userCode> <userId>`.)
3. The CLI polls `POST /v1/auth/device/token` (no auth), Body: `{ "deviceCode": string }`, every `interval` seconds:
   - approved → `200 TokenPair` (creates a `cli` device; the request is consumed, a second poll gets `400 expired_token`);
   - `400` with `error.code` one of `authorization_pending`, `slow_down` (polled faster than `interval`; add 5 s), `expired_token` (also for an unknown `deviceCode`), `access_denied`.
   - `device/start` may answer `503 DEVICE_AUTH_BUSY` if no free user code could be allocated (practically never).

### `GET /v1/me` (auth)
`200 { "id", "role", "createdAt", "settings": {} }`.

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

## AI proxy

### `POST /v1/ai/translate` (auth) — streaming
Body: `{ "text": string, "task": "translate"|"check", "mode"?: "simple"|"detail" (default "simple"), "lang"?: "zh"|"en" (explanation language, default "zh"), "utcOffsetMinutes"?: number (client's local offset, default 480) }`.
`text` is 1–2000 chars after trimming.

Errors before streaming starts are JSON envelopes: `400 VALIDATION_FAILED`, `401`, `429 RATE_LIMITED` (per-minute), `429 QUOTA_EXCEEDED` (daily quota, `details.limit`), `502 AI_UPSTREAM`, `503 AI_UNAVAILABLE`.

Success: `200`, `Content-Type: application/x-ndjson`, one JSON object per line:
```
{"type":"delta","text":"prior"}
{"type":"delta","text":"itize /praɪˈɔːr.ə.taɪz/ 优先考虑"}
{"type":"done","entry":{"id":"01J...","seq":42,"kind":"word","correctedInput":"prioritize"}}
```
A failure after streaming started ends the body with `{"type":"error","code":"AI_UPSTREAM"|"INTERNAL","message":"..."}` (`INTERNAL`: the result could not be stored). Outputs are capped at 50 000 code points.
Deltas are the raw model text; the stored `output` is the same text trimmed with line breaks normalized to LF.
The server stores the finished result as an Entry with `source: "mp"`; aborted or failed requests store nothing.
Each request counts against the daily quota when it starts (the account's local day, from `utcOffsetMinutes`); requests refused with 429 or `503 AI_UNAVAILABLE` are not counted.
Responses carry `Cache-Control: no-store` and `X-Accel-Buffering: no`; a reverse proxy must not buffer this route.
