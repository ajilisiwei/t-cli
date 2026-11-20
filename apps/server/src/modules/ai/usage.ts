import { z } from 'zod';
import type { ChatMessage, LlmUsage } from '../../ports.ts';

/**
 * Token accounting shared by the AI proxy and the nightly pipeline
 * (docs/api-v1.md, "AI quotas (extended)").
 */

const codePoints = (text: string): number => [...text].length;

/** The contract's fallback when the upstream reports no usage: code points / 2, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(codePoints(text) / 2);
}

export function estimatePromptTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

export const totalTokens = (usage: LlmUsage): number => usage.promptTokens + usage.completionTokens;

/** OpenAI-compatible `usage` object (DeepSeek adds cache and reasoning details, which are ignored). */
export const UpstreamUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});

/** The usage in an upstream payload; a missing or unexpected shape is ignored (the caller then estimates), never an error. */
export function parseUsage(value: unknown): LlmUsage | null {
  const parsed = UpstreamUsageSchema.safeParse(value);
  return parsed.success ? { promptTokens: parsed.data.prompt_tokens, completionTokens: parsed.data.completion_tokens } : null;
}
