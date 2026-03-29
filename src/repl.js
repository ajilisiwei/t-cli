import readline from 'node:readline';
import process from 'node:process';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { callDeepSeekStream } from './api.js';
import { getTranslatePrompt, getCheckPrompt } from './prompts.js';
import { loadConfig, saveConfig } from './config.js';
import { saveNote, listNotes, readNote, getNotesDir } from './notes.js';

const config = loadConfig();
let currentLang = config.lang;
let isSimpleMode = config.isSimpleMode;

function completer(line) {
  const completions = [
    '/check ',
    '/clear',
    '/lang en',
    '/lang zh',
    '/mode simple',
    '/mode detail',
    '/notes',
    '/notes today',
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
      `  ${chalk.cyan('/notes')}         ${chalk.dim('View your daily learning notes')}`,
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

  function renderNote(date) {
    const content = readNote(date);
    if (!content) {
      console.log(chalk.yellow(`No notes found for ${date}.`));
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

    if (lowerInput === '/notes' || lowerInput.startsWith('/notes ')) {
      const arg = input.slice(6).trim();

      if (arg === '') {
        const entries = listNotes();
        if (entries.length === 0) {
          console.log(chalk.yellow('No notes yet. Start translating to create your first note!'));
          console.log(chalk.dim(`Notes saved to: ${getNotesDir()}`));
        } else {
          console.log(chalk.bold.cyan('\n  Your Learning Notes\n'));
          const today = new Date().toISOString().slice(0, 10);
          for (const { date, count } of entries) {
            const label = date === today
              ? chalk.cyan(date) + chalk.dim(' (today)')
              : chalk.white(date);
            console.log(`  ${label}  ${chalk.dim(`${count} ${count === 1 ? 'entry' : 'entries'}`)}`);
          }
          console.log(chalk.dim(`\n  Use /notes today or /notes <YYYY-MM-DD> to read.\n`));
        }
      } else if (arg === 'today') {
        renderNote(new Date().toISOString().slice(0, 10));
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
        renderNote(arg);
      } else {
        console.log(chalk.yellow('Tip: Use /notes, /notes today, or /notes <YYYY-MM-DD>.'));
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
              spinner.stop(); // Clear spinner when stream starts
              firstChunk = false;
            }
            responseBuffer += chunk;
            process.stdout.write(chalk.green(chunk));
          });

          if (firstChunk) spinner.stop(); // Stop if stream returned nothing
          console.log('\n'); // Add spacing after stream completes
          if (!firstChunk) saveNote('Grammar Check', textToCheck, responseBuffer);
        }
      } else {
        const modeTag = isSimpleMode ? '[Simple]' : `[Lang: ${currentLang}]`;
        const spinner = ora(`Translating ${chalk.dim(modeTag)}...`).start();
        spinner.color = 'yellow';
        
        let firstChunk = true;
        let responseBuffer = '';
        await callDeepSeekStream(getTranslatePrompt(currentLang, isSimpleMode), input, (chunk) => {
          if (firstChunk) {
            spinner.stop(); // Clear spinner when stream starts
            firstChunk = false;
          }
          responseBuffer += chunk;
          process.stdout.write(chalk.yellow(chunk));
        });

        if (firstChunk) spinner.stop(); // Stop if stream returned nothing
        console.log('\n'); // Add spacing after stream completes
        if (!firstChunk) saveNote('Translation', input, responseBuffer);
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
