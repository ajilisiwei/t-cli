import { LEVEL_MIN_REVIEWS, type LevelView } from '../learn/level.ts';
import type { ExtendTopic } from './learnContent.ts';
import type { ExtendSignals } from './extendSignals.ts';
import { SIGNAL_WINDOW_DAYS } from './extendSignals.ts';
import type { ExplanationLang } from './schemas.ts';
import { clip, wordKey } from './text.ts';

/**
 * 推荐理由 of an extension material (docs/v3-plan.html §7): written by the
 * server from the evidence and the account's statistics, never by the
 * model, so a reason can only state what the data shows. At most four: up
 * to three from the evidence (lookups, forgetting, grammar errors, stars)
 * and always the level.
 */

const MAX_REASONS = 4;
const NAME_MAX = 20;
const TITLE_MAX = 24;

const TOPIC_ZH: Readonly<Record<ExtendTopic, string>> = {
  work: '职场用词',
  travel: '旅行用词',
  exam: '考试用词',
  daily: '日常用词',
  tech: '科技用词',
  culture: '文化用词',
  finance: '财经用词',
  health: '健康用词',
  other: '相关的词',
};
const TOPIC_EN: Readonly<Record<ExtendTopic, string>> = {
  work: 'work words',
  travel: 'travel words',
  exam: 'exam words',
  daily: 'everyday words',
  tech: 'tech words',
  culture: 'culture words',
  finance: 'finance words',
  health: 'health words',
  other: 'related words',
};

export interface ReasonInput {
  lang: ExplanationLang;
  topic: ExtendTopic;
  /** Evidence lemmas, already filtered to the given ones. */
  evidence: readonly string[];
  signals: ExtendSignals;
  /** The grammar point the material addresses (one of the signals), if any. */
  grammarPoint: { title: string; errors: number } | null;
  level: Pick<LevelView, 'setting' | 'effective' | 'retention30' | 'reviews30'>;
}

const name = (text: string): string => clip(text, NAME_MAX);
const times = (n: number): string => (n === 1 ? '1 time' : `${n} times`);

function lookupReason({ lang, topic, evidence, signals }: ReasonInput): string | null {
  const looked = new Set(signals.lemmas.map((lemma) => wordKey(lemma.text)));
  const names = evidence.filter((text) => looked.has(wordKey(text))).map(name);
  const [a, b] = names;
  if (a === undefined) return null;
  const days = SIGNAL_WINDOW_DAYS;
  if (lang === 'zh') {
    if (b === undefined) return `最近 ${days} 天你查了 ${a}`;
    return names.length === 2 ? `最近 ${days} 天你查了 ${a} 和 ${b}` : `最近 ${days} 天你查了 ${a}、${b} 等 ${names.length} 个${TOPIC_ZH[topic]}`;
  }
  if (b === undefined) return `In the last ${days} days you looked up ${a}`;
  return names.length === 2
    ? `In the last ${days} days you looked up ${a} and ${b}`
    : `In the last ${days} days you looked up ${a}, ${b} and ${names.length - 2} more ${TOPIC_EN[topic]}`;
}

function forgottenReason({ lang, evidence, signals }: ReasonInput): string | null {
  const cited = new Set(evidence.map(wordKey));
  const unit = signals.forgotten.filter((entry) => cited.has(wordKey(entry.text))).sort((x, y) => y.lapses - x.lapses)[0];
  if (!unit) return null;
  return lang === 'zh' ? `${name(unit.text)} 在复习时忘了 ${unit.lapses} 次` : `You forgot ${name(unit.text)} ${times(unit.lapses)} in review`;
}

function grammarReason({ lang, grammarPoint }: ReasonInput): string | null {
  if (!grammarPoint || grammarPoint.errors < 1) return null;
  const title = clip(grammarPoint.title, TITLE_MAX);
  return lang === 'zh' ? `纠错里「${title}」出现了 ${grammarPoint.errors} 次` : `“${title}” came up ${times(grammarPoint.errors)} in your grammar checks`;
}

function starredReason({ lang, evidence, signals }: ReasonInput): string | null {
  const starred = new Set(signals.starred.map(wordKey));
  const unit = evidence.find((text) => starred.has(wordKey(text)));
  if (!unit) return null;
  return lang === 'zh' ? `你把 ${name(unit)} 标成了重要` : `You marked ${name(unit)} as important`;
}

function levelReason({ lang, level }: ReasonInput): string {
  const { setting, effective, retention30, reviews30 } = level;
  if (setting !== 'auto') return lang === 'zh' ? `难度按你的设置定在 ${effective}` : `The level is ${effective}, as you set it`;
  // Too few reviews for any rule: the level is the default, not a consequence of the rate.
  if (retention30 === null || reviews30 < LEVEL_MIN_REVIEWS) return lang === 'zh' ? `难度先定在 ${effective}，复习多了会自动调整` : `The level starts at ${effective} and adjusts as you review`;
  const percent = Math.round(retention30 * 100);
  return lang === 'zh' ? `按你最近 ${percent}% 的记住率，难度定在 ${effective}` : `At your recent ${percent}% recall rate, the level is ${effective}`;
}

export function composeReasons(input: ReasonInput): string[] {
  const fromEvidence = [lookupReason(input), forgottenReason(input), grammarReason(input), starredReason(input)].filter(
    (reason): reason is string => reason !== null,
  );
  return [...fromEvidence.slice(0, MAX_REASONS - 1), levelReason(input)];
}
