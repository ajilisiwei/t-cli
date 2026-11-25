import { z } from 'zod';
import type { LevelView } from '../learn/level.ts';
import { mutedTopicsOn, type LearnPlan } from '../learn/plan.ts';
import { composeReasons } from './extendReasons.ts';
import { extendSignals, givenLemmas, type ExtendSignals } from './extendSignals.ts';
import { ExtendContentSchema, type ExtendMaterial, type ExtendTopic } from './learnContent.ts';
import { askJson, type RunContext } from './llmJson.ts';
import { materialExists, saveMaterial } from './materialData.ts';
import { extendMessages } from './prompts.ts';
import type { ExplanationLang } from './schemas.ts';
import { containsCjk, findTarget, phraseKey, wordKey } from './text.ts';

/**
 * Step 5 of the nightly job, 拓展资料 (docs/api-v1.md, "v3 → Pipeline";
 * docs/v3-plan.html §7): on local Mondays, one JSON call that picks a
 * direction from the account's signals and writes the items. The answer is
 * validated with ExtendContentSchema; evidence the model did not get from the
 * account's own lemmas is dropped, and fewer than two left → one retry, then
 * no extension that week. The level is the account's, the reasons are
 * composed by the server (extendReasons.ts), never by the model.
 */

/** The first try plus one retry (contract: "fewer than 2 evidence lemmas → one retry"). */
export const EXTEND_MAX_ATTEMPTS = 2;
const MIN_EVIDENCE = 2;
const MIN_ITEMS = 6;
const MAX_EVIDENCE = 12;
/** ExtendContentSchema's limit for one evidence entry. */
const EVIDENCE_MAX_CHARS = 60;

/** The model's answer: the stored shape without `level` and `reasons` (the server's), plus the grammar point it addresses. */
const ExtendAnswerSchema = ExtendContentSchema.omit({ level: true, reasons: true }).extend({
  grammarPoint: z.string().trim().max(120).nullish(),
});

export type ExtendOutcome = 'created' | 'exists' | 'no_signals' | 'invalid';
export type ExtendFailure = 'unparsable' | 'schema' | 'muted_topic' | 'evidence' | 'explanation_lang' | 'items';
export type ExtendCheck = { ok: true; value: ExtendMaterial } | { ok: false; reason: ExtendFailure };

export interface ExtendCheckInput {
  lang: ExplanationLang;
  signals: ExtendSignals;
  mutedTopics: readonly ExtendTopic[];
  level: Pick<LevelView, 'setting' | 'effective' | 'retention30' | 'reviews30'>;
}

type AnswerItem = ExtendMaterial['items'][number];

const itemKey = (item: AnswerItem): string => `${item.kind}:${item.kind === 'word' ? wordKey(item.text) : phraseKey(item.text)}`;

/** Items that are usable: explained in the account's language, with an example that contains them; each once. */
function usableItems(items: readonly AnswerItem[], lang: ExplanationLang): AnswerItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = itemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return (lang !== 'zh' || containsCjk(item.gloss)) && findTarget(item.example.en, item.text) !== null;
  });
}

/** Validate one answer and compose the stored material from it (pure). */
export function checkExtendAnswer(raw: unknown, input: ExtendCheckInput): ExtendCheck {
  const parsed = ExtendAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'schema' };
  const answer = parsed.data;
  if (answer.topic !== 'other' && input.mutedTopics.includes(answer.topic)) return { ok: false, reason: 'muted_topic' };

  const given = givenLemmas(input.signals);
  const evidence = [...new Set(answer.evidence.flatMap((text) => given.get(wordKey(text)) ?? []))]
    .filter((text) => text.length <= EVIDENCE_MAX_CHARS)
    .slice(0, MAX_EVIDENCE);
  if (evidence.length < MIN_EVIDENCE) return { ok: false, reason: 'evidence' };
  if (input.lang === 'zh' && !containsCjk(answer.title)) return { ok: false, reason: 'explanation_lang' };
  const items = usableItems(answer.items, input.lang);
  if (items.length < MIN_ITEMS) return { ok: false, reason: 'items' };

  const point = answer.grammar && answer.grammarPoint ? input.signals.grammar.find((entry) => entry.title === answer.grammarPoint) ?? null : null;
  const material = {
    focus: answer.focus,
    topic: answer.topic,
    title: answer.title,
    level: input.level.effective,
    reasons: composeReasons({ lang: input.lang, topic: answer.topic, evidence, signals: input.signals, grammarPoint: point, level: input.level }),
    evidence,
    items,
    passage: answer.passage,
    grammar: answer.grammar,
  };
  const stored = ExtendContentSchema.safeParse(material);
  return stored.success ? { ok: true, value: stored.data } : { ok: false, reason: 'schema' };
}

export interface ExtendResult {
  outcome: ExtendOutcome;
  /** Why answers were refused, in order (codes only). */
  failures: ExtendFailure[];
}

/** The extension material of local day `today` (a Monday), unless it exists or the account has too little to go on. */
export async function buildExtension(ctx: RunContext, today: string, { plan, level }: { plan: LearnPlan; level: LevelView }): Promise<ExtendResult> {
  const { db, userId } = ctx;
  if (await materialExists(db, userId, 'extend', today)) return { outcome: 'exists', failures: [] };
  const signals = await extendSignals(db, userId, ctx.now);
  if (givenLemmas(signals).size < MIN_EVIDENCE) return { outcome: 'no_signals', failures: [] };

  const mutedTopics = mutedTopicsOn(plan, today);
  const messages = extendMessages({ level: level.effective, chosenTopics: plan.extendTopics, mutedTopics, ...signals }, ctx.lang);
  const failures: ExtendFailure[] = [];
  for (let attempt = 0; attempt < EXTEND_MAX_ATTEMPTS; attempt += 1) {
    const answer = await askJson(ctx, messages);
    const check: ExtendCheck = answer.ok ? checkExtendAnswer(answer.value, { lang: ctx.lang, signals, mutedTopics, level }) : { ok: false, reason: 'unparsable' };
    if (check.ok) {
      await saveMaterial(ctx, 'extend', today, check.value);
      return { outcome: 'created', failures };
    }
    failures.push(check.reason);
  }
  return { outcome: 'invalid', failures };
}
