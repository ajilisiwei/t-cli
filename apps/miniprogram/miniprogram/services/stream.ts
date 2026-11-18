/**
 * `POST /v1/ai/translate` as a stream of events.
 *
 * `wx.request` with `enableChunked` delivers the NDJSON body in byte chunks
 * (`onChunkReceived`); lib/ndjson.ts reassembles characters and lines. Errors
 * before streaming are JSON envelopes: a 401 goes through the client's
 * refresh-and-retry, every other one rejects with its `ApiError`.
 */
import { ApiError, parseEnvelope } from '../lib/api'
import { createStreamCollector } from '../lib/ndjson'
import type { StreamEvent, TranslateRequest } from '../lib/types'
import { createUtf8Decoder } from '../lib/utf8'
import { transportError } from './http'
import { api } from './session'

/** A long detail-mode check can stream for a while; this bounds a stuck request. */
const STREAM_TIMEOUT_MS = 120_000

export interface StreamHandle {
  /** Settles when the body ended; rejects with an `ApiError` (`ABORTED` after {@link StreamHandle.abort}). */
  readonly done: Promise<void>
  abort(): void
}

const abortedError = (): ApiError => new ApiError({ kind: 'aborted', code: 'ABORTED', message: 'aborted' })

export function startTranslateStream(body: TranslateRequest, onEvent: (event: StreamEvent) => void): StreamHandle {
  let task: WechatMiniprogram.RequestTask | null = null
  let aborted = false

  const attempt = (accessToken: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (aborted) {
        reject(abortedError())
        return
      }
      const collector = createStreamCollector(createUtf8Decoder(), (event) => {
        if (!aborted) onEvent(event)
      })
      task = wx.request({
        url: `${api.baseUrl}/v1/ai/translate`,
        method: 'POST',
        header: {
          accept: 'application/x-ndjson',
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        data: JSON.stringify(body),
        enableChunked: true,
        responseType: 'arraybuffer',
        timeout: STREAM_TIMEOUT_MS,
        success: (response) => {
          if (aborted) {
            reject(abortedError())
            return
          }
          const outcome = collector.complete(response.statusCode, response.data)
          if (outcome.kind === 'stream') {
            resolve()
            return
          }
          try {
            parseEnvelope(outcome.status, outcome.body)
            reject(new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: 'success envelope on a stream route' }))
          } catch (error: unknown) {
            reject(error)
          }
        },
        fail: (error) => reject(aborted ? abortedError() : transportError(error.errMsg)),
      })
      task.onChunkReceived((chunk) => collector.chunk(chunk.data))
    })

  return {
    done: api.authorized(attempt),
    abort() {
      aborted = true
      task?.abort()
    },
  }
}
