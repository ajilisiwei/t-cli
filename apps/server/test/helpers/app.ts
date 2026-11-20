import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import type { Database } from '../../src/db/client.ts';
import type { AppDeps } from '../../src/deps.ts';
import type { ChatMessage, LlmClient, TtsClient, WechatClient } from '../../src/ports.ts';
import { AppError } from '../../src/http/errors.ts';

export const TEST_JWT_SECRET = 'test-only-jwt-secret-0123456789abcdef0123456789';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    JWT_SECRET: TEST_JWT_SECRET,
    ...overrides,
  });
}

export interface TestClock {
  (): Date;
  advance(ms: number): void;
  set(date: Date): void;
}

/** A controllable clock, pinned by default to 2026-11-17 10:00 Asia/Shanghai. */
export function fixedClock(start = new Date('2026-11-17T10:00:00+08:00')): TestClock {
  let now = start.getTime();
  const clock = (() => new Date(now)) as TestClock;
  clock.advance = (ms) => {
    now += ms;
  };
  clock.set = (date) => {
    now = date.getTime();
  };
  return clock;
}

/** Fake WeChat: maps login codes to openids; unknown codes fail like the real API. */
export function fakeWechat(codes: Record<string, string> = {}): WechatClient {
  return {
    async code2Session(code) {
      const openid = codes[code];
      if (!openid) throw new AppError(401, 'WECHAT_CODE_INVALID', 'invalid wx.login code');
      return { openid };
    },
  };
}

/** Fake LLM: streams the given chunks (or chunks computed from the messages). */
export function fakeLlm(reply: readonly string[] | ((messages: readonly ChatMessage[]) => readonly string[]) = ['ok']): LlmClient & {
  calls: (readonly ChatMessage[])[];
} {
  const calls: (readonly ChatMessage[])[] = [];
  return {
    calls,
    async *streamChat(messages) {
      calls.push(messages);
      const chunks = typeof reply === 'function' ? reply(messages) : reply;
      for (const chunk of chunks) yield chunk;
    },
  };
}

export interface FakeTts extends TtsClient {
  calls: { text: string; voice: string; signal: AbortSignal }[];
}

/** The bytes the default fake TTS "synthesizes", so tests can see what was read and with which voice. */
export const fakeAudio = (text: string, voice: string): Buffer => Buffer.from(`fake-mp3|${voice}|${text}`, 'utf8');

/** Fake TTS: records every call and answers with `synthesize` (default: fakeAudio). */
export function fakeTts(
  synthesize: (text: string, voice: string, signal: AbortSignal) => Promise<Uint8Array> = async (text, voice) => fakeAudio(text, voice),
): FakeTts {
  const calls: FakeTts['calls'] = [];
  return {
    calls,
    async synthesize(text, voice, { signal }) {
      calls.push({ text, voice, signal });
      return synthesize(text, voice, signal);
    },
  };
}

export async function buildTestApp(db: Database, overrides: Partial<AppDeps> = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    config: testConfig(),
    db,
    clock: fixedClock(),
    wechat: fakeWechat(),
    llm: fakeLlm(),
    tts: fakeTts(),
    ...overrides,
  });
  await app.ready();
  return app;
}
