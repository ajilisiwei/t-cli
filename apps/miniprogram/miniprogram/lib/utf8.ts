/**
 * Incremental UTF-8 decoder.
 *
 * `wx.request` with `enableChunked` hands over raw byte chunks, and a chunk
 * boundary can fall inside a multi-byte character (every Chinese character is
 * three bytes). `TextDecoder` is not guaranteed to exist in the mini-program
 * runtime, so this is the WHATWG Encoding Standard's UTF-8 decoder written out:
 * the bytes of an unfinished character are carried over to the next chunk,
 * and malformed input becomes U+FFFD exactly where `TextDecoder` (non-fatal)
 * would put it.
 */

export interface ChunkDecoder {
  /** Decodes a chunk; an incomplete trailing character is kept for the next call. */
  decode(chunk: ArrayBuffer | Uint8Array): string
  /** Ends the stream: an unfinished character becomes U+FFFD. */
  flush(): string
}

const REPLACEMENT = 0xfffd
/** `String.fromCodePoint` takes its code points as arguments; stay well below engine limits. */
const BATCH = 4096

const toBytes = (chunk: ArrayBuffer | Uint8Array): Uint8Array =>
  chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)

const codePointsToString = (points: readonly number[]): string => {
  let out = ''
  for (let i = 0; i < points.length; i += BATCH) {
    out += String.fromCodePoint(...points.slice(i, i + BATCH))
  }
  return out
}

export function createUtf8Decoder(): ChunkDecoder {
  let codePoint = 0
  let bytesSeen = 0
  let bytesNeeded = 0
  let lowerBoundary = 0x80
  let upperBoundary = 0xbf

  const reset = (): void => {
    codePoint = 0
    bytesSeen = 0
    bytesNeeded = 0
    lowerBoundary = 0x80
    upperBoundary = 0xbf
  }

  /** Returns false when `byte` must be processed again (it ended a bad sequence). */
  const step = (byte: number, out: number[]): boolean => {
    if (bytesNeeded === 0) {
      if (byte <= 0x7f) {
        out.push(byte)
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        bytesNeeded = 1
        codePoint = byte & 0x1f
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lowerBoundary = 0xa0
        if (byte === 0xed) upperBoundary = 0x9f
        bytesNeeded = 2
        codePoint = byte & 0x0f
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lowerBoundary = 0x90
        if (byte === 0xf4) upperBoundary = 0x8f
        bytesNeeded = 3
        codePoint = byte & 0x07
      } else {
        out.push(REPLACEMENT)
      }
      return true
    }
    if (byte < lowerBoundary || byte > upperBoundary) {
      reset()
      out.push(REPLACEMENT)
      return false
    }
    lowerBoundary = 0x80
    upperBoundary = 0xbf
    codePoint = (codePoint << 6) | (byte & 0x3f)
    bytesSeen += 1
    if (bytesSeen === bytesNeeded) {
      out.push(codePoint)
      reset()
    }
    return true
  }

  return {
    decode(chunk) {
      const bytes = toBytes(chunk)
      const out: number[] = []
      for (let i = 0; i < bytes.length; i += 1) {
        // A byte that broke a sequence starts the next one; it is never
        // rejected twice, because after `reset()` it is a lead byte.
        if (!step(bytes[i] as number, out)) step(bytes[i] as number, out)
      }
      return codePointsToString(out)
    },
    flush() {
      if (bytesNeeded === 0) return ''
      reset()
      return String.fromCodePoint(REPLACEMENT)
    },
  }
}
