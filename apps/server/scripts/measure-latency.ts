/**
 * Measure DeepSeek latency through the server's own client (src/modules/ai/llm.ts)
 * and the real prompts, for a few representative inputs.
 *
 *   node apps/server/scripts/measure-latency.ts [--runs 5] [--mode simple|detail] [--lang zh|en]
 *
 * Needs DEEPSEEK_API_KEY in the environment (never printed); DEEPSEEK_MODEL and
 * DEEPSEEK_BASE_URL are optional. Calls run one at a time and are capped at
 * MAX_CALLS so a typo in --runs cannot burn through the API budget.
 */
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createLlmClient } from '../src/modules/ai/llm.ts';
import { buildAiPrompt, type AiMode, type AiTask, type ExplanationLang } from '../src/modules/ai/prompt.ts';

const MAX_CALLS = 24;
const FIRST_TOKEN_TARGET_MS = 2000;
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

interface Sample {
  label: string;
  text: string;
  task: AiTask;
}

const SAMPLES: readonly Sample[] = [
  { label: 'word lookup EN', text: 'ubiquitous', task: 'translate' },
  { label: 'word lookup ZH', text: '优先', task: 'translate' },
  { label: 'sentence ZH→EN', text: '这个功能下周上线之前需要再做一次完整的回归测试。', task: 'translate' },
  { label: 'check EN', text: 'He go to school yesterday and forget to bring his homework.', task: 'check' },
];

interface Measurement {
  ttftMs: number | null;
  totalMs: number;
  outputChars: number;
  error?: string;
}

function parseOptions(): { runs: number; mode: AiMode; lang: ExplanationLang } {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '5' },
      mode: { type: 'string', default: 'simple' },
      lang: { type: 'string', default: 'zh' },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  if (runs * SAMPLES.length > MAX_CALLS) {
    throw new Error(`--runs ${runs} would make ${runs * SAMPLES.length} calls; the cap is ${MAX_CALLS}`);
  }
  if (values.mode !== 'simple' && values.mode !== 'detail') throw new Error('--mode must be simple or detail');
  if (values.lang !== 'zh' && values.lang !== 'en') throw new Error('--lang must be zh or en');
  return { runs, mode: values.mode, lang: values.lang };
}

/** Nearest-rank percentile of a non-empty list. */
function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

const fmt = (ms: number | undefined): string => (ms === undefined ? '-' : `${Math.round(ms)}`);

async function main(): Promise<void> {
  const { runs, mode, lang } = parseOptions();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  const baseUrl = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL;
  const llm = createLlmClient({ DEEPSEEK_API_KEY: apiKey, DEEPSEEK_MODEL: model, DEEPSEEK_BASE_URL: baseUrl });

  const out = (line = ''): void => {
    process.stdout.write(`${line}\n`);
  };
  out(`model=${model} host=${new URL(baseUrl).host} mode=${mode} lang=${lang} runs=${runs} (sequential)`);

  const results = new Map<string, Measurement[]>();
  for (const sample of SAMPLES) {
    const { messages } = buildAiPrompt({ text: sample.text, task: sample.task, mode, lang });
    const measurements: Measurement[] = [];
    for (let run = 0; run < runs; run += 1) {
      const startedAt = performance.now();
      let ttftMs: number | null = null;
      let outputChars = 0;
      try {
        for await (const chunk of llm.streamChat(messages, { signal: AbortSignal.timeout(120_000) })) {
          if (ttftMs === null && chunk.trim() !== '') ttftMs = performance.now() - startedAt;
          outputChars += chunk.length;
        }
        measurements.push({ ttftMs, totalMs: performance.now() - startedAt, outputChars });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        measurements.push({ ttftMs, totalMs: performance.now() - startedAt, outputChars, error: message });
      }
      const last = measurements.at(-1)!;
      out(`  ${sample.label} #${run + 1}: ttft=${fmt(last.ttftMs ?? undefined)}ms total=${fmt(last.totalMs)}ms chars=${last.outputChars}${last.error ? ` ERROR ${last.error}` : ''}`);
    }
    results.set(sample.label, measurements);
  }

  out();
  out('| input | ok/n | TTFT p50 | TTFT p95 | total p50 | total p95 | out chars p50 | TTFT ≤ 2 s |');
  out('|---|---|---|---|---|---|---|---|');
  for (const [label, measurements] of results) {
    const ok = measurements.filter((m) => !m.error && m.ttftMs !== null);
    const ttft = ok.map((m) => m.ttftMs!);
    const total = ok.map((m) => m.totalMs);
    const chars = ok.map((m) => m.outputChars);
    const has = ok.length > 0;
    const verdict = has ? (percentile(ttft, 0.95) <= FIRST_TOKEN_TARGET_MS ? 'p95 yes' : percentile(ttft, 0.5) <= FIRST_TOKEN_TARGET_MS ? 'p50 only' : 'no') : '-';
    out(
      `| ${label} | ${ok.length}/${measurements.length} | ${has ? fmt(percentile(ttft, 0.5)) : '-'} ms | ${has ? fmt(percentile(ttft, 0.95)) : '-'} ms | ` +
        `${has ? fmt(percentile(total, 0.5)) : '-'} ms | ${has ? fmt(percentile(total, 0.95)) : '-'} ms | ${has ? percentile(chars, 0.5) : '-'} | ${verdict} |`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`measure-latency: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
