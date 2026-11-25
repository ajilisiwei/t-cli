import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { PdfDocument } from './document.ts';
import { countPdfPages } from './pdfPages.ts';

/**
 * Typst runner (docs/v3-plan.html §8). Per render: a fresh temp dir holding
 * the fixed templates (copied from templates/) and `data.json`; then
 *
 *   typst compile --root <dir> --font-path <fonts> --ignore-system-fonts <dir>/main.typ -
 *
 * spawned without a shell, PDF bytes on stdout. User text only ever reaches
 * Typst inside data.json, which the templates read with json() and lay out
 * as plain text — it is never parsed as markup. At most `maxConcurrent`
 * renders run at once (the rest wait in FIFO order, as long as the timeout);
 * a render longer than the timeout is killed. The temp dir is always
 * removed; the PDF is never written anywhere else. Typst's stderr is drained
 * and dropped: it may quote template lines, and logs never carry content.
 */

export const RENDER_TIMEOUT_MS = 15_000;
export const MAX_CONCURRENT_RENDERS = 2;
/** Threads per Typst process: layout parallelism costs memory in a 256 MB container. */
const TYPST_JOBS = '2';
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const DEFAULT_TEMPLATE_DIR = fileURLToPath(new URL('./templates/', import.meta.url));

/** The Typst binary or its fonts are not installed (local development) → 503 EXPORT_UNAVAILABLE. */
export class RendererUnavailableError extends Error {
  override readonly name = 'RendererUnavailableError';
}

export type RenderFailure = 'timeout' | 'busy' | 'exit' | 'spawn' | 'too_large' | 'invalid_output';

/** Typst failed, was killed, or produced no usable PDF → 502 EXPORT_FAILED. */
export class RenderFailedError extends Error {
  override readonly name = 'RenderFailedError';
  readonly reason: RenderFailure;

  constructor(reason: RenderFailure) {
    super(`pdf render failed: ${reason}`);
    this.reason = reason;
  }
}

export interface RenderResult {
  pdf: Buffer;
  pages: number;
  /** Time in the queue, then in Typst (milliseconds). */
  queueMs: number;
  renderMs: number;
}

export interface PdfRenderer {
  render(document: PdfDocument): Promise<RenderResult>;
}

export interface TypstRendererOptions {
  bin: string;
  fontPath: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  /** Where the per-render temp dirs go (default: the OS temp dir). */
  tmpRoot?: string;
  templateDir?: string;
}

// ------------------------------------------------------------ concurrency

interface Slots {
  acquire(waitMs: number): Promise<() => void>;
}

/** A FIFO semaphore; waiting longer than `waitMs` rejects with `busy`. */
function createSlots(max: number): Slots {
  let active = 0;
  let waiting: { grant: () => void }[] = [];

  const release = (): void => {
    const [next, ...rest] = waiting;
    waiting = rest;
    if (next) next.grant();
    else active -= 1;
  };
  const once = (fn: () => void): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      fn();
    };
  };

  return {
    acquire(waitMs) {
      if (active < max) {
        active += 1;
        return Promise.resolve(once(release));
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          grant: () => {
            clearTimeout(timer);
            resolve(once(release));
          },
        };
        const timer = setTimeout(() => {
          waiting = waiting.filter((other) => other !== waiter);
          reject(new RenderFailedError('busy'));
        }, waitMs);
        waiting = [...waiting, waiter];
      });
    },
  };
}

// ------------------------------------------------------------------ typst

const isMissingBinary = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES');

function runTypst(bin: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | null = null;
    let settled = false;
    const settle = (error: Error | null, pdf?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(pdf ?? Buffer.alloc(0));
    };
    const kill = (reason: RenderFailure): void => {
      failure ??= new RenderFailedError(reason);
      child.kill('SIGKILL');
    };
    // A killed render settles on 'exit' (the process is gone; its pipes are
    // dropped), so the slot and the temp dir are freed only after it ended.
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    child.on('exit', () => {
      if (!failure) return;
      child.stdout.destroy();
      child.stderr.destroy();
      settle(failure);
    });

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PDF_BYTES) kill('too_large');
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', (error) => settle(isMissingBinary(error) ? new RendererUnavailableError('typst is not installed') : new RenderFailedError('spawn')));
    child.on('close', (code) => {
      if (failure) settle(failure);
      else if (code === 0) settle(null, Buffer.concat(chunks));
      else settle(new RenderFailedError('exit'));
    });
  });
}

export function createTypstRenderer(options: TypstRendererOptions): PdfRenderer {
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
  const slots = createSlots(options.maxConcurrent ?? MAX_CONCURRENT_RENDERS);
  const templateDir = options.templateDir ?? DEFAULT_TEMPLATE_DIR;
  let templates: Promise<ReadonlyMap<string, Buffer>> | null = null;
  let fontsFound = false;

  const loadTemplates = async (): Promise<ReadonlyMap<string, Buffer>> => {
    const names = (await readdir(templateDir)).filter((name) => name.endsWith('.typ'));
    return new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(templateDir, name))] as const)));
  };

  const ensureFonts = async (): Promise<void> => {
    if (fontsFound) return;
    const info = await stat(options.fontPath).catch(() => null);
    if (!info?.isDirectory()) throw new RendererUnavailableError('typst fonts are not installed');
    fontsFound = true;
  };

  const compile = async (document: PdfDocument): Promise<Buffer> => {
    templates ??= loadTemplates();
    const files = await templates.catch((error: unknown) => {
      templates = null;
      throw error;
    });
    const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'tcli-pdf-'));
    try {
      await Promise.all([...files].map(([name, content]) => writeFile(join(dir, name), content)));
      await writeFile(join(dir, 'data.json'), JSON.stringify(document));
      const args = [
        'compile',
        '--root', dir,
        '--font-path', options.fontPath,
        '--ignore-system-fonts',
        '--jobs', TYPST_JOBS,
        '--diagnostic-format', 'short',
        join(dir, 'main.typ'),
        '-',
      ];
      return await runTypst(options.bin, args, dir, timeoutMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  return {
    async render(document) {
      const queuedAt = performance.now();
      const release = await slots.acquire(timeoutMs);
      const startedAt = performance.now();
      try {
        await ensureFonts();
        const pdf = await compile(document);
        const pages = countPdfPages(pdf);
        if (pages === null) throw new RenderFailedError('invalid_output');
        return { pdf, pages, queueMs: Math.round(startedAt - queuedAt), renderMs: Math.round(performance.now() - startedAt) };
      } finally {
        release();
      }
    },
  };
}
