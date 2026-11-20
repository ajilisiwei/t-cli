import { buildSourceMessage, getCheckPrompt, getTranslatePrompt } from '@t-cli/core/prompts';
import { detectSourceLang, isWordLookup } from '@t-cli/core/detect';
import type { EntrySrcLang } from '@t-cli/core/entry';
import type { ChatMessage } from '../../ports.ts';

export type AiTask = 'translate' | 'check';
export type AiMode = 'simple' | 'detail';
export type ExplanationLang = 'zh' | 'en';
/** The user flipped the detected direction (docs/api-v1.md, `direction`). */
export type TranslateDirection = 'toEn' | 'toZh';

export interface AiPromptInput {
  text: string;
  task: AiTask;
  mode: AiMode;
  lang: ExplanationLang;
  /** Translate only; ignored for checks. */
  direction?: TranslateDirection | undefined;
}

export interface AiPrompt {
  messages: readonly ChatMessage[];
  /** Source language recorded on the entry and sent in the `meta` line ('en' for grammar checks, as the CLI does). */
  srcLang: EntrySrcLang;
}

/**
 * The source language a translation runs from: detected, unless the user
 * flipped the direction. `toEn` → 'zh' (translate into English); `toZh` → the
 * detected language, or 'other' when the text was detected as Chinese (e.g.
 * pure-kanji Japanese), since 'zh' would translate into English.
 */
export function resolveSourceLang(text: string, direction?: TranslateDirection): EntrySrcLang {
  if (direction === 'toEn') return 'zh';
  const detected = detectSourceLang(text);
  if (direction === 'toZh' && detected === 'zh') return 'other';
  return detected;
}

/**
 * Build the chat messages exactly like the CLI's runTranslate / runCheck
 * (apps/cli/src/repl.js): same system prompts from @t-cli/core, and the user
 * text always wrapped in <source> tags so it is treated as data.
 */
export function buildAiPrompt({ text, task, mode, lang, direction }: AiPromptInput): AiPrompt {
  const isSimpleMode = mode === 'simple';
  if (task === 'check') {
    return {
      messages: [
        { role: 'system', content: getCheckPrompt(lang, isSimpleMode) },
        { role: 'user', content: buildSourceMessage(text, 'check') },
      ],
      srcLang: 'en',
    };
  }
  const sourceLang = resolveSourceLang(text, direction);
  return {
    messages: [
      { role: 'system', content: getTranslatePrompt(lang, isSimpleMode, isWordLookup(text), sourceLang) },
      { role: 'user', content: buildSourceMessage(text, 'translate') },
    ],
    srcLang: sourceLang,
  };
}
