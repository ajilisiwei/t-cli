/**
 * ULIDs for review logs, minted on the phone so a rating can be posted, queued
 * offline and posted again without ever counting twice (`POST /v1/reviews` is
 * idempotent by log id). Same encoding as packages/core/src/ulid.js: a 48-bit
 * millisecond time and 80 bits of entropy as 26 Crockford base32 characters.
 *
 * The entropy is injected: the mini-program has no synchronous Web Crypto, and
 * tests need fixed bytes.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
export const ULID_ENTROPY_BYTES = 10
const MAX_TIME = 2 ** 48 - 1

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

const encodeTime = (time: number): string => {
  let out = ''
  let rest = time
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = ENCODING.charAt(rest % 32) + out
    rest = Math.floor(rest / 32)
  }
  return out
}

/** 80 bits → 16 characters of 5 bits each. */
const encodeEntropy = (bytes: readonly number[]): string => {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | (byte & 0xff)
    bits += 8
    while (bits >= 5) {
      out += ENCODING.charAt((buffer >> (bits - 5)) & 31)
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  return out
}

/**
 * A ULID for `time` (epoch ms) from the first 10 `entropy` bytes (0–255).
 * Throws a RangeError for a time outside [0, 2^48) or too few bytes.
 */
export function ulid(time: number, entropy: readonly number[]): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`ULID time must be an integer in [0, 2^48): ${time}`)
  }
  if (entropy.length < ULID_ENTROPY_BYTES) {
    throw new RangeError(`ULID entropy needs ${ULID_ENTROPY_BYTES} bytes`)
  }
  return encodeTime(time) + encodeEntropy(entropy.slice(0, ULID_ENTROPY_BYTES))
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value)
}
