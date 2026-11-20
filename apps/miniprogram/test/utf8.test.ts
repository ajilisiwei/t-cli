import test from 'node:test'
import assert from 'node:assert/strict'
import { createUtf8Decoder } from '../miniprogram/lib/utf8.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Decodes `bytes` delivered as the given chunk sizes, then flushes. */
const decodeInChunks = (bytes: Uint8Array, cuts: readonly number[]): string => {
  const decoder = createUtf8Decoder()
  let out = ''
  let start = 0
  for (const cut of [...cuts, bytes.length]) {
    out += decoder.decode(bytes.subarray(start, cut))
    start = cut
  }
  return out + decoder.flush()
}

/** Reference: the platform decoder in its non-fatal mode, BOM kept as a character. */
const reference = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)

/** Small deterministic PRNG (mulberry32), so failures reproduce. */
const prng = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 1-, 2-, 3- and 4-byte characters, including a surrogate pair in UTF-16.
const SAMPLE = 'a é 中文 → 😀 /məˈtɪkjələs/ 一丝不苟'

test('decodes a whole buffer like TextDecoder', () => {
  assert.equal(decodeInChunks(encode(SAMPLE), []), SAMPLE)
})

test('a character split at every byte offset decodes intact', () => {
  const bytes = encode(SAMPLE)
  for (let cut = 0; cut <= bytes.length; cut += 1) {
    assert.equal(decodeInChunks(bytes, [cut]), SAMPLE, `cut at byte ${cut}`)
  }
})

test('every pair of cut points decodes intact', () => {
  const bytes = encode('中😀é→')
  for (let first = 0; first <= bytes.length; first += 1) {
    for (let second = first; second <= bytes.length; second += 1) {
      assert.equal(decodeInChunks(bytes, [first, second]), '中😀é→', `cuts ${first}, ${second}`)
    }
  }
})

test('one byte per chunk decodes intact', () => {
  const bytes = encode(SAMPLE)
  const cuts = Array.from({ length: bytes.length }, (_, i) => i)
  assert.equal(decodeInChunks(bytes, cuts), SAMPLE)
})

test('accepts ArrayBuffer chunks (what onChunkReceived delivers)', () => {
  const bytes = encode('翻译')
  const decoder = createUtf8Decoder()
  const first = decoder.decode(bytes.slice(0, 4).buffer)
  const second = decoder.decode(bytes.slice(4).buffer)
  assert.equal(first, '翻')
  assert.equal(second, '译')
  assert.equal(decoder.flush(), '')
})

test('an unfinished character at the end becomes U+FFFD on flush', () => {
  const bytes = encode('好')
  const decoder = createUtf8Decoder()
  assert.equal(decoder.decode(bytes.subarray(0, 2)), '')
  assert.equal(decoder.flush(), '�')
  // The decoder is reusable after a flush.
  assert.equal(decoder.decode(encode('ok')), 'ok')
})

test('malformed sequences match TextDecoder replacement behaviour', () => {
  const cases: number[][] = [
    [0xff],
    [0xc0, 0x80],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80], // UTF-16 surrogate encoded in UTF-8
    [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
    [0xe4, 0xb8, 0x41], // truncated 3-byte char followed by ASCII
    [0x80, 0x41],
    [0xf0, 0x9f, 0x98],
  ]
  for (const bytes of cases) {
    const input = Uint8Array.from(bytes)
    for (let cut = 0; cut <= input.length; cut += 1) {
      assert.equal(decodeInChunks(input, [cut]), reference(input), `bytes ${bytes.join(',')} cut ${cut}`)
    }
  }
})

test('random bytes in random chunks match TextDecoder', () => {
  const random = prng(20261118)
  for (let round = 0; round < 300; round += 1) {
    const length = Math.floor(random() * 40)
    // Bias towards the interesting high range.
    const bytes = Uint8Array.from({ length }, () =>
      random() < 0.5 ? 0x80 + Math.floor(random() * 0x80) : Math.floor(random() * 0x100),
    )
    const cuts: number[] = []
    for (let i = 1; i < length; i += 1) if (random() < 0.3) cuts.push(i)
    assert.equal(decodeInChunks(bytes, cuts), reference(bytes), `round ${round}`)
  }
})

test('long input decodes without hitting argument limits', () => {
  const text = '中'.repeat(30_000)
  assert.equal(decodeInChunks(encode(text), [1, 50_001]), text)
})
