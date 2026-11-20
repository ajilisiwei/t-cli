/**
 * Minimal ULID (https://github.com/ulid/spec) generator.
 *
 * 48-bit millisecond timestamp + 80 bits of entropy, encoded as 26 Crockford
 * base32 characters. IDs sort lexicographically by creation time, and any
 * client can mint them offline — which is what makes sync writes idempotent.
 *
 * Uses Web Crypto so the same module runs in Node (CLI, server) and browsers.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const ENTROPY_BYTES = 10;
const MAX_TIME = 2 ** 48 - 1;

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Create a ULID.
 * @param {{ time?: number, entropy?: Uint8Array }} [options]
 *   time: milliseconds since epoch (defaults to now).
 *   entropy: at least 10 bytes; pass a content hash to get a deterministic ID
 *   (used by the history backfill so re-runs never mint duplicates).
 * @returns {string}
 */
export function ulid({ time = Date.now(), entropy } = {}) {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`ULID time must be an integer in [0, 2^48): ${time}`);
  }
  const bytes = entropy ?? globalThis.crypto.getRandomValues(new Uint8Array(ENTROPY_BYTES));
  if (!(bytes instanceof Uint8Array) || bytes.length < ENTROPY_BYTES) {
    throw new RangeError(`ULID entropy must be a Uint8Array of at least ${ENTROPY_BYTES} bytes`);
  }
  return encodeTime(time) + encodeEntropy(bytes.subarray(0, ENTROPY_BYTES));
}

/**
 * Decode the millisecond timestamp embedded in a ULID.
 * @param {string} id
 * @returns {number}
 */
export function ulidTime(id) {
  if (!ULID_RE.test(id)) throw new TypeError(`Not a ULID: ${id}`);
  let time = 0;
  for (const char of id.slice(0, TIME_CHARS)) {
    time = time * 32 + ENCODING.indexOf(char);
  }
  return time;
}

function encodeTime(time) {
  let out = '';
  let rest = time;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ENCODING[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

// 80 bits -> 16 chars of 5 bits each, no remainder.
function encodeEntropy(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ENCODING[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}
