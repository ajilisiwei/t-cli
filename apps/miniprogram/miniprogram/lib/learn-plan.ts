/**
 * 学习计划: the choices of the plan page and the setting changes they make
 * (docs/api-v1.md, "v3 → Settings"). Pure; the page saves through
 * services/settings.ts (local first, then the account).
 */
import type { LearnSummary } from './learn-types'
import type {
  ExtendTopic,
  MaterialFrequency,
  MaterialPart,
  MaterialTopic,
  MutedTopic,
  StudyLevel,
  StudyLevelSetting,
} from './types'

export interface Option<T> {
  readonly id: T
  readonly label: string
}

export const FREQUENCY_OPTIONS: readonly (Option<MaterialFrequency> & { readonly hint: string })[] = [
  { id: 'daily', label: '每天', hint: '每天早上 5 点，整理前一天的查询、笔记和复习。前一天没有新内容就不出。' },
  { id: 'weekly', label: '每周', hint: '每周一份合集，整理这 7 天的内容。哪怕这周没查词，也会有一份复习回顾。' },
  { id: 'off', label: '关闭', hint: '不再生成周期资料。复习和拓展资料不受影响。' },
]

/** Monday first, as the week reads in China; `id` is the setting (0 = Sunday). */
export const WEEKDAY_OPTIONS: readonly (Option<number> & { readonly aria: string })[] = [
  { id: 1, label: '一', aria: '星期一' },
  { id: 2, label: '二', aria: '星期二' },
  { id: 3, label: '三', aria: '星期三' },
  { id: 4, label: '四', aria: '星期四' },
  { id: 5, label: '五', aria: '星期五' },
  { id: 6, label: '六', aria: '星期六' },
  { id: 0, label: '日', aria: '星期日' },
]

export const PART_OPTIONS: readonly Option<MaterialPart>[] = [
  { id: 'words', label: '重点词' },
  { id: 'phrases', label: '词组与句型' },
  { id: 'grammar', label: '语法与易错' },
  { id: 'story', label: '情景短文' },
  { id: 'exercises', label: '练习题' },
]

export const TOPIC_LABELS: Readonly<Record<MaterialTopic, string>> = {
  work: '职场',
  travel: '旅行',
  exam: '考试',
  daily: '日常对话',
  tech: '科技',
  culture: '文化',
  finance: '财经',
  health: '健康',
  other: '其他',
}

export const TOPIC_OPTIONS: readonly Option<ExtendTopic>[] = (
  ['work', 'travel', 'exam', 'daily', 'tech', 'culture', 'finance', 'health'] as const
).map((id) => ({ id, label: TOPIC_LABELS[id] }))

const LEVEL_HINTS: Readonly<Record<StudyLevel, string>> = {
  A2: 'A2：常用词和简单句。',
  B1: 'B1：日常和工作场景，句子稍长。',
  B2: 'B2：较正式的书面语和抽象话题。',
  C1: 'C1：接近母语读者的材料。',
}

export const LEVEL_OPTIONS: readonly Option<StudyLevelSetting>[] = [
  { id: 'auto', label: '自动' },
  { id: 'A2', label: 'A2' },
  { id: 'B1', label: 'B1' },
  { id: 'B2', label: 'B2' },
  { id: 'C1', label: 'C1' },
]

export interface Chip<T> extends Option<T> {
  readonly on: boolean
}

export const chipsOf = <T>(options: readonly Option<T>[], isOn: (id: T) => boolean): Chip<T>[] =>
  options.map((option) => ({ id: option.id, label: option.label, on: isOn(option.id) }))

export function frequencyHint(frequency: MaterialFrequency): string {
  return FREQUENCY_OPTIONS.find((option) => option.id === frequency)?.hint ?? ''
}

const inOrder = <T>(options: readonly Option<T>[], chosen: ReadonlySet<T>): T[] =>
  options.map((option) => option.id).filter((id) => chosen.has(id))

/** `parts` with `part` switched; null when that would leave none (at least one stays). */
export function togglePart(parts: readonly MaterialPart[], part: MaterialPart): MaterialPart[] | null {
  const chosen = new Set(parts)
  if (chosen.has(part)) chosen.delete(part)
  else chosen.add(part)
  const next = inOrder(PART_OPTIONS, chosen)
  return next.length === 0 ? null : next
}

/** `topics` with `topic` switched, in the canonical order. */
export function toggleTopic(topics: readonly ExtendTopic[], topic: ExtendTopic): ExtendTopic[] {
  const chosen = new Set(topics)
  if (chosen.has(topic)) chosen.delete(topic)
  else chosen.add(topic)
  return inOrder(TOPIC_OPTIONS, chosen)
}

/** Mutes still in force on `today` (`until` is exclusive). */
export function activeMuted(muted: readonly MutedTopic[], today: string): MutedTopic[] {
  return muted.filter((entry) => entry.until > today)
}

/** 恢复推荐: `topic` taken off the muted list. */
export function unmute(muted: readonly MutedTopic[], topic: MaterialTopic): MutedTopic[] {
  return muted.filter((entry) => entry.topic !== topic)
}

const monthDay = (date: string): string => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`

export interface MutedRow {
  readonly topic: MaterialTopic
  /** "财经 · 12月24日起恢复" */
  readonly label: string
}

export function mutedRows(muted: readonly MutedTopic[], today: string): MutedRow[] {
  return activeMuted(muted, today).map((entry) => ({
    topic: entry.topic,
    label: `${TOPIC_LABELS[entry.topic]} · ${monthDay(entry.until)}起恢复`,
  }))
}

/** What 难度 says under the chips: the effective level and why, or the chosen level. */
export function levelHint(setting: StudyLevelSetting, level: LearnSummary['level'] | null): string {
  if (setting !== 'auto') return LEVEL_HINTS[setting]
  if (level === null) return '按最近 30 天的记住率自动定难度，默认 B1。'
  if (level.retention30 === null) {
    return `当前按 ${level.effective} 出题。复习多了以后，会按最近 30 天的记住率自动调整。`
  }
  const rate = Math.round(level.retention30 * 100)
  return `当前按 ${level.effective} 出题：最近 30 天的记住率是 ${rate}%（复习 ${level.reviews30} 次）。记住率高了会自动提一档。`
}
