/**
 * Extract the text worth reading aloud from a raw API response.
 * Simple mode responses are a single translation, so the whole text is used.
 * Detail mode responses put the best translation alone on the first line
 * (enforced by the prompt), so only that line is used.
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

function clean(text) {
  return text
    .replace(/\s*\/[^\s/][^/\n]*\/\s*/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
