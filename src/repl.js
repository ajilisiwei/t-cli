import readline from 'node:readline';
import process from 'node:process';
import chalk from 'chalk';
import { callDeepSeekStream } from './api.js';
import { getTranslatePrompt, getCheckPrompt } from './prompts.js';

let currentLang = 'en';
let isSimpleMode = false;

function completer(line) {
  const completions = [
    '/check ',
    '/clear',
    '/lang en',
    '/lang zh',
    '/mode simple',
    '/mode detail',
    'exit',
    'quit'
  ];
  const hits = completions.filter((c) => c.startsWith(line));
  return [hits.length ? hits : [], line];
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: chalk.cyan('t-cli > '),
  completer
});

export function startRepl() {
  const printWelcome = () => {
    console.log(chalk.bold.green('========== t-cli Translator =========='));
    console.log(chalk.gray(' - Type English/Chinese text for automatic EN/ZH translation (American English).'));
    console.log(chalk.gray(' - Type "/check <English sentence>" to check grammar, correct errors, and get native examples.'));
    console.log(chalk.gray(' - Type "/lang en" or "/lang zh" to switch explanation language (Default: en).'));
    console.log(chalk.gray(' - Type "/mode simple" or "/mode detail" to toggle output detail (Default: detail).'));
    console.log(chalk.gray(' - Type "/clear" to clear the terminal screen.'));
    console.log(chalk.gray(' - Type "exit" or "quit" to quit.'));
    console.log(chalk.bold.green('========================================\n'));
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
        console.log(chalk.green('✓ Explanation language set to: English.'));
      } else if (targetLang === 'zh') {
        currentLang = 'zh';
        console.log(chalk.green('✓ 解释说明语言已切换为: 中文.'));
      } else {
        console.log(chalk.yellow('Tip: Invalid language. Use "/lang en" or "/lang zh".'));
      }
      rl.prompt();
      return;
    }

    if (lowerInput.startsWith('/mode ')) {
      const targetMode = lowerInput.slice(6).trim();
      if (targetMode === 'simple') {
        isSimpleMode = true;
        console.log(chalk.green('✓ Mode set to: Simple (Translations/Corrections only).'));
      } else if (targetMode === 'detail') {
        isSimpleMode = false;
        console.log(chalk.green('✓ Mode set to: Detail (Explanations and alternatives enabled).'));
      } else {
        console.log(chalk.yellow('Tip: Invalid mode. Use "/mode simple" or "/mode detail".'));
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
          console.log(chalk.gray(`⏳ Checking grammar and polishing ${modeTag}...\n`));
          await callDeepSeekStream(getCheckPrompt(currentLang, isSimpleMode), textToCheck, (chunk) => {
            process.stdout.write(chalk.green(chunk));
          });
          console.log('\n'); // Add spacing after stream completes
        }
      } else {
        const modeTag = isSimpleMode ? '[Simple]' : `[Lang: ${currentLang}]`;
        console.log(chalk.gray(`⏳ Translating ${modeTag}...\n`));
        await callDeepSeekStream(getTranslatePrompt(currentLang, isSimpleMode), input, (chunk) => {
          process.stdout.write(chalk.yellow(chunk));
        });
        console.log('\n'); // Add spacing after stream completes
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
