# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Install dependencies**: `npm install`
- **Run the tool**: `npm start` or `node bin/t-cli.js`
- **Run tests**: `npm test` (Node's built-in `node --test`, test files in `test/`)
- **Global installation**: `npm run release:local` (bumps patch version, packs, installs into `~/.npm-global` — the prefix that wins on PATH; a plain `npm install -g` may target a shadowed prefix and keep serving stale code)
- **Build package**: `npm pack`

## Architecture & Structure

A minimalist, stateless CLI translation tool using DeepSeek API, rendered as an Ink (React for terminals) TUI.

- **Entry Point**: `bin/t-cli.js` - Loads dotenv and invokes the REPL.
- **Core Modules** (`src/`):
  - `repl.js`: Ink `App` component. Renders the message log, streaming output, status line, and text input. Handles command routing (`/check`, `/lang`, `/mode`, `/history`, `/notes`, `/say`, `/clear`, etc.) and orchestration of API calls. Uses `React.createElement` (no JSX, no build step).
  - `api.js`: Stateless client for DeepSeek Chat API. Implements manual SSE (Server-Sent Events) parsing for streaming output.
  - `prompts.js`: Constructs system prompts per language/detail mode. Exports `buildSourceMessage(text, task)` which wraps user input in `<source>` tags — the prompt-injection defense ensuring input is always treated as text to translate, never as instructions. Word lookups get an IPA transcription rule; detail mode enforces "best translation alone on the first line".
  - `tts.js`: Text-to-speech for `/say`. Synthesizes mp3 via `msedge-tts` (Microsoft Edge Read Aloud, unofficial free endpoint — no SLA) and plays it with `afplay`/`ffplay`; falls back to the local macOS `say` command on failure. Voice picked by CJK detection.
  - `config.js`: Manages persistent user settings (language, mode) in the system's standard configuration directory (`~/.config/t-cli/` or `%APPDATA%/t-cli/`).
  - `history.js`: Appends raw translation/grammar-check entries to `~/.config/t-cli/history/YYYY-MM-DD.md`. Powers the `/history` command.
  - `notes.js`: Reads/writes AI-generated learning notes in `~/.config/t-cli/notes/YYYY-MM-DD.md`. Powers the `/notes` command.
  - `utils/detect.js`: `isWordLookup()` (single-word detection for IPA) and `containsCJK()` (TTS voice selection).
  - `utils/speakable.js`: `extractSpeakable()` — derives the text `/say` reads aloud from a raw response (first line in detail mode, IPA/markdown stripped).
  - `utils/inputHistory.js`: Pure helpers behind the REPL's arrow-key input history (`pushHistory`, `navigateHistory`).

## Constraints for Code Changes (READ before modifying the TUI)

This app is an **Ink (React for terminals) TUI that owns `stdin` in raw mode**. Any command — especially interactive/multi-step ones — MUST follow the existing control model:

- **Output**: append to the message log via the component's `appendMessage` helper, or stream via `streamAndRender`. NEVER use `console.log`, `process.stdout.write`, or `process.stderr.write` for UI — Ink manages the frame and raw writes corrupt it (they leak above/around the live render).
- **Input**: read through Ink components (`ink-text-input`) and React state. NEVER use Node `readline`, `process.stdin.on('data')`, or `process.stdin.setRawMode()` — they fight Ink for stdin and **permanently break key decoding** (e.g. arrow keys start printing `^[[A` and history navigation dies), even if only created once and closed.
- **Interactive/multi-step commands** (quiz, wizards, confirmations): model them as a **React state machine** — hold step/awaiting-answer in state and route the existing input box's submissions into that machine. Do NOT write a blocking `async` loop that reads stdin directly; there is only one input surface and Ink drives it.
- **Reuse existing patterns**: mirror how `runCheck` / `runNotesCommand` stream output and how the single `TextInput` + `useInput` handle input. New utilities go in `src/utils/` as pure/logic helpers that the `App` component orchestrates — keep I/O and React concerns in `repl.js`, not in utils.

> These are hard constraints: unit tests and `node --check` will pass even when they are violated, but the running TUI breaks. Verify interactive changes by actually running the app.

## Testing Notes

- Unit tests cover pure logic (`detect`, `speakable`, `prompts`). Prompt-behavior changes should also be verified against the live API with adversarial inputs (instruction-like text must be translated, not executed).

## Environment Variables

- `DEEPSEEK_API_KEY`: **Required**. Must be set in the environment or provided via a `.env` file for the tool to function.

## Usage Patterns

- Input text directly for auto-detected translation (ZH ↔ EN).
- Use `/check <text>` for English grammar checking and polishing.
- Toggle between `simple` and `detail` modes via `/mode <s|d>`.
- Switch explanation language via `/lang <en|zh>`.
- Use `/history [today|YYYY-MM-DD]` to browse raw translation/check records.
- Use `/notes [today|YYYY-MM-DD]` to generate (or view) an AI-curated English learning note for that day. Use `/notes regen today` to force regeneration.
- Single-word input (English token, or Chinese term of 1-4 chars) is treated as a word lookup: the English result includes its American IPA transcription.
- Use `/say` to read the last translation aloud; `/say stop` cancels playback.
