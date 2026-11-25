/**
 * 拓展资料: the item checklist (加入复习 only what is ticked; items the account
 * already has show 已在复习 and cannot be ticked), the adopt result and the
 * page's wording. Pure; selection is a boolean per item index, because
 * `POST …/adopt` takes indexes.
 */
import type { AdoptResult, ExtendContent, ExtendFocus } from './learn-types'

/** The contract takes 1–10 indexes per adoption. */
export const MAX_ADOPT = 10

export const FOCUS_LABELS: Readonly<Record<ExtendFocus, string>> = {
  topic: '主题词汇',
  family: '同族词',
  grammar: '语法',
  reading: '阅读',
}

/** Every item not known yet is ticked at first. */
export function initialSelection(known: readonly boolean[]): boolean[] {
  return known.map((isKnown) => !isKnown)
}

/** `selected` with item `index` switched; known items stay unticked. */
export function toggleItem(selected: readonly boolean[], known: readonly boolean[], index: number): boolean[] {
  if (index < 0 || index >= selected.length || known[index] === true) return [...selected]
  return selected.map((on, i) => (i === index ? !on : on))
}

/** All ticked (or nothing left to tick). */
export function allSelected(selected: readonly boolean[], known: readonly boolean[]): boolean {
  return known.every((isKnown, i) => isKnown || selected[i] === true)
}

/** 全选 / 全不选. */
export function selectAll(known: readonly boolean[], on: boolean): boolean[] {
  return known.map((isKnown) => on && !isKnown)
}

/** Ticked indexes to adopt (at most 10). */
export function chosenIndexes(selected: readonly boolean[], known: readonly boolean[]): number[] {
  return selected.flatMap((on, i) => (on && known[i] !== true ? [i] : [])).slice(0, MAX_ADOPT)
}

/** After adoption: added and already-present items are now known (and no longer ticked). */
export function applyAdopt(known: readonly boolean[], result: AdoptResult): boolean[] {
  const nowKnown = new Set([...result.added, ...result.known])
  return known.map((isKnown, i) => isKnown || nowKnown.has(i))
}

export function adoptedText(result: AdoptResult): string {
  if (result.added.length === 0) return result.known.length > 0 ? '这些已经在复习里了' : '没有加入新的内容'
  return `已加入 ${result.added.length} 条，复习卡片最晚明天出现`
}

/** The main button: "加入复习（6）". */
export function addLabel(count: number): string {
  return count > 0 ? `加入复习（${count}）` : '加入复习'
}

export function dismissText(topicLabel: string): string {
  return `好的，「${topicLabel}」这个主题 30 天内不再推荐。可以在学习计划的「拓展方向」里改回来。`
}

export interface ExtendItemRow {
  readonly index: number
  /** The speech key of its 朗读 button. */
  readonly key: string
  readonly text: string
  readonly gloss: string
  readonly exampleEn: string
  readonly exampleZh: string
  readonly known: boolean
  readonly checked: boolean
  readonly aria: string
}

export function itemRows(
  content: Pick<ExtendContent, 'items'>,
  known: readonly boolean[],
  selected: readonly boolean[],
  keyOf: (index: number, text: string) => string,
): ExtendItemRow[] {
  return content.items.map((item, index) => {
    const isKnown = known[index] === true
    return {
      index,
      key: keyOf(index, item.text),
      text: item.text,
      gloss: item.gloss,
      exampleEn: item.example.en,
      exampleZh: item.example.zh,
      known: isKnown,
      checked: !isKnown && selected[index] === true,
      aria: `把 ${item.text} 加入复习`,
    }
  })
}
