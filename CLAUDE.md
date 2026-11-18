# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

All commands run from the repository root (npm workspaces).

- **Install dependencies**: `npm install`
- **Run the tool**: `npm start` or `node apps/cli/bin/t-cli.js`
- **Run tests**: `npm test` (Node's built-in `node --test`; discovers `apps/*/test` and `packages/*/test`)
- **Global installation**: `npm run release:local` → `scripts/release-local.mjs`. Bumps the CLI patch version, stages `apps/cli` with `@t-cli/core` bundled (`bundleDependencies` — the core package is private and never published, so a plain `npm pack` of `apps/cli` is NOT installable), packs, and installs into `~/.npm-global` (the prefix that wins on PATH; a plain `npm install -g` may target a shadowed prefix and keep serving stale code). Flags: `--no-bump`, `--prefix <dir>`, `--pack-only`.
- **Backfill structured records**: `npm run backfill -w t-cli-translator -- --dry-run` imports the Markdown history into `outbox.jsonl` (one-off, idempotent).
- **Spelling audit**: `npm run audit:spelling -w t-cli-translator -- --save-plan <file>` finds misspelled English word lookups in the outbox (deterministic + LLM); review the plan, then `--apply --from-plan <file>` sets `correctedInput` (backup + atomic rewrite). Never `--apply` without a reviewed plan: LLM verdicts are not stable between runs.
- **Server dev database**: `docker compose -f apps/server/docker-compose.dev.yml up -d` — PostgreSQL 16 (same major as production) on `127.0.0.1:55433`, trust auth, local only.
- **Server tests**: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres npm test`. Without the variable the database suites are skipped. Each test file creates and drops its own `tcli_test_*` database, so point `TEST_DATABASE_URL` at this dev instance only — never at any other database.
- **Server dev login**: `WECHAT_DEV_LOGIN=1` makes `POST /v1/auth/wechat` accept `dev:<name>` codes without calling WeChat (mini-program simulator); the server refuses to start with it when `NODE_ENV=production`.
- **Server typecheck**: `npm run typecheck -w @t-cli/server` (Node 24 runs the TypeScript sources directly; erasable syntax only, relative imports end in `.ts`).
- **Server deploy**: see `apps/server/deploy/README.md`; API contract in `docs/api-v1.md`.
- **Mini-program**: `npm run typecheck -w @t-cli/miniprogram`; unit tests run with `npm test`. Pure logic in `apps/miniprogram/miniprogram/lib` (no `wx`, no value imports between modules, so Node can load it). `vendor/core/` is a generated copy of core modules: after changing one, run `npm run sync:core -w @t-cli/miniprogram`. DevTools, configuration and upload: `apps/miniprogram/README.md`.

## Architecture & Structure

A minimalist, stateless CLI translation tool using DeepSeek API, rendered as an Ink (React for terminals) TUI. The repo is an npm-workspaces monorepo; the design for multi-device sync and AI review lives in `docs/cloud-sync-review-plan.html`.

```
apps/cli/        t-cli-translator — the Ink TUI (published as the `t-cli` binary)
apps/server/     @t-cli/server — sync service: accounts, record sync, AI proxy (Fastify + Drizzle + PostgreSQL)
apps/miniprogram/ @t-cli/miniprogram — WeChat mini-program (native + TypeScript + Skyline); see its README
packages/core/   @t-cli/core — logic shared by every client and the server
scripts/         repo tooling (release-local.mjs)
```

- **Shared core** (`packages/core/src/`, import as `@t-cli/core/<module>`). Anything a second client (sync server, mini-program backend) must behave identically on belongs here, not in the CLI:
  - `prompts.js`: Constructs system prompts per language/detail mode. Exports `buildSourceMessage(text, task)` which wraps user input in `<source>` tags — the prompt-injection defense ensuring input is always treated as text to translate, never as instructions. Word lookups get an IPA transcription rule; detail mode enforces "best translation alone on the first line".
  - `detect.js`: `isWordLookup()` (single-word detection for IPA), `containsCJK()` (TTS voice selection), `detectSourceLang()` (pinned translation direction: `zh` → English; `en` and `other` — kana, Hangul, Cyrillic, … — → Chinese; rule in `docs/api-v1.md`, "srcLang").
  - `speakable.js`: `extractSpeakable()` — derives the text `/say` reads aloud from a raw response (first line in detail mode, IPA/markdown stripped). `speakableForEntry()` picks what the server's `POST /v1/tts` reads for a stored entry.
  - `entry.js`: The raw record ("Entry") schema shared with the sync server: `createEntry`, `validateEntry`, `classifyKind` (word / sentence / paragraph), JSONL (de)serialization.
  - `ulid.js`: Offline ULID generation (optionally deterministic via fixed entropy) for idempotent sync writes.
  - `spelling.js`: `extractHeadTerm()` / `detectSpellingCorrection()` — deterministic misspelling detection for English word lookups (head word before the IPA vs. the input). Feeds the CLI's "拼写更正" notice and `Entry.correctedInput`; review material must use `correctedInput` when set.
- **CLI** (`apps/cli/`):
  - `bin/t-cli.js`: Entry point — loads dotenv and invokes the REPL.
  - `src/repl.js`: Ink `App` component. Renders the message log, streaming output, status line, and text input. Handles command routing (`/check`, `/lang`, `/mode`, `/history`, `/notes`, `/say`, `/clear`, `/login`, `/sync`, etc.) and orchestration of API calls. Uses `React.createElement` (no JSX, no build step).
  - `src/api.js`: Stateless client for DeepSeek Chat API. Implements manual SSE (Server-Sent Events) parsing for streaming output.
  - `src/tts.js`: Text-to-speech for `/say`. Synthesizes mp3 via `msedge-tts` (Microsoft Edge Read Aloud, unofficial free endpoint — no SLA) and plays it with `afplay`/`ffplay`; falls back to the local macOS `say` command on failure. Voice picked by CJK detection.
  - `src/config.js`: Manages persistent user settings (language, mode) in the system's standard configuration directory (`~/.config/t-cli/` or `%APPDATA%/t-cli/`).
  - `src/history.js`: Appends raw translation/grammar-check entries to `~/.config/t-cli/history/YYYY-MM-DD.md`, named by the **local** date (header marked `(local date)`; older files with a bare header are named by UTC date and are never renamed — `utils/historyParser.js` reads both). Powers the `/history` command. Returns write errors instead of printing them.
  - `src/entryLog.js`: Appends each translation/check as a structured Entry to `~/.config/t-cli/outbox.jsonl` (the sync push queue) and records `liveSince` / `lastPush` in `sync-state.json`. Owns every outbox rewrite: `replaceOutboxContent` (temp file + rename, keeps lines appended concurrently via `mergeConcurrentTail`, optional backup) is shared by the sync push and `scripts/audit-spelling.js`. Returns errors instead of printing them.
  - `src/notes.js`: Reads/writes AI-generated learning notes in `~/.config/t-cli/notes/YYYY-MM-DD.md`. Powers the `/notes` command. Returns write errors instead of printing them.
  - `src/utils/localDate.js`: `localDateString()` / `localDateDaysAgo()` — the one place that computes the local `YYYY-MM-DD` used by history/notes file names, `/history today`, `/notes today` and the `/quiz` cutoff.
  - `src/utils/inputHistory.js`: Pure helpers behind the REPL's arrow-key input history (`pushHistory`, `navigateHistory`).
  - `src/sync/`: Record sync with the server (contract: `docs/api-v1.md`). `settings.js` (server URL from `TCLI_SERVER_URL` or `serverUrl` in config.json; unset → sync off), `authStore.js` (`auth.json`, 0600, atomic), `client.js` (fetch + envelope parsing, single-flight token refresh, timeouts, no redirects), `deviceFlow.js` (pure `/login` reducer), `login.js` (one poll step, QR as a string), `push.js` (batched push, acked-id removal, rejected → `outbox.rejected.jsonl`), `syncer.js` (background single-flight + backoff), `status.js` (pure text), `useSync.js` (the React glue: login state machine via `useReducer` + one timer effect per poll; `/login`, `/logout`, `/sync` handlers).

## Constraints for Code Changes (READ before modifying the TUI)

This app is an **Ink (React for terminals) TUI that owns `stdin` in raw mode**. Any command — especially interactive/multi-step ones — MUST follow the existing control model:

- **Output**: append to the message log via the component's `appendMessage` helper, or stream via `streamAndRender`. NEVER use `console.log`, `process.stdout.write`, or `process.stderr.write` for UI — Ink manages the frame and raw writes corrupt it (they leak above/around the live render).
- **Input**: read through Ink components (`ink-text-input`) and React state. NEVER use Node `readline`, `process.stdin.on('data')`, or `process.stdin.setRawMode()` — they fight Ink for stdin and **permanently break key decoding** (e.g. arrow keys start printing `^[[A` and history navigation dies), even if only created once and closed.
- **Interactive/multi-step commands** (quiz, wizards, confirmations): model them as a **React state machine** — hold step/awaiting-answer in state and route the existing input box's submissions into that machine. Do NOT write a blocking `async` loop that reads stdin directly; there is only one input surface and Ink drives it.
- **Reuse existing patterns**: mirror how `runCheck` / `runNotesCommand` stream output and how the single `TextInput` + `useInput` handle input. New CLI-only utilities go in `apps/cli/src/utils/` as pure/logic helpers that the `App` component orchestrates — keep I/O and React concerns in `repl.js`, not in utils. Logic other clients must share (prompts, detection, record schema) goes in `packages/core` instead. (Sync's React glue lives in `src/sync/useSync.js`; its logic stays in the pure `src/sync/*` modules.)
- **Background work never prints**: async results (sync pushes, login polling) surface through `appendNotice` (unlike `appendMessage` it leaves quiz state alone) or through state a command shows (`/sync status`). Timers and in-flight requests are cancelled in effect cleanups so `exit` unmounts cleanly.

> These are hard constraints: unit tests and `node --check` will pass even when they are violated, but the running TUI breaks. Verify interactive changes by actually running the app.

## Testing Notes

- Unit tests cover pure logic (`detect`, `speakable`, `prompts`, `entry`, `ulid`, history parsing), the outbox I/O (`entryLog`, isolated via a temp `XDG_CONFIG_HOME`) and the sync client/push/login against a local fake HTTP server (`apps/cli/test/sync*.test.js`). `apps/server/test/cliSync.e2e.test.ts` runs the CLI's login/push code against the real server app (needs `TEST_DATABASE_URL`). Prompt-behavior changes should also be verified against the live API with adversarial inputs (instruction-like text must be translated, not executed).
- Never point tests or scripts at the real `~/.config/t-cli/` for writes — set `XDG_CONFIG_HOME` to a temp dir.

## Environment Variables

- `DEEPSEEK_API_KEY`: **Required**. Must be set in the environment or provided via a `.env` file for the tool to function.
- `TCLI_SERVER_URL`: Optional sync server base URL (overrides `serverUrl` in `config.json`). Unset → sync is off and nothing runs in the background.

## Usage Patterns

- Input text directly for auto-detected translation (ZH ↔ EN).
- Use `/check <text>` for English grammar checking and polishing.
- Toggle between `simple` and `detail` modes via `/mode <s|d>`.
- Switch explanation language via `/lang <en|zh>`.
- Use `/history [today|YYYY-MM-DD]` to browse raw translation/check records.
- Use `/notes [today|YYYY-MM-DD]` to generate (or view) an AI-curated English learning note for that day. Use `/notes regen today` to force regeneration.
- Single-word input (English token, or Chinese term of 1-4 chars) is treated as a word lookup: the English result includes its American IPA transcription.
- Use `/say` to read the last translation aloud; `/say stop` cancels playback.
- Use `/login` to link the CLI to an account (6-digit code + QR, approved in the mini-program; `/login cancel` aborts), `/logout` to unlink, `/sync status` to inspect sync and `/sync now` to push immediately.
