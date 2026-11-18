// Characters XML 1.0 does not allow; the speech service rejects SSML containing them.
const XML_INVALID_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/**
 * Escape text as XML character data for an SSML request.
 *
 * `msedge-tts` interpolates the text into its SSML template verbatim, so text
 * like "R&D" or "a < b" would break the request, and markup inside a record
 * would be interpreted as SSML. Shared by the CLI's `/say` and the server's
 * `POST /v1/tts`.
 * @param {string} text
 * @returns {string}
 */
export function escapeSsmlText(text) {
  return text
    .replace(XML_INVALID_RE, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
