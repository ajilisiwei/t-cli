import process from 'node:process';
import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { callDeepSeekStream } from './api.js';
import { getTranslatePrompt, getCheckPrompt, getNoteGenPrompt, buildSourceMessage } from '@t-cli/core/prompts';
import { loadConfig, saveConfig } from './config.js';
import { saveHistory as writeHistoryFile, listHistory, readHistory, getHistoryDir } from './history.js';
import { recordLiveEntry } from './entryLog.js';
import { listGeneratedNotes, readGeneratedNote, saveGeneratedNote, getNotesDir } from './notes.js';
import { isWordLookup, detectSourceLang } from '@t-cli/core/detect';
import { extractSpeakable } from '@t-cli/core/speakable';
import { detectSpellingCorrection } from '@t-cli/core/spelling';
import { pushHistory, navigateHistory } from './utils/inputHistory.js';
import { localDateString } from './utils/localDate.js';
import { getQuizEntries, parseQuizResponse } from './utils/quiz.js';
import { useSync } from './sync/useSync.js';
import { useReview } from './sync/useReview.js';
import { useSettingsSync } from './sync/useSettingsSync.js';
import { createLearningCommands } from './sync/learningCommands.js';
import { createNotebookCommands } from './sync/notebookCommands.js';
import { mergeDayHistory } from './utils/historyMerge.js';
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
    makeMessage('/history        Browse daily history (logged in: plus phone records)', { color: 'green' }),
    makeMessage('/notes          Daily material from your account, or a local AI note', { color: 'green' }),
    makeMessage('/review         Review your due cards (Enter/space flip, 1-4 rate, u undo, q quit)', { color: 'green' }),
    makeMessage('/weekly [date]  Weekly report (latest, or the week of a date)', { color: 'green' }),
    makeMessage('/note [1-4]     Save the last result to your notebook (stars, default 1)', { color: 'green' }),
    makeMessage('/notebook [kind] Your notebook, newest first (kind: word, phrase, sentence)', { color: 'green' }),
    makeMessage('/say            Read the last result aloud (/say stop to cancel)', { color: 'green' }),
    makeMessage('/clear          Clear screen', { color: 'green' }),
    makeMessage('/quiz [days]    Active recall quiz from recent history', { color: 'green' }),
    makeMessage('/login          Link this CLI to your account (/login cancel to abort)', { color: 'green' }),
    makeMessage('/logout         Unlink this CLI', { color: 'green' }),
    makeMessage('/sync [now]     Sync status (/sync now to push immediately)', { color: 'green' }),
    makeMessage('exit | quit     Quit application', { color: 'green' })
  ];
}

// Local date, the same calendar history/notes files are named by.
function todayString() {
  return localDateString();
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
  // The last translation / check, for /note (see utils/noteDraft.js LastResult).
  const lastResultRef = useRef(null);
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

  // Messages from background work (sync, login polling). Unlike appendMessage
  // it leaves quiz state alone, so a notice never swallows a pending answer.
  const appendNotice = (text, options = {}) => {
    if (!text) return;
    setMessages((prev) => [...prev, makeMessage(text, options)]);
  };

  const sync = useSync({ notify: appendNotice });
  const review = useReview({ client: sync.client, server: sync.server, notify: appendNotice });

  const langRef = useRef(currentLang);
  langRef.current = currentLang;
  const settingsSync = useSettingsSync({
    client: sync.client,
    loggedIn: sync.loggedIn,
    getLang: () => langRef.current,
    applyLang: (lang) => {
      setCurrentLang(lang);
      saveConfig({ lang });
      appendNotice(`Explanation language set to ${lang === 'zh' ? 'Chinese (中文)' : 'English'} from your account settings.`, { dim: true });
    }
  });

  // Spinner + blocked input while a request runs (cloud material, queue, ...).
  const withLoading = async (label, task) => {
    loadingRef.current = true;
    setIsLoading(true);
    setLoadingLabel(label);
    try {
      return await task();
    } finally {
      setIsLoading(false);
    }
  };

  // /weekly, the cloud side of /notes and the phone records of /history.
  const learning = createLearningCommands({
    client: sync.client,
    server: sync.server,
    say: appendMessage,
    withLoading,
    today: todayString
  });

  // /note and /notebook (the notebook lives in the account).
  const notebook = createNotebookCommands({
    client: sync.client,
    server: sync.server,
    say: appendMessage,
    withLoading
  });

  const clearOutput = () => {
    setMessages(buildWelcomeMessages(currentLang, isSimpleMode));
    setActiveStream(null);
  };

  // Markdown history (history/YYYY-MM-DD.md). A failed write must not break
  // the translation flow; it is shown in the log, never via stdout/stderr.
  const saveHistory = (type, text, rawResponse) => {
    const result = writeHistoryFile(type, text, rawResponse);
    if (!result.ok) {
      appendMessage(`Warning: failed to save history (${result.error}).`, { color: 'yellow' });
    }
  };

  // Structured record for sync (outbox.jsonl). A failure must not break the
  // translation flow, so it is surfaced once per session, never via stdout.
  // A successful write triggers a background push (no-op when sync is off).
  // Returns the new record's id, or null when it was not written.
  const entryLogWarnedRef = useRef(false);
  const recordEntry = (fields) => {
    const result = recordLiveEntry({ ...fields, mode: isSimpleMode ? 'simple' : 'detail' });
    if (result.ok) {
      sync.notifyRecorded();
      return result.entryId;
    }
    if (!entryLogWarnedRef.current) {
      entryLogWarnedRef.current = true;
      appendMessage(`Warning: failed to write structured log (${result.error}). Markdown history is unaffected.`, { color: 'yellow' });
    }
    return null;
  };

  // Remember a finished result for /note; a new result starts a new note.
  const rememberResult = (fields, entryId) => {
    lastResultRef.current = { ...fields, simple: isSimpleMode, entryId, noteId: null, stars: null };
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
        // Both modes put the corrected text first (detail mode: alone on line 1).
        lastSpeakableRef.current = extractSpeakable(rawResponse, isSimpleMode);
        saveHistory('Grammar Check', textToCheck, rawResponse);
        const fields = { task: 'check', input: textToCheck, output: rawResponse, srcLang: 'en' };
        rememberResult(fields, recordEntry(fields));
      }
    });
  };

  const runTranslate = async (text) => {
    const wordLookup = isWordLookup(text);
    const sourceLang = detectSourceLang(text);
    await streamAndRender({
      systemPrompt: getTranslatePrompt(currentLang, isSimpleMode, wordLookup, sourceLang),
      userText: buildSourceMessage(text, 'translate'),
      streamColor: 'yellow',
      loadingText: wordLookup ? 'Looking up word...' : 'Translating...',
      onCompleted: (rawResponse) => {
        lastSpeakableRef.current = extractSpeakable(rawResponse, isSimpleMode);
        const correction = wordLookup
          ? detectSpellingCorrection({ input: text, output: rawResponse, srcLang: sourceLang, kind: 'word' })
          : null;
        if (correction) {
          const label = currentLang === 'zh' ? '拼写更正' : 'Spelling corrected';
          appendMessage(`${label}: ${text.trim()} → ${correction}`, { color: 'cyan' });
        }
        saveHistory('Translation', text, rawResponse);
        const fields = { task: 'translate', input: text, output: rawResponse, srcLang: sourceLang };
        rememberResult(fields, recordEntry(fields));
      }
    });
  };

  const runHistoryCommand = async (fullInput) => {
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
    const phone = await learning.loadPhoneRecords(date);
    if (phone.length > 0) {
      appendMessage(mergeDayHistory({ date, localContent: content, remoteEntries: phone }).text);
      return;
    }
    if (!content) {
      appendMessage(`No history found for ${date}.`, { color: 'yellow' });
      return;
    }

    appendMessage(content);
  };

  const runNotesCommand = async (fullInput) => {
    const arg = parseCommandArg(fullInput, '/notes');

    if (!arg) {
      await learning.listDailyMaterials();
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

    if (!forceRegen && await learning.showDailyMaterial(dateArg)) {
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
          const saved = saveGeneratedNote(dateArg, rawResponse);
          if (saved.ok) {
            appendMessage(`Note saved. Use /notes ${dateArg} to view again.`, { dim: true });
          } else {
            appendMessage(`Warning: failed to save note (${saved.error}).`, { color: 'yellow' });
          }
        }
      }
    });
  };

  const runNoteCommand = async (fullInput) => {
    const target = lastResultRef.current;
    const next = await notebook.runNote(parseCommandArg(fullInput, '/note'), target);
    // Input is blocked while the save runs, but never overwrite a newer result.
    if (lastResultRef.current === target) lastResultRef.current = next;
  };

  const runReviewCommand = async (fullInput) => {
    if (parseCommandArg(fullInput, '/review')) {
      appendMessage('Tip: Use /review. Keys: Enter/space flip, 1-4 rate, u undo, q quit.', { color: 'yellow' });
      return;
    }
    await withLoading('Loading review queue...', () => review.start());
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
        settingsSync.pushLang(targetLang);
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
      await runHistoryCommand(inputText);
      return;
    }

    if (lowerInput === '/review' || lowerInput.startsWith('/review ')) {
      await runReviewCommand(inputText);
      return;
    }

    if (lowerInput === '/weekly' || lowerInput.startsWith('/weekly ')) {
      await learning.runWeekly(parseCommandArg(inputText, '/weekly'));
      return;
    }

    if (lowerInput === '/notes' || lowerInput.startsWith('/notes ')) {
      await runNotesCommand(inputText);
      return;
    }

    if (lowerInput === '/note' || lowerInput.startsWith('/note ')) {
      await runNoteCommand(inputText);
      return;
    }

    if (lowerInput === '/notebook' || lowerInput.startsWith('/notebook ')) {
      await notebook.runNotebook(parseCommandArg(inputText, '/notebook'));
      return;
    }

    if (lowerInput === '/login' || lowerInput.startsWith('/login ')) {
      await sync.runLogin(parseCommandArg(lowerInput, '/login'));
      return;
    }

    if (lowerInput === '/logout' || lowerInput.startsWith('/logout ')) {
      await sync.runLogout();
      return;
    }

    if (lowerInput === '/sync' || lowerInput.startsWith('/sync ')) {
      await sync.runSyncCommand(parseCommandArg(lowerInput, '/sync'));
      return;
    }

    if (inputText.startsWith('/check ')) {
      await runCheck(inputText);
      return;
    }

    await runTranslate(inputText);
  };

  const onSubmitInput = (value) => {
    if (review.active) return;
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

  useInput((char, key) => {
    // While reviewing, keys drive the card (the text box is unfocused).
    if (review.handleKey(char, key)) return;
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
      review.active
        ? h(Text, { color: 'cyan' }, review.busy ? h(Spinner, { type: 'dots' }) : '›', ` ${review.statusLine}`)
        : isLoading
        ? h(Text, { color: 'cyan' }, h(Spinner, { type: 'dots' }), ` ${loadingLabel}`)
        : isSpeaking
          ? h(Text, { color: 'magenta' }, '🔊 Speaking... (/say stop to cancel)')
          : h(Text, { dimColor: true }, `Ready  lang=${currentLang}  mode=${statusMode}${sync.indicator ? `  ${sync.indicator}` : ''}`)
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
        focus: !isLoading && !review.active,
        placeholder: review.active
          ? 'Reviewing: keys go to the card (q to quit)'
          : isLoading ? 'Please wait...' : 'Type text or command...'
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
