/**
 * NDJSON over a chunked response: `POST /v1/ai/translate` answers with one JSON
 * object per line (docs/api-v1.md "AI proxy").
 *
 * Bytes → text is the injected {@link ChunkDecoder}; text → complete lines is
 * {@link createLineSplitter}; a line → a typed event is {@link parseStreamLine}.
 * {@link createStreamCollector} wires the three together and also keeps the
 * head of the body, because the HTTP status is only reliable once the request
 * completes (DevTools never reports it in `onHeadersReceived`) and an error
 * answer is a JSON envelope, not NDJSON.
 */
import type { ChunkDecoder } from './utf8'
import type { EntryKind, SrcLang, StreamEvent } from './types'

export interface LineSplitter {
  /** Returns the lines completed by `text`; a partial last line is buffered. */
  push(text: string): string[]
  /** Returns the buffered partial line, if any, as the final line. */
  flush(): string[]
}

/** Splits on LF, drops a trailing CR and skips blank lines. */
export function createLineSplitter(): LineSplitter {
  let pending = ''
  const clean = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)
  return {
    push(text) {
      const parts = (pending + text).split('\n')
      pending = parts.pop() ?? ''
      return parts.map(clean).filter((line) => line.trim() !== '')
    },
    flush() {
      const last = clean(pending)
      pending = ''
      return last.trim() === '' ? [] : [last]
    },
  }
}

const SRC_LANGS: readonly string[] = ['zh', 'en', 'other']
const KINDS: readonly string[] = ['word', 'sentence', 'paragraph']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asSrcLang = (value: unknown): SrcLang | null =>
  typeof value === 'string' && SRC_LANGS.includes(value) ? (value as SrcLang) : null

const asKind = (value: unknown): EntryKind | null =>
  typeof value === 'string' && KINDS.includes(value) ? (value as EntryKind) : null

/**
 * Parses one NDJSON line. Unknown line types, malformed JSON and lines that
 * are not stream events (an error envelope) yield `null` and are ignored.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  switch (value['type']) {
    case 'meta':
      return { type: 'meta', srcLang: asSrcLang(value['srcLang']), kind: asKind(value['kind']) }
    case 'delta':
      return typeof value['text'] === 'string' ? { type: 'delta', text: value['text'] } : null
    case 'done': {
      const entry = value['entry']
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || entry['id'] === '') return null
      return {
        type: 'done',
        entry: {
          id: entry['id'],
          seq: typeof entry['seq'] === 'number' ? entry['seq'] : null,
          kind: asKind(entry['kind']),
          correctedInput: typeof entry['correctedInput'] === 'string' ? entry['correctedInput'] : null,
        },
      }
    }
    case 'error':
      return {
        type: 'error',
        code: typeof value['code'] === 'string' ? value['code'] : 'INTERNAL',
        message: typeof value['message'] === 'string' ? value['message'] : '',
      }
    default:
      return null
  }
}

/** What a finished response turned out to be. */
export type StreamOutcome =
  | { readonly kind: 'stream' }
  /** Non-200: `body` is the envelope to parse (text, or an object the platform already parsed). */
  | { readonly kind: 'http-error'; readonly status: number; readonly body: unknown }

export interface StreamCollector {
  /** Feeds one `onChunkReceived` chunk. */
  chunk(bytes: ArrayBuffer | Uint8Array): void
  /**
   * Ends the response. `data` is what the request's `success` callback got:
   * used only when no chunk arrived (a runtime that did not stream).
   */
  complete(status: number, data: unknown): StreamOutcome
}

/** Enough to hold any error envelope; NDJSON bodies are not kept. */
const HEAD_LIMIT = 16 * 1024

export function createStreamCollector(
  decoder: ChunkDecoder,
  onEvent: (event: StreamEvent) => void,
): StreamCollector {
  const splitter = createLineSplitter()
  let head = ''
  let sawChunk = false

  const emitLines = (lines: readonly string[]): void => {
    for (const line of lines) {
      const event = parseStreamLine(line)
      if (event !== null) onEvent(event)
    }
  }

  const feedText = (text: string): void => {
    if (head.length < HEAD_LIMIT) head += text.slice(0, HEAD_LIMIT - head.length)
    emitLines(splitter.push(text))
  }

  return {
    chunk(bytes) {
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      if (view.byteLength === 0) return
      sawChunk = true
      feedText(decoder.decode(view))
    },
    complete(status, data) {
      let parsedBody: unknown
      if (!sawChunk) {
        if (typeof data === 'string') feedText(data)
        else if (data instanceof ArrayBuffer) feedText(decoder.decode(data))
        else if (data !== undefined && data !== null && data !== '') parsedBody = data
      }
      const tail = decoder.flush()
      if (tail !== '') feedText(tail)
      emitLines(splitter.flush())
      if (status === 200) return { kind: 'stream' }
      return { kind: 'http-error', status, body: parsedBody ?? head }
    },
  }
}
