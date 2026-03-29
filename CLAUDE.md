# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Install dependencies**: `npm install`
- **Run the tool**: `npm start` or `node bin/t-cli.js`
- **Global installation**: `npm install -g .`
- **Build package**: `npm pack`

## Architecture & Structure

A minimalist, stateless CLI translation tool using DeepSeek API.

- **Entry Point**: `bin/t-cli.js` - Simple wrapper that invokes the REPL.
- **Core Modules** (`src/`):
  - `repl.js`: Main interactive loop using Node's `readline`. Handles command parsing (`/check`, `/lang`, `/mode`, `/history`, `/notes`, etc.), UI rendering with `boxen` and `ora`, and orchestration of API calls.
  - `api.js`: Stateless client for DeepSeek Chat API. Implements manual SSE (Server-Sent Events) parsing for streaming output.
  - `config.js`: Manages persistent user settings (language, mode) in the system's standard configuration directory (`~/.config/t-cli/` or `%APPDATA%/t-cli/`).
  - `prompts.js`: Logic for constructing system prompts based on current language and detail mode. Also exports `getNoteGenPrompt(lang)` for AI note generation.
  - `history.js`: Appends raw translation/grammar-check entries to `~/.config/t-cli/history/YYYY-MM-DD.md`. Powers the `/history` command.
  - `notes.js`: Reads/writes AI-generated learning notes in `~/.config/t-cli/notes/YYYY-MM-DD.md`. Powers the `/notes` command.

## Environment Variables

- `DEEPSEEK_API_KEY`: **Required**. Must be set in the environment or provided via a `.env` file for the tool to function.

## Usage Patterns

- Input text directly for auto-detected translation (ZH ↔ EN).
- Use `/check <text>` for English grammar checking and polishing.
- Toggle between `simple` and `detail` modes via `/mode <s|d>`.
- Switch explanation language via `/lang <en|zh>`.
- Use `/history [today|YYYY-MM-DD]` to browse raw translation/check records.
- Use `/notes [today|YYYY-MM-DD]` to generate (or view) an AI-curated English learning note for that day. Use `/notes regen today` to force regeneration.
