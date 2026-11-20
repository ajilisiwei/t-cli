# t-cli Terminal Translator

A minimalist, stateless CLI tool powered by the DeepSeek API for interactive English/Chinese translation and grammar checking. Provides authentic American English translations and revisions.

## Features
1. **Ready to Use**: Launch globally via command, enter dialogue mode instantly.
2. **Auto EN/ZH Translation**: Automatically detects the input language. Translates Chinese into natural American English, and English into fluent Chinese.
3. **Grammar Check (`/check`)**: Points out grammar and phrasing errors in English sentences, providing 2-3 native, authentic alternatives.
4. **Explanation Language Toggle (`/lang`)**: Toggle AI explanations between English (default) and Chinese using `/lang en` or `/lang zh`.
5. **Mode Toggle (`/mode`)**: Switch between detail mode (default) and simple mode (`/mode simple`). Simple mode only outputs the direct translation or correction without any extra explanation.
6. **Word Lookup with IPA**: When the input is a single word or short term, the English result includes its American IPA transcription (e.g. `apple /ˈæp.əl/`).
7. **Text-to-Speech (`/say`)**: Reads the last translation (or the corrected sentence after `/check`) aloud with Microsoft Edge neural voices (`msedge-tts`), falling back to the local `say` command when offline. Use `/say stop` to cancel.
8. **Clear Screen (`/clear`)**: Instantly clears the terminal output for a fresh view.
9. **Stateless Requests**: No contextual memory between prompts, drastically reducing API token consumption.
10. **Input History (`↑`/`↓`)**: Recall previously entered text and commands with the arrow keys, readline-style. Pressing `↓` past the newest entry restores your unsubmitted draft.
11. **Record Sync (`/login`, `/sync`, `/logout`)**: Optionally push every translation / grammar check to your own t-cli sync server (see [Record Sync](#record-sync)).
12. **Review and Learning Material (`/review`, `/notes`, `/weekly`)**: When logged in, review the cards your account generates from your records, read the nightly daily material and the weekly report, and see your phone's records in `/history` (see [Learning](#learning)).

## Installation

The repository is an npm-workspaces monorepo: the CLI lives in `apps/cli`, and shared prompts/detection live in the private `@t-cli/core` package (`packages/core`). Because `@t-cli/core` is not published, install through the release script, which bundles it into the CLI tarball.

### Method 1: Global Installation from Local Source (Recommended for Dev)
From the repository root:
```bash
npm install
npm run release:local                                    # bumps the patch version, installs into ~/.npm-global
node scripts/release-local.mjs --no-bump --prefix <dir>   # or: keep the version, install elsewhere
```

### Method 2: Offline Installation via Tarball (.tgz)
1. From the repository root, build a self-contained tarball (prints its path):
```bash
node scripts/release-local.mjs --no-bump --pack-only
```
2. Anyone with Node.js installed can install it globally from the file:
```bash
npm install -g path/to/t-cli-translator-<version>.tgz
```

### Method 3: Install from npm Registry (Public)
If this package is published to the npm registry, you can install it globally on any machine:
```bash
npm install -g t-cli-translator
```
*(Note: Replace `t-cli-translator` with your actual package name if you change it before publishing).*

## Environment Setup

The tool relies on the DeepSeek API. You MUST obtain a [DeepSeek API Key](https://platform.deepseek.com/).

There are two ways to configure it:

**Option A: System Environment Variable (Highly Recommended)**
Add this to your `~/.bashrc` or `~/.zshrc`:
```bash
export DEEPSEEK_API_KEY="sk-your_api_key_here"
```

**Option B: Using an `.env` file**
Create a `.env` file in the directory where you run the command (or the project root):
```env
DEEPSEEK_API_KEY=sk-your_api_key_here
```

## Usage

Simply run the command in your terminal to enter the interactive translator:
```bash
t-cli
```

### Examples
```text
t-cli > 你好，今天天气真不错。
# 翻译: Hello, the weather is really nice today.

t-cli > This tool is very useful for me.
# 翻译: 这个工具对我来说非常有用。

t-cli > 苹果
# apple /ˈæp.əl/

t-cli > /say
# Reads "apple" aloud. Use /say stop to cancel playback.

t-cli > /check He don't know nothing about the project.
# 语法检查与润色结果:
# 1. 错误分析: "He don't" 语法错误，第三人称单数应使用 doesn't。"don't know nothing" 属于双重否定，在标准英语中不正确。
# 2. 修改建议: He doesn't know anything about the project.
# 3. 更好的地道表达:
#   - He's completely clueless about the project.
#   - He knows absolutely nothing about the project.

t-cli > exit
# Goodbye!
```

To quit the tool: Type `exit`, `quit`, or press `Ctrl+C`.

## Record Sync

Every result is also appended to a local outbox (`~/.config/t-cli/outbox.jsonl`). When a sync server is configured and this CLI is logged in, the outbox is pushed to the server in the background (after each result, at startup, and on `/sync now`); acknowledged entries leave the outbox, entries the server rejects for good are moved to `outbox.rejected.jsonl`. Sync never blocks translating, and failures are retried with backoff (up to 5 min) and shown only by `/sync status`.

Sync is off until a server URL is set, either as an environment variable (or in `.env`):
```bash
export TCLI_SERVER_URL="https://your-sync-server"
```
or as `"serverUrl": "https://your-sync-server"` in `~/.config/t-cli/config.json` (the environment variable wins).

| Command | What it does |
| --- | --- |
| `/login` | Shows a 6-digit code and a QR code. Approve it in the mini-program (我的 → 授权 CLI); until that ships, the server admin runs `npm run admin -w @t-cli/server -- approve-device <code> <userId>`. Polling runs in the background; keep using t-cli meanwhile. `/login cancel` aborts. |
| `/logout` | Revokes this device on the server (best effort) and deletes `~/.config/t-cli/auth.json`. |
| `/sync status` (or `/sync`) | Server URL, logged-in user/device, pending and rejected counts, last push result, next retry. |
| `/sync now` | Push immediately (skips any backoff wait). |

Credentials live in `~/.config/t-cli/auth.json` (mode `0600`, honours `XDG_CONFIG_HOME`); tokens are only ever sent to the server they were issued by.

## Learning

These commands use your account on the sync server (`/login` first). The server turns your records into learning items and review cards every night, and writes a daily material for the previous day and, on Sundays, a weekly report.

| Command | What it does |
| --- | --- |
| `/review` | Reviews the cards due now. The card front is shown; `Enter` or `space` flips it; `1` 忘记 · `2` 困难 · `3` 记得 · `4` 简单 rate it (the status line shows each option's next interval, e.g. `10 分钟`, `3 天`, `2 个月`); `u` undoes the last rating (within 5 minutes); `q` ends. The end summary shows cards reviewed, the share remembered (rated 2–4) and the time. While reviewing, keys go to the card, not to the input box. |
| `/notes [today\|YYYY-MM-DD]` | Shows that day's daily material from your account (words, phrases, grammar, a short story, mistakes). With no cloud material for the day, offline or logged out, it falls back to the local AI note (generated from that day's local history). `/notes regen <date>` always regenerates the local note; `/notes` lists both. |
| `/weekly [YYYY-MM-DD]` | Shows the latest weekly report, or the report of the week containing that date. |
| `/history <date>` | Also shows that day's mini-program records, merged by time and marked `(phone)`. |
| `/lang <en\|zh>` | Also saves the explanation language to your account. At startup the account's value is applied; a change made offline stays local and is sent on the next start. |

Each rating is sent as soon as you make it. Ratings that cannot be sent (offline) are retried when the review ends; any still unsent are kept in memory and retried at the next `/review` while t-cli stays open.

# t-cli
