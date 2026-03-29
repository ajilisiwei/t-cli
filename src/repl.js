import readline from 'node:readline';
import process from 'node:process';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { callDeepSeekStream } from './api.js';
import { getTranslatePrompt, getCheckPrompt, getNoteGenPrompt } from './prompts.js';
import { loadConfig, saveConfig } from './config.js';
import { saveHistory, listHistory, readHistory, getHistoryDir } from './history.js';
import { listGeneratedNotes, readGeneratedNote, saveGeneratedNote, getNotesDir } from './notes.js';

const config = loadConfig();
let currentLang = config.lang;
let isSimpleMode = config.isSimpleMode;

function completer(line) {
  const completions = [
    '/check ',
    '/clear',
    '/history',
    '/history today',
    '/lang en',
    '/lang zh',
    '/mode simple',
    '/mode detail',
    '/notes',
    '/notes today',
    '/notes regen today',
    'exit',
    'quit'
  ];
  const hits = completions.filter((c) => c.startsWith(line));
  return [hits.length ? hits : [], line];
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: chalk.cyan('t-cli ❯ '),
  completer
});

export function startRepl() {
  const printWelcome = () => {
    const title = chalk.bold.cyan('✨ t-cli Translator');
    
    const lines = [
      title,
      '',
      chalk.dim('Type any text directly to translate (Auto EN/ZH)'),
      '',
      chalk.bold('Commands'),
      `  ${chalk.cyan('/check <text>')}  ${chalk.dim('Grammar check & native examples')}`,
      `  ${chalk.cyan('/lang <en|zh>')}  ${chalk.dim(`Switch explanation lang (Current: ${currentLang})`)}`,
      `  ${chalk.cyan('/mode <s|d>')}    ${chalk.dim(`Toggle output detail (Current: ${isSimpleMode ? 'simple' : 'detail'})`)}`,
      `  ${chalk.cyan('/history')}       ${chalk.dim('Browse raw daily learning history')}`,
      `  ${chalk.cyan('/notes')}         ${chalk.dim('Generate AI learning notes from history')}`,
      `  ${chalk.cyan('/clear')}         ${chalk.dim('Clear terminal screen')}`,
      `  ${chalk.cyan('exit')}           ${chalk.dim('Quit the application')}`
    ].join('\n');

    const welcomeBox = boxen(lines, {
      padding: 1,
      margin: { top: 1, bottom: 1 },
      borderStyle: 'round',
      borderColor: 'gray',
      align: 'left'
    });

    console.log(welcomeBox);
  };

  printWelcome();
  
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log(chalk.red.bold('Error: DEEPSEEK_API_KEY environment variable not found!'));
    console.log(chalk.yellow('Please configure your DeepSeek API Key in your environment or .env file.'));
    console.log(chalk.yellow('Example: export DEEPSEEK_API_KEY="sk-xxxxxxxxxxx"'));
    process.exit(1);
  }

  rl.prompt();

  function renderHistory(date) {
    const content = readHistory(date);
    if (!content) {
      console.log(chalk.yellow(`No history found for ${date}.`));
      return;
    }
    for (const line of content.split('\n')) {
      if (line.startsWith('# ')) {
        console.log(chalk.bold.cyan('\n' + line.slice(2)));
      } else if (line.startsWith('## ')) {
        console.log(chalk.bold('\n' + line.slice(3)));
      } else if (line.startsWith('**Input:**')) {
        console.log(chalk.dim(line.replace('**Input:**', 'Input:')));
      } else if (line === '---') {
        console.log(chalk.dim('─'.repeat(44)));
      } else {
        console.log(chalk.white(line));
      }
    }
    console.log('');
  }

  function renderGeneratedNote(content) {
    console.log('');
    for (const line of content.split('\n')) {
      if (line.startsWith('# ')) {
        console.log(chalk.bold.magenta(line.slice(2)));
      } else if (line.startsWith('## ')) {
        console.log(chalk.bold.cyan('\n' + line.slice(3)));
      } else if (line.startsWith('- **') || line.startsWith('* **')) {
        const highlighted = line.replace(/\*\*(.+?)\*\*/g, (_, term) => chalk.yellow(term));
        console.log(chalk.white(highlighted));
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        console.log(chalk.white(line));
      } else if (line === '---') {
        console.log(chalk.dim('─'.repeat(44)));
      } else if (line.startsWith('*Generated')) {
        console.log(chalk.dim(line.replace(/\*/g, '')));
      } else {
        console.log(chalk.white(line));
      }
    }
    console.log('');
  }

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const lowerInput = input.toLowerCase();
    if (lowerInput === 'exit' || lowerInput === 'quit') {
      console.log(chalk.green('Goodbye!'));
      process.exit(0);
    }

    if (lowerInput === '/clear') {
      console.clear();
      printWelcome();
      rl.prompt();
      return;
    }

    if (lowerInput.startsWith('/lang ')) {
      const targetLang = lowerInput.slice(6).trim();
      if (targetLang === 'en') {
        currentLang = 'en';
        saveConfig({ lang: 'en' });
        console.log(chalk.green('✓ Explanation language set to: English.'));
      } else if (targetLang === 'zh') {
        currentLang = 'zh';
        saveConfig({ lang: 'zh' });
        console.log(chalk.green('✓ 解释说明语言已切换为: 中文.'));
      } else {
        console.log(chalk.yellow('Tip: Invalid language. Use "/lang en" or "/lang zh".'));
      }
      rl.prompt();
      return;
    }

    if (lowerInput.startsWith('/mode ')) {
      const targetMode = lowerInput.slice(6).trim();
      if (targetMode === 'simple' || targetMode === 's') {
        isSimpleMode = true;
        saveConfig({ isSimpleMode: true });
        console.log(chalk.green('✓ Mode set to: Simple (Translations/Corrections only).'));
      } else if (targetMode === 'detail' || targetMode === 'd') {
        isSimpleMode = false;
        saveConfig({ isSimpleMode: false });
        console.log(chalk.green('✓ Mode set to: Detail (Explanations and alternatives enabled).'));
      } else {
        console.log(chalk.yellow('Tip: Invalid mode. Use "/mode <s|d>".'));
      }
      rl.prompt();
      return;
    }

    if (lowerInput === '/history' || lowerInput.startsWith('/history ')) {
      const parts = input.split(/\s+/);
      const arg = parts.length > 1 ? parts.slice(1).join(' ') : '';

      if (arg === '') {
        const entries = listHistory();
        if (entries.length === 0) {
          console.log(chalk.yellow('No history yet. Start translating to create your first record!'));
          console.log(chalk.dim(`History saved to: ${getHistoryDir()}`));
        } else {
          console.log(chalk.bold.cyan('\n  Learning History\n'));
          const today = new Date().toISOString().slice(0, 10);
          for (const { date, count } of entries) {
            const label = date === today
              ? chalk.cyan(date) + chalk.dim(' (today)')
              : chalk.white(date);
            console.log(`  ${label}  ${chalk.dim(`${count} ${count === 1 ? 'entry' : 'entries'}`)}`);
          }
          console.log(chalk.dim(`\n  Use /history today or /history <YYYY-MM-DD> to read.\n`));
        }
      } else if (arg === 'today') {
        renderHistory(new Date().toISOString().slice(0, 10));
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
        renderHistory(arg);
      } else {
        console.log(chalk.yellow('Tip: Use /history, /history today, or /history <YYYY-MM-DD>.'));
      }

      rl.prompt();
      return;
    }

    if (lowerInput === '/notes' || lowerInput.startsWith('/notes ')) {
      const parts = input.split(/\s+/);
      const arg = parts.length > 1 ? parts.slice(1).join(' ') : '';

      if (arg === '') {
        // List all generated notes
        const entries = listGeneratedNotes();
        if (entries.length === 0) {
          console.log(chalk.yellow('No AI notes yet.'));
          console.log(chalk.dim('Use /notes today to generate your first learning note.'));
          console.log(chalk.dim(`Notes saved to: ${getNotesDir()}`));
        } else {
          console.log(chalk.bold.magenta('\n  AI Learning Notes\n'));
          const today = new Date().toISOString().slice(0, 10);
          for (const { date } of entries) {
            const label = date === today
              ? chalk.cyan(date) + chalk.dim(' (today)')
              : chalk.white(date);
            console.log(`  ${label}`);
          }
          console.log(chalk.dim('\n  Use /notes today or /notes <YYYY-MM-DD> to read.\n'));
        }
        rl.prompt();
        return;
      }

      // Parse regen flag
      let forceRegen = false;
      let dateArg = arg;
      const subParts = arg.split(/\s+/);
      if (subParts[0] === 'regen' && subParts.length > 1) {
        forceRegen = true;
        dateArg = subParts.slice(1).join(' ');
      } else {
        dateArg = arg;
      }

      // Resolve 'today'
      const today = new Date().toISOString().slice(0, 10);
      if (dateArg === 'today') dateArg = today;

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
        console.log(chalk.yellow('Tip: Use /notes, /notes today, /notes <YYYY-MM-DD>, or /notes regen today.'));
        rl.prompt();
        return;
      }

      // If not forcing regen, show existing note
      if (!forceRegen) {
        const existing = readGeneratedNote(dateArg);
        if (existing) {
          renderGeneratedNote(existing);
          rl.prompt();
          return;
        }
      }

      // Check history exists and has entries
      const historyContent = readHistory(dateArg);
      if (!historyContent) {
        console.log(chalk.yellow(`No history found for ${dateArg}. Translate something first!`));
        rl.prompt();
        return;
      }
      if ((historyContent.match(/^## \[/gm) || []).length === 0) {
        console.log(chalk.yellow(`No history entries for ${dateArg} yet.`));
        rl.prompt();
        return;
      }

      // Generate via LLM
      try {
        const spinner = ora(`Generating AI learning note for ${chalk.cyan(dateArg)}...`).start();
        spinner.color = 'magenta';

        let firstChunk = true;
        let noteBuffer = '';

        // Truncate history to prevent exceeding API context limits
        const maxHistoryChars = 12000;
        let historyToUse = historyContent;
        if (historyContent.length > maxHistoryChars) {
          historyToUse = historyContent.slice(0, maxHistoryChars) +
            '\n\n[History truncated due to length...]';
        }

        const userText = `Date: ${dateArg}\n\n${historyToUse}`;

        await callDeepSeekStream(getNoteGenPrompt(currentLang), userText, (chunk) => {
          if (firstChunk) {
            spinner.stop();
            console.log(chalk.bold.magenta(`\n  AI Learning Note — ${dateArg}\n`));
            firstChunk = false;
          }
          noteBuffer += chunk;
          process.stdout.write(chalk.white(chunk));
        });

        if (firstChunk) spinner.stop();
        console.log('\n');

        if (noteBuffer) {
          saveGeneratedNote(dateArg, noteBuffer);
          console.log(chalk.dim(`  Note saved. Use /notes ${dateArg} to view again.\n`));
        }
      } catch (error) {
        console.log(chalk.red.bold('\nError generating note: ') + chalk.red(error.message) + '\n');
      }

      rl.prompt();
      return;
    }

    try {
      if (input.startsWith('/check ')) {
        const textToCheck = input.slice(7).trim();
        if (!textToCheck) {
          console.log(chalk.yellow('Tip: Please enter the English sentence you want to check after /check.'));
        } else {
          const modeTag = isSimpleMode ? '[Simple]' : `[Lang: ${currentLang}]`;
          const spinner = ora(`Checking grammar and polishing ${chalk.dim(modeTag)}...`).start();
          spinner.color = 'cyan';

          let firstChunk = true;
          let responseBuffer = '';
          await callDeepSeekStream(getCheckPrompt(currentLang, isSimpleMode), textToCheck, (chunk) => {
            if (firstChunk) {
              spinner.stop();
              console.log();
              firstChunk = false;
            }
            responseBuffer += chunk;
            process.stdout.write(chalk.green(chunk));
          });

          if (firstChunk) spinner.stop();
          console.log('\n');
          if (!firstChunk) saveHistory('Grammar Check', textToCheck, responseBuffer);
        }
      } else {
        const modeTag = isSimpleMode ? '[Simple]' : `[Lang: ${currentLang}]`;
        const spinner = ora(`Translating ${chalk.dim(modeTag)}...`).start();
        spinner.color = 'yellow';

        let firstChunk = true;
        let responseBuffer = '';
        await callDeepSeekStream(getTranslatePrompt(currentLang, isSimpleMode), input, (chunk) => {
          if (firstChunk) {
            spinner.stop();
            console.log();
            firstChunk = false;
          }
          responseBuffer += chunk;
          process.stdout.write(chalk.yellow(chunk));
        });

        if (firstChunk) spinner.stop();
        console.log('\n');
        if (!firstChunk) saveHistory('Translation', input, responseBuffer);
      }
    } catch (error) {
      console.log(chalk.red.bold('\nError occurred: ') + chalk.red(error.message) + '\n');
    }

    rl.prompt();
  }).on('close', () => {
    console.log(chalk.green('\nGoodbye!'));
    process.exit(0);
  });
}
