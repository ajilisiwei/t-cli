import { addAbortSignal, type Readable } from 'node:stream';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { TtsClient } from '../../ports.ts';

/**
 * Real TTS adapter: Microsoft Edge Read Aloud via `msedge-tts`, the same
 * package, output format and voices as the CLI's `/say` (apps/cli/src/tts.js).
 * It is an unofficial free endpoint with no SLA, so every failure surfaces as
 * an error the route maps to 502 TTS_UPSTREAM.
 */

/** Far above any real result (1000 code points ≈ a few hundred KB at 48 kbit/s). */
export const TTS_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export class TtsUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsUpstreamError';
  }
}

// Characters XML 1.0 does not allow; the service rejects SSML containing them.
const XML_INVALID_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/**
 * `msedge-tts` interpolates the text into its SSML template verbatim, so text
 * like "R&D" or "a < b" would break the request, and markup in a record would
 * be interpreted as SSML. Escape it as XML character data.
 */
export function escapeSsmlText(text: string): string {
  return text
    .replace(XML_INVALID_RE, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Settle with `promise`, or reject as soon as `signal` fires. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

async function readAudio(stream: Readable, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = chunk as Uint8Array;
    total += bytes.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new TtsUpstreamError('synthesized audio is too large');
    }
    chunks.push(bytes);
  }
  // The library ends the stream on a dropped connection too, possibly with no audio.
  if (total === 0) throw new TtsUpstreamError('synthesis returned no audio');
  return Buffer.concat(chunks, total);
}

export function createEdgeTtsClient({ maxAudioBytes = TTS_MAX_AUDIO_BYTES }: { maxAudioBytes?: number } = {}): TtsClient {
  return {
    async synthesize(text, voice, { signal }) {
      signal.throwIfAborted();
      // One connection per request, as the CLI does: the endpoint's auth token
      // is time-based, and an idle shared socket would need its own lifecycle.
      const tts = new MsEdgeTTS();
      try {
        await untilAborted(tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3), signal);
        const { audioStream } = tts.toStream(escapeSsmlText(text));
        return await readAudio(addAbortSignal(signal, audioStream), maxAudioBytes);
      } finally {
        try {
          tts.close();
        } catch {
          // Closing a socket that never opened can throw; nothing to clean up then.
        }
      }
    },
  };
}
