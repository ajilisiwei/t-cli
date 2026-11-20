/**
 * Incremental Server-Sent Events parser (the subset of the WHATWG format an
 * OpenAI-compatible chat stream uses).
 *
 * Network chunks split anywhere: inside a line, between a CR and its LF, or
 * inside a multi-byte UTF-8 character. Bytes go through one streaming
 * TextDecoder, text is buffered until a line terminator arrives, and an event
 * is dispatched on the blank line that ends it. Comment lines (": keep-alive")
 * are ignored; several `data:` lines in one event are joined with "\n".
 */
export interface SseParser {
  /** Feed raw bytes; returns the `data` payload of every event they complete. */
  push(chunk: Uint8Array): string[];
  /** End of stream: flushes a trailing event that lacked its blank line. */
  end(): string[];
}

const LF = 0x0a;
const CR = 0x0d;

export function createSseParser(): SseParser {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];

  const processLine = (line: string, out: string[]): void => {
    if (line === '') {
      if (dataLines.length > 0) out.push(dataLines.join('\n'));
      dataLines = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return; // event / id / retry are not used by chat streams
    const value = colon === -1 ? '' : line.slice(colon + 1);
    dataLines = [...dataLines, value.startsWith(' ') ? value.slice(1) : value];
  };

  /** Consume every complete line in the buffer; keep the incomplete tail. */
  const drain = (out: string[], final: boolean): void => {
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const code = buffer.charCodeAt(i);
      if (code !== LF && code !== CR) continue;
      // A CR at the very end may be the first half of a CRLF split across chunks.
      if (code === CR && i === buffer.length - 1 && !final) break;
      processLine(buffer.slice(start, i), out);
      if (code === CR && buffer.charCodeAt(i + 1) === LF) i += 1;
      start = i + 1;
    }
    buffer = buffer.slice(start);
  };

  return {
    push(chunk) {
      const out: string[] = [];
      buffer += decoder.decode(chunk, { stream: true });
      drain(out, false);
      return out;
    },
    end() {
      const out: string[] = [];
      buffer += decoder.decode();
      drain(out, true);
      if (buffer !== '') processLine(buffer, out);
      buffer = '';
      processLine('', out);
      return out;
    },
  };
}
