import process from 'node:process';
import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { callDeepSeekStream } from './api.js';
import { getTranslatePrompt, getCheckPrompt, getNoteGenPrompt, buildSourceMessage } from './prompts.js';
import { loadConfig, saveConfig } from './config.js';
import { saveHistory, listHistory, readHistory, getHistoryDir } from './history.js';
import { listGeneratedNotes, readGeneratedNote, saveGeneratedNote, getNotesDir } from './notes.js';
import { isWordLookup } from './utils/detect.js';
import { extractSpeakable } from './utils/speakable.js';
import { pushHistory, navigateHistory } from './utils/inputHistory.js';
import { getQuizEntries, parseQuizResponse } from './utils/quiz.js';
import * as tts from './tts.js';

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
    makeMessage('/say            Read the last result aloud (/say stop to cancel)', { color: 'green' }),
    makeMessage('/clear          Clear screen', { color: 'green' }),
    makeMessage('/quiz [days]    Active recall quiz from recent history', { color: 'green' }),
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
  const [loadingLabel, setLoadingLabel] = useState('Processing...');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [quizState, setQuizState] = useState(null);
  const [activeStream, setActiveStream] = useState(null);
  const [inputHistory, setInputHistory] = useState([]);
  const [inputEpoch, setInputEpoch] = useState(0);
  const lastSpeakableRef = useRef(null);
  const historyIndexRef = useRef(null);
  const draftRef = useRef('');
  const [messages, setMessages] = useState(() => buildWelcomeMessages(initialConfig.lang, initialConfig.isSimpleMode));

  const loadingRef = useRef(false);
  loadingRef.current = isLoading;

  const appendMessage = (text, options = {}) => {
    if (!text) return;
    setMessages((prev) => [...prev, makeMessage(text, options)]);
    if (quizState) setQuizState((prev) => prev ? { ...prev, awaitingAnswer: false } : null);
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
    setLoadingLabel(loadingText || 'Processing...');
    setActiveStream({ color: streamColor, text: '' });

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
      userText: buildSourceMessage(textToCheck, 'check'),
      streamColor: 'green',
      loadingText: 'Checking grammar and polishing...',
      onCompleted: (rawResponse) => {
        // Detail-mode check output starts with analysis prose, not the
        // corrected sentence, so only simple mode is speakable.
        if (isSimpleMode) {
          lastSpeakableRef.current = extractSpeakable(rawResponse, true);
        }
        saveHistory('Grammar Check', textToCheck, rawResponse);
      }
    });
  };

  const runTranslate = async (text) => {
    const wordLookup = isWordLookup(text);
    await streamAndRender({
      systemPrompt: getTranslatePrompt(currentLang, isSimpleMode, wordLookup),
      userText: buildSourceMessage(text, 'translate'),
      streamColor: 'yellow',
      loadingText: wordLookup ? 'Looking up word...' : 'Translating...',
      onCompleted: (rawResponse) => {
        lastSpeakableRef.current = extractSpeakable(rawResponse, isSimpleMode);
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

  const runQuizCommand = async (fullInput) => {
    const arg = parseCommandArg(fullInput, '/quiz');
    const daysBack = arg ? parseInt(arg, 10) : 7;
    if (Number.isNaN(daysBack) || daysBack < 1) {
      appendMessage('Tip: Use /quiz [days] where days is a positive number (default 7).', { color: 'yellow' });
      return;
    }

    const entries = await getQuizEntries(daysBack);
    if (entries.length === 0) {
      appendMessage('No history entries found for the given period. Translate something first!', { color: 'yellow' });
      return;
    }

    appendMessage(`Starting quiz with ${entries.length} entries. Type your answers after each question.`, { color: 'cyan' });
    setQuizState({
      entries,
      index: 0,
      score: 0,
      total: entries.length,
      awaitingAnswer: false,
      currentQuestion: null,
      userAnswer: ''
    });
    await presentQuizQuestion(entries[0], 0, entries.length);
  };

  const presentQuizQuestion = (entry, index, total) => {
    // The source text IS the question — recall its translation. No LLM call needed.
    appendMessage(`Q${index + 1}/${total} — Recall the translation for:`, { color: 'cyan', bold: true });
    appendMessage(entry.source, { color: 'cyan' });
    setQuizState((prev) => prev ? { ...prev, currentQuestion: entry.source, awaitingAnswer: true, userAnswer: '' } : null);
  };

  const handleQuizAnswer = async (answer) => {
    const state = quizState;
    if (!state || !state.awaitingAnswer) return;

    const entry = state.entries[state.index];
    const scoringPrompt = `You are a translation quiz scorer.\nSource text: ${entry.source}\nExpected translation: ${entry.target}\nThe user answered: "${answer}"\n\nReply ONLY with a JSON object: {"correct": true or false, "explanation": "one short sentence"}`;

    setIsLoading(true);
    setLoadingLabel('Scoring answer...');

    let responseBuffer = '';
    try {
      await callDeepSeekStream(scoringPrompt, '', (chunk) => {
        responseBuffer += chunk;
      });

      const result = parseQuizResponse(responseBuffer);
      const newScore = state.score + (result.correct ? 1 : 0);
      appendMessage(result.correct ? '✓ Correct!' : `✗ Incorrect. Expected: ${entry.target}`, { color: result.correct ? 'green' : 'red' });
      if (result.explanation) appendMessage(result.explanation, { dim: true });

      const nextIndex = state.index + 1;
      if (nextIndex >= state.total) {
        appendMessage(`Quiz complete! Score: ${newScore}/${state.total}`, { color: 'cyan', bold: true });
        setQuizState(null);
      } else {
        setQuizState((prev) => prev ? { ...prev, index: nextIndex, score: newScore, awaitingAnswer: false } : null);
        await presentQuizQuestion(state.entries[nextIndex], nextIndex, state.total);
      }
    } catch (error) {
      appendMessage(`Scoring error: ${error.message}`, { color: 'red' });
      setQuizState(null);
    } finally {
      setIsLoading(false);
    }
  };

  const runSayCommand = async (fullInput) => {
    const arg = parseCommandArg(fullInput, '/say');

    if (arg === 'stop') {
      tts.stop();
      setIsSpeaking(false);
      return;
    }

    if (arg) {
      appendMessage('Tip: Use /say to read the last result, /say stop to cancel.', { color: 'yellow' });
      return;
    }

    const text = lastSpeakableRef.current;
    if (!text) {
      appendMessage('Nothing to read yet. Translate something first!', { color: 'yellow' });
      return;
    }

    setIsSpeaking(true);
    try {
      await tts.speak(text, {
        onWarn: (message) => appendMessage(message, { color: 'yellow' })
      });
    } catch (error) {
      appendMessage(`Speech failed: ${error.message}`, { color: 'red' });
    } finally {
      if (!tts.isSpeaking()) {
        setIsSpeaking(false);
      }
    }
  };

  const handleCommand = async (rawInput) => {
    const inputText = rawInput.trim();
    if (!inputText) return;

    appendMessage(`t-cli > ${inputText}`, { dim: true });

    const lowerInput = inputText.toLowerCase();

    if (lowerInput === 'exit' || lowerInput === 'quit') {
      tts.stop();
      exit();
      return;
    }

    if (lowerInput === '/quiz' || lowerInput.startsWith('/quiz ')) {
      await runQuizCommand(inputText);
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

    if (lowerInput === '/say' || lowerInput.startsWith('/say ')) {
      await runSayCommand(inputText);
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
    if (quizState && quizState.awaitingAnswer) {
      setInputHistory((prev) => pushHistory(prev, value));
      setInput('');
      void handleQuizAnswer(value);
      return;
    }
    if (loadingRef.current) return;
    setInputHistory((prev) => pushHistory(prev, value));
    historyIndexRef.current = null;
    draftRef.current = '';
    setInput('');
    void handleCommand(value);
  };

  const onChangeInput = (value) => {
    // Typing starts a fresh draft; the next up-arrow resumes from the newest entry.
    historyIndexRef.current = null;
    setInput(value);
  };

  useInput((_char, key) => {
    if (loadingRef.current) return;
    if (!key.upArrow && !key.downArrow) return;
    if (key.upArrow && historyIndexRef.current === null) {
      draftRef.current = input;
    }
    const move = navigateHistory(
      inputHistory,
      historyIndexRef.current,
      key.upArrow ? 'up' : 'down',
      draftRef.current
    );
    if (!move) return;
    historyIndexRef.current = move.index;
    setInput(move.text);
    // Remount TextInput so its internal cursor lands at the end of the recalled text.
    setInputEpoch((prev) => prev + 1);
  });

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
        ? h(Text, { color: 'cyan' }, h(Spinner, { type: 'dots' }), ` ${loadingLabel}`)
        : isSpeaking
          ? h(Text, { color: 'magenta' }, '🔊 Speaking... (/say stop to cancel)')
          : h(Text, { dimColor: true }, `Ready  lang=${currentLang}  mode=${statusMode}`)
    ),
    h(
      Box,
      null,
      h(Text, { color: 'cyan' }, 't-cli > '),
      h(TextInput, {
        key: `history-${inputEpoch}`,
        value: input,
        onChange: onChangeInput,
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
