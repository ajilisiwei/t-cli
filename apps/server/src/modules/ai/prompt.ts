import { buildSourceMessage, getCheckPrompt, getTranslatePrompt } from '@t-cli/core/prompts';
import { detectSourceLang, isWordLookup } from '@t-cli/core/detect';
import type { EntrySrcLang } from '@t-cli/core/entry';
import type { ChatMessage } from '../../ports.ts';

export type AiTask = 'translate' | 'check';
export type AiMode = 'simple' | 'detail';
export type ExplanationLang = 'zh' | 'en';

export interface AiPromptInput {
  text: string;
  task: AiTask;
  mode: AiMode;
  lang: ExplanationLang;
}

export interface AiPrompt {
  messages: readonly ChatMessage[];
  /** Source language recorded on the entry ('en' for grammar checks, as the CLI does). */
  srcLang: EntrySrcLang;
}

/**
 * Build the chat messages exactly like the CLI's runTranslate / runCheck
 * (apps/cli/src/repl.js): same system prompts from @t-cli/core, and the user
 * text always wrapped in <source> tags so it is treated as data.
 */
export function buildAiPrompt({ text, task, mode, lang }: AiPromptInput): AiPrompt {
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
  const sourceLang = detectSourceLang(text);
  return {
    messages: [
      { role: 'system', content: getTranslatePrompt(lang, isSimpleMode, isWordLookup(text), sourceLang) },
      { role: 'user', content: buildSourceMessage(text, 'translate') },
    ],
    srcLang: sourceLang,
  };
}
