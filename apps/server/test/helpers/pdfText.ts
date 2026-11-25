import { inflateSync } from 'node:zlib';

/**
 * Minimal text extraction for the PDFs Typst writes, so tests can check
 * what a PDF says (e.g. that injected Typst markup was printed literally).
 * Typst uses Type0 fonts (Identity-H: 2-byte glyph ids in literal strings)
 * with a ToUnicode CMap each, one resource dictionary shared by all pages,
 * and word spaces as TJ adjustments. Not a general PDF parser.
 */

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

function objectsOf(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const re = /(\d+) 0 obj\s*(<<[\s\S]*?>>)\s*(stream\r?\n)?/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const dict = match[2] ?? '';
    const length = /\/Length\s+(\d+)/.exec(dict)?.[1];
    if (!match[3] || length === undefined) {
      objects.set(Number(match[1]), { dict, stream: null });
      continue;
    }
    const start = match.index + match[0].length;
    const raw = Buffer.from(text.slice(start, start + Number(length)), 'latin1');
    objects.set(Number(match[1]), { dict, stream: /\/FlateDecode/.test(dict) ? inflateSync(raw) : raw });
    re.lastIndex = start + Number(length);
  }
  return objects;
}

const utf16 = (hex: string): string => {
  const bytes = Buffer.from(hex, 'hex');
  const units = Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readUInt16BE(i * 2));
  return String.fromCharCode(...units);
};

/** glyph id → text, from a ToUnicode CMap. */
function parseCmap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1] ?? '0', 16), utf16(pair[2] ?? ''));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(range[1] ?? '0', 16);
      const hi = parseInt(range[2] ?? '0', 16);
      const dst = parseInt(range[3] ?? '0', 16);
      for (let gid = lo; gid <= hi; gid += 1) map.set(gid, String.fromCodePoint(dst + gid - lo));
    }
  }
  return map;
}

type Token = { kind: 'str'; bytes: number[] } | { kind: 'num'; value: number } | { kind: 'name' | 'op'; value: string } | { kind: '[' | ']' };

const ESCAPES: Readonly<Record<string, number>> = { n: 10, r: 13, t: 9, b: 8, f: 12 };

/** Tokens of a content stream (strings, numbers, names, operators, array brackets). */
function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i] ?? '';
    if (/\s/.test(ch)) i += 1;
    else if (ch === '(') {
      const bytes: number[] = [];
      let depth = 1;
      i += 1;
      while (i < content.length && depth > 0) {
        const c = content[i] ?? '';
        if (c === '\\') {
          const next = content[i + 1] ?? '';
          const octal = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))?.[0];
          if (octal) {
            bytes.push(parseInt(octal, 8));
            i += 1 + octal.length;
          } else {
            bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
            i += 2;
          }
          continue;
        }
        if (c === '(') depth += 1;
        if (c === ')') depth -= 1;
        if (depth > 0) bytes.push(c.charCodeAt(0));
        i += 1;
      }
      tokens.push({ kind: 'str', bytes });
    } else if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      const hex = content.slice(i + 1, end).replace(/\s+/g, '');
      tokens.push({ kind: 'str', bytes: [...Buffer.from(hex, 'hex')] });
      i = end + 1;
    } else if (ch === '[' || ch === ']') {
      tokens.push({ kind: ch });
      i += 1;
    } else {
      const word = /^[^\s()<>[\]{}/%]+|^\/[^\s()<>[\]{}/%]*|^[<>{}]+/.exec(content.slice(i))?.[0] ?? ch;
      if (word.startsWith('/')) tokens.push({ kind: 'name', value: word.slice(1) });
      else if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ kind: 'num', value: Number(word) });
      else tokens.push({ kind: 'op', value: word });
      i += word.length;
    }
  }
  return tokens;
}

const decode = (bytes: readonly number[], cmap: Map<number, string> | undefined): string =>
  Array.from({ length: Math.floor(bytes.length / 2) }, (_, i) => cmap?.get(((bytes[2 * i] ?? 0) << 8) | (bytes[2 * i + 1] ?? 0)) ?? '�').join('');

/** The text of every content stream, in file order; text objects end with a newline. */
export function pdfText(pdf: Buffer): string {
  const objects = objectsOf(pdf);
  const fontByName = new Map<string, Map<number, string>>();
  for (const object of objects.values()) {
    const fonts = /\/Font\s*<<([\s\S]*?)>>/.exec(object.dict)?.[1];
    for (const entry of fonts?.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+) 0 R/g) ?? []) {
      const toUnicode = /\/ToUnicode\s+(\d+) 0 R/.exec(objects.get(Number(entry[2]))?.dict ?? '')?.[1];
      const cmap = toUnicode ? objects.get(Number(toUnicode))?.stream : null;
      if (cmap) fontByName.set(entry[1] ?? '', parseCmap(cmap.toString('latin1')));
    }
  }
  const out: string[] = [];
  for (const object of objects.values()) {
    const content = object.stream?.toString('latin1');
    if (!content || !/\bTf\b/.test(content) || content.includes('begincmap')) continue;
    // The font is part of the graphics state: `Q` restores the one `q` saved.
    let cmap: Map<number, string> | undefined;
    let saved: (Map<number, string> | undefined)[] = [];
    let operands: Token[] = [];
    for (const token of tokenize(content)) {
      if (token.kind !== 'op') {
        operands = [...operands, token];
        continue;
      }
      if (token.value === 'q') saved = [...saved, cmap];
      else if (token.value === 'Q') {
        cmap = saved[saved.length - 1];
        saved = saved.slice(0, -1);
      } else if (token.value === 'Tf') {
        const name = operands.find((operand) => operand.kind === 'name');
        cmap = name?.kind === 'name' ? fontByName.get(name.value) : undefined;
      } else if (token.value === 'TJ' || token.value === 'Tj') {
        for (const operand of operands) {
          if (operand.kind === 'str') out.push(decode(operand.bytes, cmap));
          else if (operand.kind === 'num' && operand.value <= -150) out.push(' ');
        }
      } else if (token.value === 'ET') out.push('\n');
      operands = [];
    }
  }
  return out.join('');
}

/** `pdfText` without any whitespace: layout decides where lines break and spaces go. */
export const compactPdfText = (pdf: Buffer): string => pdfText(pdf).replace(/\s+/g, '');
