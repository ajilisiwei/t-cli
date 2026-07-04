import process from 'node:process';
import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { callDeepSeekStream } from './api.js';
import { getTranslatePrompt, getCheckPrompt, getNoteGenPrompt } from './prompts.js';
import { loadConfig, saveConfig } from './config.js';
import { saveHistory, listHistory, readHistory, getHistoryDir } from './history.js';
import { listGeneratedNotes, readGeneratedNote, saveGeneratedNote, getNotesDir } from './notes.js';

const h = React.createElement;

function createIdFactory() {
  let id = 0;
  return () => {
    id += 1;
    return id;
  };
}

const nextId = createIdFactory();

function makeMessage(text, options = {}) {
  return {
    id: nextId(),
    text,
    color: options.color || 'white',
    dim: Boolean(options.dim),
    bold: Boolean(options.bold)
  };
}

function buildWelcomeMessages(lang, isSimpleMode) {
  const modeText = isSimpleMode ? 'simple' : 'detail';
  return [
    makeMessage('t-cli Translator', { color: 'cyan', bold: true }),
    makeMessage('Type any text directly to translate (Auto EN/ZH).', { dim: true }),
    makeMessage(`Current settings: lang=${lang}, mode=${modeText}`, { dim: true }),
    makeMessage('Commands:', { bold: true }),
    makeMessage('/check <text>  Grammar check and polishing', { color: 'green' }),
    makeMessage('/lang <en|zh>  Switch explanation language', { color: 'green' }),
    makeMessage('/mode <s|d>    Toggle output detail mode', { color: 'green' }),
    makeMessage('/history        Browse daily history', { color: 'green' }),
    makeMessage('/notes          Generate or view AI notes', { color: 'green' }),
    makeMessage('/clear          Clear screen', { color: 'green' }),
    makeMessage('exit | quit     Quit application', { color: 'green' })
  ];
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function parseCommandArg(input, commandName) {
  return input.slice(commandName.length).trim();
}

function App() {
  const { exit } = useApp();
  const initialConfig = useMemo(() => loadConfig(), []);

  const [currentLang, setCurrentLang] = useState(initialConfig.lang);
  const [isSimpleMode, setIsSimpleMode] = useState(initialConfig.isSimpleMode);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeStream, setActiveStream] = useState(null);
  const [messages, setMessages] = useState(() => buildWelcomeMessages(initialConfig.lang, initialConfig.isSimpleMode));

  const loadingRef = useRef(false);
  loadingRef.current = isLoading;

  const appendMessage = (text, options = {}) => {
    if (!text) return;
    setMessages((prev) => [...prev, makeMessage(text, options)]);
  };

  const clearOutput = () => {
    setMessages(buildWelcomeMessages(currentLang, isSimpleMode));
    setActiveStream(null);
  };

  const streamAndRender = async ({
    systemPrompt,
    userText,
    streamColor,
    loadingText,
    onCompleted
  }) => {
    setIsLoading(true);
    setActiveStream({ color: streamColor, text: '' });

    if (loadingText) {
      appendMessage(loadingText, { color: 'cyan' });
    }

    let responseBuffer = '';
    try {
      await callDeepSeekStream(systemPrompt, userText, (chunk) => {
        responseBuffer += chunk;
        setActiveStream((prev) => {
          const previous = prev || { color: streamColor, text: '' };
          return { ...previous, text: previous.text + chunk };
        });
      });

      const output = responseBuffer.trim();
      if (output) {
        appendMessage(output, { color: streamColor });
        if (onCompleted) onCompleted(responseBuffer);
      }
    } catch (error) {
      appendMessage(`Error occurred: ${error.message}`, { color: 'red' });
    } finally {
      setActiveStream(null);
      setIsLoading(false);
    }
  };

  const runCheck = async (fullInput) => {
    const textToCheck = fullInput.slice(7).trim();
    if (!textToCheck) {
      appendMessage('Tip: Please enter text after /check.', { color: 'yellow' });
      return;
    }

    await streamAndRender({
      systemPrompt: getCheckPrompt(currentLang, isSimpleMode),
      userText: textToCheck,
      streamColor: 'green',
      loadingText: 'Checking grammar and polishing...',
      onCompleted: (rawResponse) => {
        saveHistory('Grammar Check', textToCheck, rawResponse);
      }
    });
  };

  const runTranslate = async (text) => {
    await streamAndRender({
      systemPrompt: getTranslatePrompt(currentLang, isSimpleMode),
      userText: text,
      streamColor: 'yellow',
      loadingText: 'Translating...',
      onCompleted: (rawResponse) => {
        saveHistory('Translation', text, rawResponse);
      }
    });
  };

  const runHistoryCommand = (fullInput) => {
    const arg = parseCommandArg(fullInput, '/history');

    if (!arg) {
      const entries = listHistory();
      if (entries.length === 0) {
        appendMessage('No history yet. Start translating to create your first record!', { color: 'yellow' });
        appendMessage(`History saved to: ${getHistoryDir()}`, { dim: true });
        return;
      }

      const lines = ['Learning History'];
      const today = todayString();
      for (const { date, count } of entries) {
        const todaySuffix = date === today ? ' (today)' : '';
        const entryText = `${date}${todaySuffix}  ${count} ${count === 1 ? 'entry' : 'entries'}`;
        lines.push(entryText);
      }
      lines.push('Use /history today or /history <YYYY-MM-DD> to read.');
      appendMessage(lines.join('\n'));
      return;
    }

    const date = arg === 'today' ? todayString() : arg;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      appendMessage('Tip: Use /history, /history today, or /history <YYYY-MM-DD>.', { color: 'yellow' });
      return;
    }

    const content = readHistory(date);
    if (!content) {
      appendMessage(`No history found for ${date}.`, { color: 'yellow' });
      return;
    }

    appendMessage(content);
  };

  const runNotesCommand = async (fullInput) => {
    const arg = parseCommandArg(fullInput, '/notes');

    if (!arg) {
      const entries = listGeneratedNotes();
      if (entries.length === 0) {
        appendMessage('No AI notes yet.', { color: 'yellow' });
        appendMessage('Use /notes today to generate your first learning note.', { dim: true });
        appendMessage(`Notes saved to: ${getNotesDir()}`, { dim: true });
        return;
      }

      const lines = ['AI Learning Notes'];
      const today = todayString();
      for (const { date } of entries) {
        lines.push(date === today ? `${date} (today)` : date);
      }
      lines.push('Use /notes today or /notes <YYYY-MM-DD> to read.');
      appendMessage(lines.join('\n'), { color: 'magenta' });
      return;
    }

    let forceRegen = false;
    let dateArg = arg;
    const noteParts = arg.split(/\s+/);
    if (noteParts[0] === 'regen' && noteParts.length > 1) {
      forceRegen = true;
      dateArg = noteParts.slice(1).join(' ');
    }

    if (dateArg === 'today') {
      dateArg = todayString();
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      appendMessage('Tip: Use /notes, /notes today, /notes <YYYY-MM-DD>, or /notes regen today.', { color: 'yellow' });
      return;
    }

    if (!forceRegen) {
      const existing = readGeneratedNote(dateArg);
      if (existing) {
        appendMessage(existing, { color: 'magenta' });
        return;
      }
    }

    const historyContent = readHistory(dateArg);
    if (!historyContent) {
      appendMessage(`No history found for ${dateArg}. Translate something first!`, { color: 'yellow' });
      return;
    }
    if ((historyContent.match(/^## \[/gm) || []).length === 0) {
      appendMessage(`No history entries for ${dateArg} yet.`, { color: 'yellow' });
      return;
    }

    const maxHistoryChars = 12000;
    const historyToUse = historyContent.length > maxHistoryChars
      ? `${historyContent.slice(0, maxHistoryChars)}\n\n[History truncated due to length...]`
      : historyContent;
    const userText = `Date: ${dateArg}\n\n${historyToUse}`;

    await streamAndRender({
      systemPrompt: getNoteGenPrompt(currentLang),
      userText,
      streamColor: 'magenta',
      loadingText: `Generating AI learning note for ${dateArg}...`,
      onCompleted: (rawResponse) => {
        if (rawResponse.trim()) {
          saveGeneratedNote(dateArg, rawResponse);
          appendMessage(`Note saved. Use /notes ${dateArg} to view again.`, { dim: true });
        }
      }
    });
  };

  const handleCommand = async (rawInput) => {
    const inputText = rawInput.trim();
    if (!inputText) return;

    const lowerInput = inputText.toLowerCase();

    if (lowerInput === 'exit' || lowerInput === 'quit') {
      exit();
      return;
    }

    if (lowerInput === '/clear') {
      clearOutput();
      return;
    }

    if (lowerInput.startsWith('/lang ')) {
      const targetLang = lowerInput.slice(6).trim();
      if (targetLang === 'en' || targetLang === 'zh') {
        setCurrentLang(targetLang);
        saveConfig({ lang: targetLang });
        appendMessage(
          targetLang === 'en'
            ? 'Explanation language set to: English.'
            : 'Explanation language set to: Chinese (中文).',
          { color: 'green' }
        );
      } else {
        appendMessage('Tip: Invalid language. Use /lang en or /lang zh.', { color: 'yellow' });
      }
      return;
    }

    if (lowerInput.startsWith('/mode ')) {
      const targetMode = lowerInput.slice(6).trim();
      if (targetMode === 'simple' || targetMode === 's') {
        setIsSimpleMode(true);
        saveConfig({ isSimpleMode: true });
        appendMessage('Mode set to: Simple.', { color: 'green' });
      } else if (targetMode === 'detail' || targetMode === 'd') {
        setIsSimpleMode(false);
        saveConfig({ isSimpleMode: false });
        appendMessage('Mode set to: Detail.', { color: 'green' });
      } else {
        appendMessage('Tip: Invalid mode. Use /mode <s|d>.', { color: 'yellow' });
      }
      return;
    }

    if (lowerInput === '/history' || lowerInput.startsWith('/history ')) {
      runHistoryCommand(inputText);
      return;
    }

    if (lowerInput === '/notes' || lowerInput.startsWith('/notes ')) {
      await runNotesCommand(inputText);
      return;
    }

    if (inputText.startsWith('/check ')) {
      await runCheck(inputText);
      return;
    }

    await runTranslate(inputText);
  };

  const onSubmitInput = (value) => {
    if (loadingRef.current) return;
    setInput('');
    void handleCommand(value);
  };

  const statusMode = isSimpleMode ? 'simple' : 'detail';

  return h(
    Box,
    { flexDirection: 'column' },
    h(Box, { flexDirection: 'column', marginBottom: 1 },
      messages.map((msg) => h(
        Text,
        {
          key: msg.id,
          color: msg.color,
          dimColor: msg.dim,
          bold: msg.bold
        },
        msg.text
      )),
      activeStream ? h(Text, { color: activeStream.color }, activeStream.text) : null
    ),
    h(
      Box,
      { marginBottom: 1 },
      isLoading
        ? h(Text, { color: 'cyan' }, h(Spinner, { type: 'dots' }), ' Processing...')
        : h(Text, { dimColor: true }, `Ready  lang=${currentLang}  mode=${statusMode}`)
    ),
    h(
      Box,
      null,
      h(Text, { color: 'cyan' }, 't-cli > '),
      h(TextInput, {
        value: input,
        onChange: setInput,
        onSubmit: onSubmitInput,
        focus: !isLoading,
        placeholder: isLoading ? 'Please wait...' : 'Type text or command...'
      })
    )
  );
}

export function startRepl() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log('Error: DEEPSEEK_API_KEY environment variable not found!');
    console.log('Please configure your DeepSeek API Key in your environment or .env file.');
    console.log('Example: export DEEPSEEK_API_KEY="sk-xxxxxxxxxxx"');
    process.exit(1);
  }

  render(h(App));
}
