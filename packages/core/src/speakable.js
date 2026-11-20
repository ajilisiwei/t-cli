import { detectSourceLang } from './detect.js';

/**
 * Extract the text worth reading aloud from a raw API response.
 * Simple mode responses are a single translation, so the whole text is used.
 * Detail mode responses put the best translation (or, for /check, the
 * corrected text) alone on the first line (enforced by the prompts), so only
 * that line is used.
 * IPA transcriptions like /ˈæp.əl/ are stripped — TTS should not read them.
 * @param {string} rawResponse
 * @param {boolean} isSimpleMode
 * @returns {string}
 */
export function extractSpeakable(rawResponse, isSimpleMode) {
  const trimmed = (rawResponse || '').trim();
  if (!trimmed) return '';

  if (isSimpleMode) {
    return clean(trimmed);
  }

  // A line can become empty after stripping (e.g. a lone IPA transcription),
  // so fall through to the next line that still has content.
  for (const line of trimmed.split('\n')) {
    const cleaned = clean(line);
    if (cleaned) return cleaned;
  }
  return '';
}

/**
 * The text to read aloud for a stored Entry (docs/api-v1.md, `POST /v1/tts`):
 * - check → the corrected text (detail mode: its first line);
 * - translate from 'zh' → the English output, as the CLI's `/say` reads it;
 * - translate from 'en' → the English source: `correctedInput ?? input`;
 * - translate from 'other' → the Chinese output.
 * An entry without srcLang (older records) is classified from its input.
 * Returns '' when there is nothing to read.
 * @param {Pick<import('./entry.js').Entry, 'task'|'mode'|'input'|'output'|'srcLang'> & { correctedInput?: string|null }} entry
 * @returns {string}
 */
export function speakableForEntry(entry) {
  const isSimpleMode = entry.mode === 'simple';
  if (entry.task === 'check') return extractSpeakable(entry.output, isSimpleMode);
  const srcLang = entry.srcLang ?? detectSourceLang(entry.input);
  if (srcLang === 'en') return (entry.correctedInput ?? entry.input ?? '').trim();
  return extractSpeakable(entry.output, isSimpleMode);
}

// An IPA transcription is a standalone /.../ token: it opens at the start of
// the text or after whitespace / an opening bracket, and closes before
// whitespace, punctuation, or the end. This keeps URLs (https://a.com/x/y)
// and paths (/etc/hosts) intact.
const IPA_TOKEN = /(?<=^|[\s(\[（])\/[^\s/][^/\n]*\/(?=[\s.,;:!?)\]，。；：！？）]|$)/g;

function clean(text) {
  return text
    .replace(IPA_TOKEN, ' ')
    .replace(/\*\*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
