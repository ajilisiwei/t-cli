# t-cli Terminal Translator

A minimalist, stateless CLI tool powered by the DeepSeek API for interactive English/Chinese translation and grammar checking. Provides authentic American English translations and revisions.

## Features
1. **Ready to Use**: Launch globally via command, enter dialogue mode instantly.
2. **Auto EN/ZH Translation**: Automatically detects the input language. Translates Chinese into natural American English, and English into fluent Chinese.
3. **Grammar Check (`/check`)**: Points out grammar and phrasing errors in English sentences, providing 2-3 native, authentic alternatives.
4. **Explanation Language Toggle (`/lang`)**: Toggle AI explanations between English (default) and Chinese using `/lang en` or `/lang zh`.
5. **Mode Toggle (`/mode`)**: Switch between detail mode (default) and simple mode (`/mode simple`). Simple mode only outputs the direct translation or correction without any extra explanation.
6. **Clear Screen (`/clear`)**: Instantly clears the terminal output for a fresh view.
7. **Stateless Requests**: No contextual memory between prompts, drastically reducing API token consumption.

## Installation

### Method 1: Global Installation from Local Source (Recommended for Dev)
If you have downloaded the source code, navigate to the project directory and run:
```bash
npm install -g .
```

### Method 2: Offline Installation via Tarball (.tgz)
You can build a standalone package file and share it:
1. In the project directory, run:
```bash
npm pack
```
2. This generates a file like `t-cli-translator-1.0.0.tgz`. Share this file with others.
3. Anyone with Node.js installed can install it globally from the file:
```bash
npm install -g path/to/t-cli-translator-1.0.0.tgz
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
# t-cli
