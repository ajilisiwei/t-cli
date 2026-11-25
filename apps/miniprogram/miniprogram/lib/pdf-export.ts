/**
 * 导出 PDF (docs/api-v1.md, "PDF export"): the sheet's choices, their page
 * estimates, the request body, the file name and the error wording. Pure;
 * services/pdf.ts sends the request and keeps the file.
 */
import type { ExportLayout, ExportScope, MaterialRef, PdfExportRequest, PrintableKind } from './learn-types'

/** A material as the sheet needs it. */
export interface ExportMaterial {
  readonly kind: PrintableKind
  readonly date: string
  /** Estimated A4 pages of its PDF (practice layout). */
  readonly pages: number
  /** Words, phrases and extension items: the cards it makes. */
  readonly words: number
  /** "11月25日 每日资料". */
  readonly label: string
}

/**
 * Where the sheet was opened: the home tiles (nothing chosen), one material
 * (its detail page or its home card), or a selection in the list.
 */
export type ExportOrigin = 'home' | 'material' | 'selection'

export type SheetScope = 'one' | 'selected' | 'week' | 'cards' | 'checklist'

export interface ExportInput {
  readonly origin: ExportOrigin
  readonly selection: readonly ExportMaterial[]
  /** This week's printable materials, newest first. */
  readonly week: readonly ExportMaterial[]
  readonly initial: SheetScope
}

export interface ScopeChoice {
  readonly id: SheetScope
  readonly label: string
  readonly hint: string
  readonly scope: ExportScope
  readonly materials: readonly ExportMaterial[]
  /** 阅读版 / 练习版 apply (material scopes only). */
  readonly layout: boolean
}

export const MAX_PDF_PAGES = 40
export const CARDS_PER_PAGE = 6
export const CHECKLIST_ROWS_PER_PAGE = 24
/** Exported files stay on the phone this long. */
export const EXPORT_KEEP_DAYS = 7

const wordsOf = (materials: readonly ExportMaterial[]): number =>
  materials.reduce((sum, material) => sum + Math.max(0, material.words), 0)

const sameMaterials = (a: readonly ExportMaterial[], b: readonly ExportMaterial[]): boolean =>
  a.length === b.length && a.every((material, i) => material.kind === b[i]?.kind && material.date === b[i]?.date)

const weekHint = (week: readonly ExportMaterial[]): string =>
  `${week.length} 份${week.some((material) => material.kind === 'extend') ? '（含拓展）' : ''}`

/** The choices for an input, in the sheet's order; empty sources are left out. */
export function scopeChoices(input: ExportInput): ScopeChoice[] {
  const { origin, selection, week } = input
  const choices: ScopeChoice[] = []
  const first = selection[0]
  if (origin !== 'home' && selection.length === 1 && first !== undefined) {
    choices.push({ id: 'one', label: '这份资料', hint: first.label, scope: 'material', materials: selection, layout: true })
  }
  if (origin === 'selection' && selection.length > 1) {
    const hint = `已选 ${selection.length} 份`
    choices.push({ id: 'selected', label: '合并导出', hint, scope: 'material', materials: selection, layout: true })
  }
  if (origin !== 'selection' && week.length > 0 && !sameMaterials(week, selection)) {
    choices.push({ id: 'week', label: '本周合集', hint: weekHint(week), scope: 'material', materials: week, layout: true })
  }
  const cardSource = origin === 'selection' || week.length === 0 ? selection : week
  if (cardSource.length > 0) {
    const where = cardSource === week ? '本周' : '这些资料里'
    choices.push({
      id: 'cards',
      label: '单词卡',
      hint: `${where} ${wordsOf(cardSource)} 个词 · 剪开对折`,
      scope: 'cards',
      materials: cardSource,
      layout: false,
    })
  }
  const checkSource = origin === 'selection' ? selection : []
  choices.push({
    id: 'checklist',
    label: '自测清单',
    hint: checkSource.length === 0 ? '到期和常忘的词 · 对折遮挡' : `这些资料里 ${wordsOf(checkSource)} 个词 · 对折遮挡`,
    scope: 'checklist',
    materials: checkSource,
    layout: false,
  })
  return choices
}

/** The choice to start on: the requested one when offered, else the first. */
export function initialChoice(choices: readonly ScopeChoice[], wanted: SheetScope): ScopeChoice | null {
  return choices.find((choice) => choice.id === wanted) ?? choices[0] ?? null
}

export interface ExportOptions {
  readonly layout: ExportLayout
  readonly ipa: boolean
  readonly large: boolean
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { layout: 'practice', ipa: true, large: false }

const atLeastOne = (n: number): number => Math.max(1, Math.ceil(n))

/** Pages the PDF will have, roughly (the answer's `X-Pdf-Pages` is exact). */
export function estimatePages(choice: ScopeChoice, options: Pick<ExportOptions, 'large'>): number {
  const words = wordsOf(choice.materials)
  const base =
    choice.scope === 'material'
      ? choice.materials.reduce((sum, material) => sum + atLeastOne(material.pages), 0)
      : choice.scope === 'cards'
        ? atLeastOne(words / CARDS_PER_PAGE)
        : choice.materials.length === 0
          ? 1
          : atLeastOne(words / CHECKLIST_ROWS_PER_PAGE)
  return options.large ? base + Math.ceil(base / 4) : base
}

const refsOf = (materials: readonly ExportMaterial[]): MaterialRef[] =>
  materials.map((material) => ({ kind: material.kind, date: material.date }))

/** The body of `POST /v1/exports/pdf`. */
export function exportRequest(choice: ScopeChoice, options: ExportOptions): PdfExportRequest {
  return {
    scope: choice.scope,
    ...(choice.materials.length > 0 ? { materials: refsOf(choice.materials) } : {}),
    ...(choice.scope === 'material' ? { layout: options.layout } : {}),
    ipa: options.ipa,
    large: options.large,
  }
}

export const LAYOUT_HINTS: Readonly<Record<ExportLayout, string>> = {
  read: '释义、答案直接写在旁边，适合通读。',
  practice: '先做练习，答案集中在最后一节，可以沿剪切线剪掉。',
}

// ---- the file ----

const mmdd = (date: string): string => `${date.slice(5, 7)}${date.slice(8, 10)}`

/** The server's naming (学习资料_MMDD.pdf …), used when the answer carries no usable name. */
export function defaultPdfName(request: PdfExportRequest, today: string): string {
  const dates = (request.materials ?? []).map((material) => material.date).sort()
  const first = dates[0] ?? today
  const last = dates[dates.length - 1] ?? today
  if (request.scope === 'cards') return `单词卡_${mmdd(last)}.pdf`
  if (request.scope === 'checklist') return `自测清单_${mmdd(last)}.pdf`
  return first === last ? `学习资料_${mmdd(first)}.pdf` : `学习资料合集_${mmdd(first)}-${mmdd(last)}.pdf`
}

/** No path parts, no control or reserved characters, a `.pdf` ending. */
const SAFE_PDF_NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,96}\.pdf$/i

const decodeExtended = (value: string): string | null => {
  // RFC 5987: charset'lang'percent-encoded
  const match = /^[A-Za-z0-9-]*'[^']*'(.+)$/.exec(value)
  if (match === null || match[1] === undefined) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/** The name to save under: the `Content-Disposition` name when it is safe, else `fallback`. */
export function pdfFileName(contentDisposition: string | null, fallback: string): string {
  if (contentDisposition === null) return fallback
  const extended = /filename\*\s*=\s*"?([^";]+)"?/i.exec(contentDisposition)
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;\s]+)/i.exec(contentDisposition)
  const candidates = [
    extended?.[1] === undefined ? null : decodeExtended(extended[1].trim()),
    plain?.[1] ?? plain?.[2] ?? null,
  ]
  for (const candidate of candidates) {
    const name = candidate?.trim() ?? ''
    if (SAFE_PDF_NAME_RE.test(name) && !name.startsWith('.') && !name.includes('..')) return name
  }
  return fallback
}

/** `X-Pdf-Pages` → the page count; null when absent or not a positive integer. */
export function readPdfPages(header: string | null): number | null {
  const value = header?.trim() ?? ''
  if (!/^\d{1,4}$/.test(value)) return null
  const pages = Number(value)
  return pages > 0 ? pages : null
}

/** "A4 · 3 页 · 386 KB · 保留 7 天" (`size` already formatted). */
export function fileSummary(pages: number | null, size: string): string {
  return ['A4', pages === null ? '' : `${pages} 页`, size, `保留 ${EXPORT_KEEP_DAYS} 天`].filter((part) => part !== '').join(' · ')
}

// ---- errors ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveDetail = (details: unknown, key: string): number | null => {
  if (!isRecord(details)) return null
  const value = details[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null
}

/** The sheet's wording for the export's own error codes; null for the general ones. */
export function exportErrorText(code: string, details: unknown): string | null {
  switch (code) {
    case 'RATE_LIMITED': {
      const seconds = positiveDetail(details, 'retryAfterSeconds')
      const wait = seconds === null ? '请稍后再试' : `请 ${Math.max(1, Math.ceil(seconds / 60))} 分钟后再试`
      return `每小时最多导出 10 次，${wait}`
    }
    case 'TOO_MANY_PAGES': {
      const pages = positiveDetail(details, 'pages')
      const size = pages === null ? '' : `（这次约 ${pages} 页）`
      return `超过 ${MAX_PDF_PAGES} 页${size}。少选几份，或关掉大字号再试。`
    }
    case 'EXPORT_FAILED':
      return '排版没有成功，请重试'
    case 'EXPORT_UNAVAILABLE':
      return '服务器暂时不能生成 PDF'
    case 'LOCAL_FILE':
      return '手机存储空间不足，无法保存文件'
    default:
      return null
  }
}
