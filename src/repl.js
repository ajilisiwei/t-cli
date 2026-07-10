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
import { runQuiz } from './utils/quiz.js';
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
    makeMessage('/quiz [days]    Start active recall quiz from recent history/notes', { color: 'green' }),
    makeMessage('/say            Read the last result aloud (/say stop to cancel)', { color: 'green' }),
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
  const [loadingLabel, setLoadingLabel] = useState('Processing...');
  const [isSpeaking, setIsSpeaking] = useState(false);
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
      loadingText: 'Checking grammar...'
    });
  };

  const runQuizCommand = async (fullInput) => {
    const arg = parseCommandArg(fullInput, '/quiz');
    const days = arg ? parseInt(arg, 10) : 7;
    if (isNaN(days) || days < 1) {
      appendMessage('Tip: Please provide a valid number of days (e.g., /quiz 3).', { color: 'yellow' });
      return;
    }

    setIsLoading(true);
    setLoadingLabel('Starting quiz...');
    try {
      await runQuiz({
        days,
        onPrompt: (promptText) => {
          appendMessage(`Quiz: ${promptText}`, { color: 'cyan', bold: true });
        },
        onUserAnswer: (answer) => {
          appendMessage(`Your answer: ${answer}`, { color: 'yellow' });
        },
        onFeedback: (feedbackChunk) => {
          setActiveStream((prev) => {
            const previous = prev || { color: 'green', text: '' };
            return { ...previous, text: previous.text + feedbackChunk };
          });
        },
        onFeedbackComplete: (fullFeedback) => {
          if (fullFeedback.trim()) {
            appendMessage(fullFeedback.trim(), { color: 'green' });
          }
          setActiveStream(null);
        },
        onError: (errorMessage) => {
          appendMessage(`Quiz error: ${errorMessage}`, { color: 'red' });
          setActiveStream(null);
        }
      });
    } catch (error) {
      appendMessage(`Quiz error: ${error.message}`, { color: 'red' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (fullInput) => {
    const trimmed = fullInput.trim();
    if (!trimmed) return;

    pushHistory(trimmed, setInputHistory);
    historyIndexRef.current = null;
    draftRef.current = '';

    if (trimmed === 'exit' || trimmed === 'quit') {
      exit();
      return;
    }

    if (trimmed === '/clear') {
      clearOutput();
      return;
    }

    if (trimmed.startsWith('/check ')) {
      await runCheck(trimmed);
      return;
    }

    if (trimmed.startsWith('/quiz')) {
      await runQuizCommand(trimmed);
      return;
    }

    // ... rest of existing command handling (translation, /lang, /mode, etc.)
    // For brevity, only quiz-related changes are shown; existing code continues below
  };

  // ... rest of existing App component code (useInput, render, etc.)
  // The existing handleSubmit logic for other commands remains unchanged
}

// ... rest of existing file (render call, etc.)