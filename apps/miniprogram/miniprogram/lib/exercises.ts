/**
 * 练习 on the 周期资料 page: 选词填空 answered in the app (choices from the
 * word bank, right/wrong at once, the score), 中译英 and 改错 revealed on tap.
 * Pure; the exercises come from the server (`exercises`, derived from the
 * material's own content), the answers live in the page.
 */
import type { Exercises } from './learn-types'

/** At most this many choices under one blank. */
export const MAX_CLOZE_OPTIONS = 4

const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

/** A choice answers the blank when it is the blank's base word or phrase (case and spacing ignored). */
export function isRightChoice(picked: string, base: string): boolean {
  return picked.trim() !== '' && normalize(picked) === normalize(base)
}

const byWord = (a: string, b: string): number => a.localeCompare(b, 'en')

/**
 * The choices under question `index`: the whole bank when it is small, else
 * the base and the next three bank words after it (a different set per
 * question, the same on every render), alphabetical.
 */
export function clozeOptions(bank: readonly string[], base: string, index: number): string[] {
  const others = [...new Set(bank)].filter((word) => !isRightChoice(word, base))
  if (others.length < MAX_CLOZE_OPTIONS) return [base, ...others].sort(byWord)
  const start = (Math.max(0, index) * (MAX_CLOZE_OPTIONS - 1)) % others.length
  const picked = Array.from({ length: MAX_CLOZE_OPTIONS - 1 }, (_, i) => others[(start + i) % others.length] ?? '')
  return [base, ...picked].sort(byWord)
}

export type ChoiceState = 'idle' | 'right' | 'wrong'

export interface ClozeChoice {
  readonly text: string
  readonly state: ChoiceState
}

export interface ClozeView {
  /** Key in the page's answers map. */
  readonly key: string
  readonly n: number
  readonly before: string
  readonly after: string
  /** In the blank: the sentence's own form when right, the choice when wrong, '' before an answer. */
  readonly fill: string
  readonly state: ChoiceState
  readonly choices: readonly ClozeChoice[]
  /** The sentence in Chinese, shown once it is answered right. */
  readonly zh: string
  readonly aria: string
}

export const clozeKey = (index: number): string => `c${index}`

/** The cloze questions with the page's answers (`answers[key]` = the last choice). */
export function clozeViews(exercises: Exercises, answers: Readonly<Record<string, string>>): ClozeView[] {
  return exercises.cloze.map((question, index) => {
    const key = clozeKey(index)
    const picked = answers[key] ?? ''
    const state: ChoiceState = picked === '' ? 'idle' : isRightChoice(picked, question.base) ? 'right' : 'wrong'
    return {
      key,
      n: index + 1,
      before: question.before,
      after: question.after,
      fill: state === 'right' ? question.answer : picked,
      state,
      choices: clozeOptions(exercises.bank, question.base, index).map((text) => ({
        text,
        state: text === picked ? state : 'idle',
      })),
      zh: state === 'right' ? question.zh : '',
      aria: `第 ${index + 1} 题的选项`,
    }
  })
}

/** An answer is final once right: later taps on that question change nothing. */
export function answerCloze(
  answers: Readonly<Record<string, string>>,
  exercises: Exercises,
  key: string,
  choice: string,
): Readonly<Record<string, string>> {
  const index = Number(key.slice(1))
  const question = Number.isInteger(index) ? exercises.cloze[index] : undefined
  if (question === undefined || choice.trim() === '') return answers
  const previous = answers[key]
  if (previous !== undefined && isRightChoice(previous, question.base)) return answers
  return { ...answers, [key]: choice }
}

/** "答对 2 / 8", or "共 8 题" before any answer. */
export function clozeScore(views: readonly ClozeView[]): string {
  const answered = views.filter((view) => view.state !== 'idle')
  if (answered.length === 0) return `共 ${views.length} 题`
  return `答对 ${views.filter((view) => view.state === 'right').length} / ${views.length}`
}

export interface RevealView {
  readonly key: string
  readonly n: number
  readonly prompt: string
  readonly answer: string
}

/** 中译英: the Chinese is the prompt; keys t0, t1, … */
export function translateViews(exercises: Exercises): RevealView[] {
  return exercises.translate.map((item, index) => ({ key: `t${index}`, n: index + 1, prompt: item.zh, answer: item.answer }))
}

/** 改错: the wrong sentence is the prompt; keys f0, f1, … */
export function fixViews(exercises: Exercises): RevealView[] {
  return exercises.fix.map((item, index) => ({ key: `f${index}`, n: index + 1, prompt: item.wrong, answer: item.right }))
}

/** How many exercises a material has (the 练习 count). */
export function exerciseCount(exercises: Exercises): number {
  return exercises.cloze.length + exercises.translate.length + exercises.fix.length
}
