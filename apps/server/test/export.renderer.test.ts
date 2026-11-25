import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checklistDocument } from '../src/modules/export/assemble.ts';
import { createTypstRenderer, RenderFailedError, RendererUnavailableError, type TypstRendererOptions } from '../src/modules/export/renderer.ts';

/**
 * The Typst runner against a fake `typst` (a shell script): arguments,
 * temp dirs, timeouts, the concurrency limit and error mapping. Needs no
 * Typst; the real renderer is covered by export.render.test.ts.
 */

const FAKE_TYPST = `#!/bin/sh
# Fake typst: records what it was given, then behaves as ./mode says.
here=$(dirname "$0")
root="$3"
echo "$@" > "$here/args.txt"
ls "$root" > "$here/files.txt"
cp "$root/data.json" "$here/data.json"
touch "$here/active.$$"
ls "$here" | grep -c '^active\\.' >> "$here/concurrency.txt"
mode=$(cat "$here/mode")
delay=$(cat "$here/delay")
case "$mode" in
  ok) sleep "$delay"; printf '%%PDF-1.7\\n1 0 obj << /Type /Page >> endobj\\n2 0 obj << /Type /Page >> endobj\\n' ;;
  slow) sleep 5 ;;
  fail) echo 'error: something broke' >&2; rm -f "$here/active.$$"; exit 1 ;;
  garbage) echo 'not a pdf' ;;
esac
rm -f "$here/active.$$"
`;

const doc = checklistDocument({ from: 'units', rows: [{ term: 'feasible', ipa: '/ˈfiːzəbl/', gloss: 'adj. 可行的' }] }, {
  layout: 'practice',
  ipa: true,
  large: false,
  today: '2026-11-25',
});

describe('typst runner (fake binary)', () => {
  let dir: string;
  let bin: string;
  let fonts: string;
  let tmpRoot: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tcli-fake-typst-'));
    bin = join(dir, 'typst');
    fonts = join(dir, 'fonts');
    tmpRoot = join(dir, 'tmp');
    await writeFile(bin, FAKE_TYPST);
    await chmod(bin, 0o755);
    await Promise.all([fonts, tmpRoot].map((path) => mkdir(path)));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const setMode = async (mode: 'ok' | 'slow' | 'fail' | 'garbage', delay = 0): Promise<void> => {
    await writeFile(join(dir, 'mode'), mode);
    await writeFile(join(dir, 'delay'), String(delay));
    await writeFile(join(dir, 'concurrency.txt'), '');
  };
  const renderer = (options: Partial<TypstRendererOptions> = {}) => createTypstRenderer({ bin, fontPath: fonts, tmpRoot, ...options });
  const tmpLeft = async (): Promise<string[]> => readdir(tmpRoot);

  test('runs typst compile on a fresh dir with the templates and data.json, PDF on stdout, then removes the dir', async () => {
    await setMode('ok');
    const result = await renderer().render(doc);
    assert.equal(result.pages, 2);
    assert.ok(result.pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.ok(result.renderMs >= 0 && result.queueMs >= 0);

    const args = (await readFile(join(dir, 'args.txt'), 'utf8')).trim().split(' ');
    const root = args[2]!;
    assert.deepEqual(args, ['compile', '--root', root, '--font-path', fonts, '--ignore-system-fonts', '--jobs', '2', '--diagnostic-format', 'short', join(root, 'main.typ'), '-']);
    assert.ok(root.startsWith(join(tmpRoot, 'tcli-pdf-')));
    assert.deepEqual((await readFile(join(dir, 'files.txt'), 'utf8')).trim().split('\n').sort(), [
      'cards.typ',
      'checklist.typ',
      'common.typ',
      'data.json',
      'main.typ',
      'material.typ',
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'data.json'), 'utf8')), doc);
    assert.deepEqual(await tmpLeft(), [], 'temp dir removed');
  });

  test('at most 2 renders at a time; the rest wait their turn', async () => {
    await setMode('ok', 0.3);
    const shared = renderer();
    const startedAt = Date.now();
    const results = await Promise.all(Array.from({ length: 5 }, () => shared.render(doc)));
    const elapsed = Date.now() - startedAt;
    const peaks = (await readFile(join(dir, 'concurrency.txt'), 'utf8')).trim().split('\n').map(Number);
    assert.equal(results.length, 5);
    assert.equal(peaks.length, 5);
    assert.ok(Math.max(...peaks) <= 2, `peak concurrency ${Math.max(...peaks)}`);
    assert.ok(elapsed >= 850, `5 renders of 0.3 s in waves of 2 take ≥ 0.9 s (took ${elapsed} ms)`);
    assert.ok(results.some((result) => result.queueMs >= 250), 'some renders waited in the queue');
    assert.deepEqual(await tmpLeft(), []);
  });

  test('a render over the timeout is killed → timeout; waiting longer than the timeout → busy', async () => {
    await setMode('slow');
    const startedAt = Date.now();
    await assert.rejects(renderer({ timeoutMs: 300 }).render(doc), (error: unknown) => error instanceof RenderFailedError && error.reason === 'timeout');
    assert.ok(Date.now() - startedAt < 2500, 'killed, not waited for');
    assert.deepEqual(await tmpLeft(), []);

    await setMode('ok', 0.4);
    const single = renderer({ maxConcurrent: 1, timeoutMs: 600 });
    const outcomes = await Promise.allSettled([single.render(doc), single.render(doc), single.render(doc)]);
    assert.deepEqual(
      outcomes.map((outcome) => (outcome.status === 'fulfilled' ? 'ok' : outcome.reason instanceof RenderFailedError ? outcome.reason.reason : 'other')),
      ['ok', 'ok', 'busy'],
    );
  });

  test('a failing or garbled typst → EXPORT_FAILED reasons; the dir is still removed', async () => {
    await setMode('fail');
    await assert.rejects(renderer().render(doc), (error: unknown) => error instanceof RenderFailedError && error.reason === 'exit');
    await setMode('garbage');
    await assert.rejects(renderer().render(doc), (error: unknown) => error instanceof RenderFailedError && error.reason === 'invalid_output');
    assert.deepEqual(await tmpLeft(), []);
  });

  test('no binary or no fonts → unavailable', async () => {
    await setMode('ok');
    await assert.rejects(renderer({ bin: join(dir, 'missing-typst') }).render(doc), RendererUnavailableError);
    await assert.rejects(renderer({ bin: 'typst-surely-not-on-path-0' }).render(doc), RendererUnavailableError);
    await writeFile(join(dir, 'args.txt'), '');
    await assert.rejects(renderer({ fontPath: join(dir, 'no-fonts') }).render(doc), RendererUnavailableError);
    assert.equal(await readFile(join(dir, 'args.txt'), 'utf8'), '', 'typst is not started without fonts');
    assert.deepEqual(await tmpLeft(), []);
  });
});
