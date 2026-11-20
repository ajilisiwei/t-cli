// End-to-end runs of scripts/audit-spelling.js against a throwaway config dir
// (XDG_CONFIG_HOME / APPDATA point at a temp dir, so the real ~/.config/t-cli
// is never touched) and a local fake chat-completions server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEntry } from '@t-cli/core/entry';

const SCRIPT = fileURLToPath(new URL('../scripts/audit-spelling.js', import.meta.url));
const FAKE_KEY = 'sk-test-do-not-print';

let seq = 0;
/** A pre-correctedInput (legacy) outbox line. */
function legacyLine({ input, output, srcLang = 'en', task = 'translate' }) {
  seq += 1;
  const { correctedInput, ...rest } = createEntry({
    source: 'cli', task, input, output, mode: 'simple', srcLang, correctedInput: null,
    createdAt: new Date(Date.UTC(2026, 9, seq, 4)),
    entropy: new Uint8Array(10).fill(seq),
  });
  return JSON.stringify(rest);
}

const LINES = [
  legacyLine({ input: 'suspanse', output: 'suspense /səˈspɛns/ 悬念' }),
  legacyLine({ input: 'prioritiz', output: 'prioritiz /praɪˈɔːrətaɪz/ 优先处理' }),
  legacyLine({ input: 'Recieved', output: '收到' }),
  legacyLine({ input: 'apple', output: 'apple /ˈæp.əl/ 苹果' }),
  legacyLine({ input: 'xqzt', output: '未知' }),
  legacyLine({ input: '苹果', output: 'apple', srcLang: 'zh' }),
  'this line is not json',
];

/** Fake model: fixed verdicts per word, records every request. */
const VERDICTS = {
  prioritiz: { status: 'misspelled', correction: 'prioritize' },
  recieved: { status: 'misspelled', correction: 'received' },
  xqzt: { status: 'unknown', correction: null },
};

async function startFakeApi(t, { content } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, payload });
      const { words } = JSON.parse(payload.messages[1].content);
      const results = words.map((word) => ({ word, ...(VERDICTS[word.toLowerCase()] ?? { status: 'correct', correction: null }) }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: content ?? JSON.stringify({ results }) }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/chat/completions`, requests };
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 't-cli');
  fs.mkdirSync(configDir, { recursive: true });
  const outbox = path.join(configDir, 'outbox.jsonl');
  const original = `${LINES.join('\n')}\n`;
  fs.writeFileSync(outbox, original, 'utf8');
  return { root, configDir, outbox, original };
}

/** Run the script asynchronously so the in-process fake server can answer. */
function run(env, args, apiUrl = 'http://127.0.0.1:9/unused') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: env.root, // keep dotenv away from any real .env
      env: {
        ...process.env,
        XDG_CONFIG_HOME: env.root,
        APPDATA: env.root,
        DEEPSEEK_API_KEY: FAKE_KEY,
        DEEPSEEK_API_URL: apiUrl,
        DEEPSEEK_MODEL: 'fake-model',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const backups = (env) => fs.readdirSync(env.configDir).filter((name) => name.startsWith('outbox.jsonl.bak-'));
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n');

test('dry run reports both passes and writes nothing', async (t) => {
  const env = setup(t);
  const api = await startFakeApi(t);
  const result = await run(env, [], api.url);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /DRY RUN/);
  assert.match(result.stdout, /candidates:\s+5 /);
  assert.match(result.stdout, /suspanse → suspense\s+1× \[2026-10-01 head corrected\]/);
  assert.match(result.stdout, /prioritiz → prioritize\s+1× \[2026-10-02 echoed\]/);
  assert.match(result.stdout, /Recieved → received\s+1× \[2026-10-03 no head term\]/);
  assert.match(result.stdout, /Unknown words.*\n\s+xqzt/);
  assert.match(result.stdout, /echoed the misspelling:\s+1/);
  assert.ok(!result.stdout.includes(FAKE_KEY) && !result.stderr.includes(FAKE_KEY));

  // One request; the deterministic hit is not re-sent; the key goes only in the header.
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].auth, `Bearer ${FAKE_KEY}`);
  assert.equal(api.requests[0].payload.temperature, 0);
  assert.deepEqual(JSON.parse(api.requests[0].payload.messages[1].content).words, ['prioritiz', 'Recieved', 'apple', 'xqzt']);

  assert.equal(fs.readFileSync(env.outbox, 'utf8'), env.original);
  assert.deepEqual(backups(env), []);
});

test('--apply updates only affected lines, backs up, and is idempotent', async (t) => {
  const env = setup(t);
  const api = await startFakeApi(t);
  const first = await run(env, ['--apply'], api.url);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /entries updated:\s+3/);

  const after = readLines(env.outbox);
  const before = env.original.split('\n');
  assert.equal(after.length, before.length);
  const changed = after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null);
  assert.deepEqual(changed, [0, 1, 2]);
  assert.deepEqual(changed.map((i) => JSON.parse(after[i]).correctedInput), ['suspense', 'prioritize', 'received']);
  for (const i of changed) assert.equal(after[i], `${before[i].slice(0, -1)},"correctedInput":"${JSON.parse(after[i]).correctedInput}"}`);

  const [backup] = backups(env);
  assert.equal(fs.readFileSync(path.join(env.configDir, backup), 'utf8'), env.original);

  const applied = fs.readFileSync(env.outbox, 'utf8');
  const second = await run(env, ['--apply'], api.url);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /entries updated:\s+0/);
  assert.equal(fs.readFileSync(env.outbox, 'utf8'), applied);
  assert.equal(backups(env).length, 1);
  assert.ok(!fs.readdirSync(env.configDir).some((name) => name.endsWith('.tmp')));
});

test('invalid model output is reported, never applied', async (t) => {
  const env = setup(t);
  const api = await startFakeApi(t, { content: JSON.stringify({ results: [{ word: 'prioritiz', status: 'misspelled', correction: 'zzzzzzzzzzzz' }] }) });
  const result = await run(env, ['--apply'], api.url);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /LLM errors, not applied/);
  assert.match(result.stdout, /prioritiz: correction "zzzzzzzzzzzz" is too far/);
  assert.match(result.stdout, /Recieved: no answer/);
  // The deterministic correction is still applied; nothing from the LLM is.
  const corrected = readLines(env.outbox).filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  }).filter((e) => e.correctedInput);
  assert.deepEqual(corrected.map((e) => e.correctedInput), ['suspense']);
});

test('--no-llm makes no requests; --save-plan / --from-plan apply exactly the reviewed plan', async (t) => {
  const env = setup(t);
  const planPath = path.join(env.root, 'plan.json');
  const dry = await run(env, ['--no-llm', '--save-plan', planPath]);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /llm pass:\s+skipped/);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.deepEqual(plan.corrections.map((c) => [c.input, c.correctedInput]), [['suspanse', 'suspense']]);

  const edited = { ...plan, corrections: [...plan.corrections, { ...plan.corrections[0], id: JSON.parse(LINES[1]).id, input: 'prioritiz', correctedInput: 'prioritize' }] };
  fs.writeFileSync(planPath, JSON.stringify(edited), 'utf8');
  const applied = await run(env, ['--apply', '--from-plan', planPath]);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  assert.match(applied.stdout, /entries updated:\s+2/);
  const after = readLines(env.outbox);
  assert.equal(JSON.parse(after[1]).correctedInput, 'prioritize');

  const again = await run(env, ['--apply', '--from-plan', planPath]);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /plan already applied:\s+2/);
});

test('missing outbox and bad flags fail loudly', async (t) => {
  const env = setup(t);
  fs.rmSync(env.outbox);
  const missing = await run(env, ['--no-llm']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /outbox not found/);
  const bad = await run(env, ['--bogus']);
  assert.equal(bad.status, 2);
});
