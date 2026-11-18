import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { FastifyReply } from 'fastify';
import type { EntryKind, EntrySrcLang } from '@t-cli/core/entry';
import { AppError } from '../../http/errors.ts';
import type { ChatMessage, LlmClient } from '../../ports.ts';

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';
/** Same bound as record sync accepts, so every stored result stays pushable/pullable. */
export const OUTPUT_MAX_CHARS = 50_000;

export interface DoneEntry {
  id: string;
  seq: number;
  kind: EntryKind;
  correctedInput: string | null;
}

/** What the client shows before the text arrives (the direction label). */
export interface StreamMeta {
  srcLang: EntrySrcLang;
  kind: EntryKind;
}

/** One line of the NDJSON response body (docs/api-v1.md, AI proxy). */
export type StreamLine =
  | ({ type: 'meta' } & StreamMeta)
  | { type: 'delta'; text: string }
  | { type: 'done'; entry: DoneEntry }
  | { type: 'error'; code: string; message: string };

export type StreamOutcome = 'ok' | 'aborted' | 'upstream_error' | 'store_failed';

export interface StreamResult {
  outcome: StreamOutcome;
  outputChars: number;
  /** Milliseconds from `startedAt` until the first delta line was written; null if none was. */
  firstDeltaMs: number | null;
  errorCode?: string;
  /** Set when persisting failed (for the log; never sent to the client). */
  storeError?: unknown;
}

export interface ProxyStreamOptions {
  reply: FastifyReply;
  llm: LlmClient;
  messages: readonly ChatMessage[];
  /** Sent as the first line once streaming starts; must describe what `persist` stores. */
  meta: StreamMeta;
  /** Store the finished output; called only when the client is still connected. */
  persist(output: string): Promise<DoneEntry>;
  /** performance.now() at request start. */
  startedAt: number;
}

/** Abort reason used when the HTTP client goes away. */
export class ClientDisconnected extends Error {
  constructor() {
    super('client disconnected');
    this.name = 'ClientDisconnected';
  }
}

const asUpstreamError = (error: unknown): AppError =>
  error instanceof AppError ? error : new AppError(502, 'AI_UPSTREAM', 'AI upstream request failed');

const serialize = (line: StreamLine): string => `${JSON.stringify(line)}\n`;

/** Write one line, honouring backpressure; throws ClientDisconnected once the client is gone. */
async function writeLine(res: ServerResponse, signal: AbortSignal, line: StreamLine): Promise<void> {
  if (signal.aborted || res.destroyed) throw new ClientDisconnected();
  if (res.write(serialize(line))) return;
  try {
    await once(res, 'drain', { signal });
  } catch {
    throw new ClientDisconnected();
  }
}

function endResponse(res: ServerResponse, line?: StreamLine): void {
  if (res.destroyed || res.writableEnded) return;
  if (line) res.end(serialize(line));
  else res.end();
}

/**
 * Relay an LLM stream to the client as NDJSON.
 *
 * Until the upstream produced non-blank content nothing is sent, so failures
 * and empty answers before that point are thrown as AppErrors and answered as
 * normal JSON envelopes (502 / 503). Then the status is committed: the body
 * starts with the `meta` line and the first delta, and a later failure ends
 * it with an `error` line. When the
 * client disconnects, the upstream request is aborted and nothing is stored.
 */
export async function proxyStream({ reply, llm, messages, meta, persist, startedAt }: ProxyStreamOptions): Promise<StreamResult> {
  const res = reply.raw;
  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableFinished) controller.abort(new ClientDisconnected());
  };
  res.on('close', onClose);
  if (res.destroyed) controller.abort(new ClientDisconnected());

  const upstream = llm.streamChat(messages, { signal: controller.signal })[Symbol.asyncIterator]();
  const clientGone = (error: unknown): boolean => {
    const gone = controller.signal.aborted || error instanceof ClientDisconnected || res.destroyed;
    // Make sure the upstream sees the abort even if the close event was missed.
    if (gone && !controller.signal.aborted) controller.abort(new ClientDisconnected());
    return gone;
  };
  let output = '';
  let firstDeltaMs: number | null = null;
  const result = (outcome: StreamOutcome, extra: Partial<StreamResult> = {}): StreamResult => ({
    outcome,
    outputChars: output.length,
    firstDeltaMs,
    ...extra,
  });

  try {
    // Phase 1: hold the response until there is real content to send.
    try {
      for (;;) {
        const step = await upstream.next();
        if (step.done) throw new AppError(502, 'AI_UPSTREAM', 'AI returned an empty response');
        output += step.value;
        if (output.trim() !== '') break;
      }
    } catch (error) {
      if (!clientGone(error)) throw asUpstreamError(error);
      reply.hijack();
      endResponse(res);
      return result('aborted');
    }

    // Phase 2: commit to 200 and stream every delta as it arrives.
    reply.hijack();
    res.writeHead(200, {
      'content-type': NDJSON_CONTENT_TYPE,
      'cache-control': 'no-store',
      // Disable response buffering in nginx-style reverse proxies.
      'x-accel-buffering': 'no',
    });
    try {
      await writeLine(res, controller.signal, { type: 'meta', srcLang: meta.srcLang, kind: meta.kind });
      await writeLine(res, controller.signal, { type: 'delta', text: output });
      firstDeltaMs = performance.now() - startedAt;
      for (;;) {
        const step = await upstream.next();
        if (step.done) break;
        if (step.value === '') continue;
        output += step.value;
        if (output.length > OUTPUT_MAX_CHARS) throw new AppError(502, 'AI_UPSTREAM', 'AI response is too long');
        await writeLine(res, controller.signal, { type: 'delta', text: step.value });
      }
    } catch (error) {
      if (clientGone(error)) {
        endResponse(res);
        return result('aborted');
      }
      const appError = asUpstreamError(error);
      endResponse(res, { type: 'error', code: appError.code, message: appError.message });
      return result('upstream_error', { errorCode: appError.code });
    }

    if (clientGone(undefined)) return result('aborted');
    let entry: DoneEntry;
    try {
      entry = await persist(output);
    } catch (storeError) {
      endResponse(res, { type: 'error', code: 'INTERNAL', message: 'failed to store the result' });
      return result('store_failed', { errorCode: 'INTERNAL', storeError });
    }
    endResponse(res, { type: 'done', entry });
    return result('ok');
  } finally {
    res.off('close', onClose);
    // Closes the upstream generator (and its HTTP body) on every exit path.
    await upstream.return?.(undefined)?.catch(() => {});
  }
}
