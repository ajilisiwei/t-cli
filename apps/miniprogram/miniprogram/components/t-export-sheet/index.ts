/**
 * <t-export-sheet open="{{exportOpen}}" input="{{exportInput}}" bind:close bind:exported />:
 * 导出 PDF as a bottom sheet over the page. Options (what to export, 阅读版 /
 * 练习版 for materials, 显示音标, 大字号) → 正在排版 → the file (发给微信好友,
 * 预览), or the error with 重试. `input` is an ExportInput (lib/pdf-export.ts);
 * the sheet resets to it each time it opens.
 *
 * The export runs in services/pdf.ts, which stores the record itself: closing
 * the sheet (or leaving the page) while it works loses nothing — the file
 * appears in 导出记录. 发给微信好友 calls `wx.shareFileMessage` straight from
 * the tap, as WeChat requires.
 *
 * The host page's root is `position: relative` (the sheet is absolutely
 * placed over it); app.wxss pieces (.btn, .switch) apply here
 * (styleIsolation apply-shared).
 */
import { formatBytes } from '../../lib/account'
import { errorMessage, isApiError } from '../../lib/api'
import type { ExportLayout } from '../../lib/learn-types'
import {
  DEFAULT_EXPORT_OPTIONS,
  LAYOUT_HINTS,
  estimatePages,
  exportErrorText,
  exportRequest,
  fileSummary,
  initialChoice,
  scopeChoices,
  type ExportInput,
  type ExportOptions,
  type ScopeChoice,
  type SheetScope,
} from '../../lib/pdf-export'
import { exportFileExists, exportPdf, openExportFile, shareExportFile } from '../../services/pdf'
import { safeBottomInset } from '../../services/platform'
import { toast } from '../../services/ui'

type Step = 'options' | 'working' | 'done' | 'error'

interface ChoiceView {
  id: SheetScope
  label: string
  hint: string
  checked: boolean
}

interface LayoutView {
  id: ExportLayout
  label: string
  checked: boolean
}

interface FileView {
  path: string
  fileName: string
  summary: string
}

interface SheetData {
  step: Step
  choiceId: SheetScope | ''
  choices: ChoiceView[]
  showLayout: boolean
  layouts: LayoutView[]
  layoutHint: string
  layout: ExportLayout
  ipa: boolean
  large: boolean
  pages: number
  file: FileView | null
  errorText: string
  safeBottom: number
  /** Bumped on every open and generate, so a late answer for an old run is ignored. */
  run: number
}

const LAYOUTS: readonly { id: ExportLayout; label: string }[] = [
  { id: 'read', label: '阅读版' },
  { id: 'practice', label: '练习版' },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `input` property as an ExportInput (the page builds it with lib/pdf-export.ts). */
const readInput = (value: unknown): ExportInput => {
  const input = isRecord(value) ? value : {}
  const origin = input['origin'] === 'material' || input['origin'] === 'selection' ? input['origin'] : 'home'
  return {
    origin,
    selection: Array.isArray(input['selection']) ? (input['selection'] as ExportInput['selection']) : [],
    week: Array.isArray(input['week']) ? (input['week'] as ExportInput['week']) : [],
    initial: typeof input['initial'] === 'string' ? (input['initial'] as SheetScope) : 'one',
  }
}

const layoutViews = (layout: ExportLayout): LayoutView[] =>
  LAYOUTS.map((option) => ({ id: option.id, label: option.label, checked: option.id === layout }))

const errorText = (error: unknown): string =>
  (isApiError(error) ? exportErrorText(error.code, error.details) : null) ?? errorMessage(error)

const initialData: SheetData = {
  step: 'options',
  choiceId: '',
  choices: [],
  showLayout: false,
  layouts: layoutViews(DEFAULT_EXPORT_OPTIONS.layout),
  layoutHint: LAYOUT_HINTS[DEFAULT_EXPORT_OPTIONS.layout],
  layout: DEFAULT_EXPORT_OPTIONS.layout,
  ipa: DEFAULT_EXPORT_OPTIONS.ipa,
  large: DEFAULT_EXPORT_OPTIONS.large,
  pages: 1,
  file: null,
  errorText: '',
  safeBottom: 0,
  run: 0,
}

Component({
  properties: {
    open: { type: Boolean, value: false },
    input: { type: Object, value: {} },
  },
  data: initialData,
  observers: {
    open(open: boolean) {
      if (open) this.reset()
    },
  },
  lifetimes: {
    attached() {
      this.setData({ safeBottom: safeBottomInset() })
    },
  },
  methods: {
    choices(): ScopeChoice[] {
      return scopeChoices(readInput(this.data.input))
    },

    currentChoice(): ScopeChoice | null {
      return this.choices().find((choice) => choice.id === this.data.choiceId) ?? null
    },

    exportOptions(): ExportOptions {
      return { layout: this.data.layout, ipa: this.data.ipa, large: this.data.large }
    },

    reset() {
      const choices = this.choices()
      const first = initialChoice(choices, readInput(this.data.input).initial)
      this.setData({ step: 'options', file: null, errorText: '', run: this.data.run + 1, ...DEFAULT_EXPORT_OPTIONS })
      this.render(first?.id ?? '')
    },

    /** Re-renders the options for `choiceId` and the current toggles. */
    render(choiceId: SheetScope | '') {
      const choices = this.choices()
      const choice = choices.find((candidate) => candidate.id === choiceId) ?? null
      const { layout, large } = this.data
      this.setData({
        choiceId,
        choices: choices.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          hint: candidate.hint,
          checked: candidate.id === choiceId,
        })),
        showLayout: choice?.layout === true,
        layouts: layoutViews(layout),
        layoutHint: LAYOUT_HINTS[layout],
        pages: choice === null ? 1 : estimatePages(choice, { large }),
      })
    },

    onPick(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: SheetScope }>) {
      const id = event.currentTarget.dataset.id
      if (id !== undefined && id !== this.data.choiceId) this.render(id)
    },

    onLayout(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: ExportLayout }>) {
      const id = event.currentTarget.dataset.id
      if (id === undefined || id === this.data.layout) return
      this.setData({ layout: id })
      this.render(this.data.choiceId)
    },

    onToggle(event: WechatMiniprogram.BaseEvent<Record<string, never>, { key?: string }>) {
      const key = event.currentTarget.dataset.key
      if (key === 'ipa') this.setData({ ipa: !this.data.ipa })
      else if (key === 'large') this.setData({ large: !this.data.large })
      else return
      this.render(this.data.choiceId)
    },

    async onGenerate() {
      const choice = this.currentChoice()
      if (choice === null || this.data.step === 'working') return
      const run = this.data.run + 1
      this.setData({ step: 'working', errorText: '', run })
      try {
        const record = await exportPdf(exportRequest(choice, this.exportOptions()))
        this.triggerEvent('exported', { path: record.path })
        if (run !== this.data.run) return
        if (!this.data.open) {
          toast('PDF 已生成，在导出记录里')
          return
        }
        this.setData({
          step: 'done',
          file: { path: record.path, fileName: record.fileName, summary: fileSummary(record.pages, formatBytes(record.bytes)) },
        })
      } catch (error: unknown) {
        if (run !== this.data.run) return
        if (!this.data.open) {
          toast(`导出没有成功：${errorText(error)}`)
          return
        }
        this.setData({ step: 'error', errorText: errorText(error) })
      }
    },

    /** Straight from the tap: `wx.shareFileMessage` needs the tap's user gesture. */
    onShare() {
      const file = this.data.file
      if (file === null) return
      if (!exportFileExists(file.path)) {
        toast('文件已被清理，请重新导出')
        this.setData({ step: 'options', file: null })
        return
      }
      shareExportFile(file)
        .then((sent) => {
          if (sent) toast('已发送')
        })
        .catch((error: unknown) => toast(errorMessage(error, { LOCAL_FILE: '发送失败，请重试' })))
    },

    onPreview() {
      const file = this.data.file
      if (file === null) return
      openExportFile(file).catch((error: unknown) => toast(errorMessage(error, { LOCAL_FILE: '打不开这个文件，请重新导出' })))
    },

    onRestart() {
      this.setData({ step: 'options', file: null, errorText: '' })
      this.render(this.data.choiceId)
    },

    onClose() {
      this.triggerEvent('close', {})
    },
  },
})
