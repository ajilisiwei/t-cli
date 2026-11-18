import test from 'node:test'
import assert from 'node:assert/strict'
import { createLineSplitter, createStreamCollector, parseStreamLine } from '../miniprogram/lib/ndjson.ts'
import { createUtf8Decoder } from '../miniprogram/lib/utf8.ts'
import type { StreamEvent } from '../miniprogram/lib/types.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

// The example body from docs/api-v1.md, with a multi-byte delta.
const BODY = [
  '{"type":"meta","srcLang":"en","kind":"word"}',
  '{"type":"delta","text":"prior"}',
  '{"type":"delta","text":"itize /praɪˈɔːr.ə.taɪz/ 优先考虑"}',
  '{"type":"done","entry":{"id":"01JABCDEFGHJKMNPQRSTVWXYZ0","seq":42,"kind":"word","correctedInput":"prioritize"}}',
  '',
].join('\n')

const EXPECTED: StreamEvent[] = [
  { type: 'meta', srcLang: 'en', kind: 'word' },
  { type: 'delta', text: 'prior' },
  { type: 'delta', text: 'itize /praɪˈɔːr.ə.taɪz/ 优先考虑' },
  {
    type: 'done',
    entry: { id: '01JABCDEFGHJKMNPQRSTVWXYZ0', seq: 42, kind: 'word', correctedInput: 'prioritize' },
  },
]

const collect = (bytes: Uint8Array, cuts: readonly number[], status = 200, data: unknown = '') => {
  const events: StreamEvent[] = []
  const collector = createStreamCollector(createUtf8Decoder(), (event) => events.push(event))
  let start = 0
  for (const cut of [...cuts, bytes.length]) {
    collector.chunk(bytes.slice(start, cut).buffer)
    start = cut
  }
  const outcome = collector.complete(status, data)
  return { events, outcome }
}

test('line splitter buffers partial lines and skips blank ones', () => {
  const splitter = createLineSplitter()
  assert.deepEqual(splitter.push('{"a":1}\n{"b"'), ['{"a":1}'])
  assert.deepEqual(splitter.push(':2}\r\n\n'), ['{"b":2}'])
  assert.deepEqual(splitter.push('{"c":3}'), [])
  assert.deepEqual(splitter.flush(), ['{"c":3}'])
  assert.deepEqual(splitter.flush(), [])
})

test('parseStreamLine reads the four known line types', () => {
  assert.deepEqual(
    BODY.split('\n').filter(Boolean).map(parseStreamLine),
    EXPECTED,
  )
  assert.deepEqual(parseStreamLine('{"type":"error","code":"AI_UPSTREAM","message":"upstream failed"}'), {
    type: 'error',
    code: 'AI_UPSTREAM',
    message: 'upstream failed',
  })
})

test('parseStreamLine ignores unknown types, malformed JSON and envelopes', () => {
  assert.equal(parseStreamLine('{"type":"usage","tokens":12}'), null)
  assert.equal(parseStreamLine('{"type":"delta"}'), null)
  assert.equal(parseStreamLine('{"type":"done","entry":{}}'), null)
  assert.equal(parseStreamLine('not json'), null)
  assert.equal(parseStreamLine('[1,2]'), null)
  assert.equal(parseStreamLine('{"success":false,"data":null,"error":{"code":"UNAUTHORIZED"}}'), null)
})

test('parseStreamLine tolerates unknown srcLang/kind values', () => {
  assert.deepEqual(parseStreamLine('{"type":"meta","srcLang":"xx","kind":"essay","extra":1}'), {
    type: 'meta',
    srcLang: null,
    kind: null,
  })
})

test('collector yields the same events wherever the chunks are cut', () => {
  const bytes = encode(BODY)
  for (let cut = 0; cut <= bytes.length; cut += 1) {
    const { events, outcome } = collect(bytes, [cut])
    assert.deepEqual(events, EXPECTED, `cut at byte ${cut}`)
    assert.deepEqual(outcome, { kind: 'stream' })
  }
})

test('collector handles one byte per chunk', () => {
  const bytes = encode(BODY)
  const { events } = collect(bytes, Array.from({ length: bytes.length }, (_, i) => i))
  assert.deepEqual(events, EXPECTED)
})

test('a final line without a newline is parsed on completion', () => {
  const { events } = collect(encode('{"type":"meta","srcLang":"zh","kind":"sentence"}\n{"type":"delta","text":"Hi"}'), [])
  assert.deepEqual(events, [
    { type: 'meta', srcLang: 'zh', kind: 'sentence' },
    { type: 'delta', text: 'Hi' },
  ])
})

test('falls back to the success payload when the runtime did not stream', () => {
  const events: StreamEvent[] = []
  const collector = createStreamCollector(createUtf8Decoder(), (event) => events.push(event))
  assert.deepEqual(collector.complete(200, BODY), { kind: 'stream' })
  assert.deepEqual(events, EXPECTED)

  const fromBuffer: StreamEvent[] = []
  const second = createStreamCollector(createUtf8Decoder(), (event) => fromBuffer.push(event))
  second.complete(200, encode(BODY).buffer)
  assert.deepEqual(fromBuffer, EXPECTED)
})

test('a non-200 answer returns the envelope text and emits nothing', () => {
  const envelope = '{"success":false,"data":null,"error":{"code":"QUOTA_EXCEEDED","message":"daily quota","details":{"limit":200}}}'
  const bytes = encode(envelope)
  for (let cut = 0; cut <= bytes.length; cut += 7) {
    const { events, outcome } = collect(bytes, [cut], 429)
    assert.deepEqual(events, [])
    assert.deepEqual(outcome, { kind: 'http-error', status: 429, body: envelope })
  }
})

test('a non-200 answer the platform already parsed is passed through', () => {
  const parsed = { success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'expired' } }
  const events: StreamEvent[] = []
  const collector = createStreamCollector(createUtf8Decoder(), (event) => events.push(event))
  assert.deepEqual(collector.complete(401, parsed), { kind: 'http-error', status: 401, body: parsed })
  assert.deepEqual(events, [])
})
