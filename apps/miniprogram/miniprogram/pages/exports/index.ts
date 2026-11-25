/**
 * 导出记录: the PDFs this phone keeps (7 days), newest first, each with
 * 发送 (wx.shareFileMessage, straight from the tap), 预览 (wx.openDocument
 * with its menu: save, open elsewhere, print) and 删除. Opening the page
 * deletes expired files and forgets records whose file the system removed.
 */
import { errorMessage } from '../../lib/api'
import { recordRow, type RecordRow } from '../../lib/export-records'
import {
  exportFileExists,
  exportSize,
  openExportFile,
  pruneExports,
  removeExport,
  shareExportFile,
  type ExportRecord,
} from '../../services/pdf'
import { bindPageLook, currentLook, type Look } from '../../services/theme'
import { confirm, toast } from '../../services/ui'

interface ExportsData extends Look {
  rows: RecordRow[]
  loaded: boolean
}

const rowsOf = (records: readonly ExportRecord[]): RecordRow[] => {
  const now = Date.now()
  return records.map((record) => recordRow(record, now, (bytes) => exportSize({ bytes })))
}

const initialData: ExportsData = { ...currentLook(), rows: [], loaded: false }

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,
  records: [] as ExportRecord[],

  onLoad() {
    this.stopWatchingTheme = bindPageLook(this)
  },

  onShow() {
    this.show(pruneExports())
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  show(records: readonly ExportRecord[]) {
    this.records = [...records]
    this.setData({ rows: rowsOf(records), loaded: true })
  },

  recordOf(path: string | undefined): ExportRecord | null {
    const record = this.records.find((candidate) => candidate.path === path) ?? null
    if (record !== null && !exportFileExists(record.path)) {
      toast('文件已被清理')
      this.show(pruneExports())
      return null
    }
    return record
  },

  /** Straight from the tap: `wx.shareFileMessage` needs the tap's user gesture. */
  onShare(event: WechatMiniprogram.BaseEvent<Record<string, never>, { path?: string }>) {
    const record = this.recordOf(event.currentTarget.dataset.path)
    if (record === null) return
    shareExportFile(record)
      .then((sent) => {
        if (sent) toast('已发送')
      })
      .catch((error: unknown) => toast(errorMessage(error, { LOCAL_FILE: '发送失败，请重试' })))
  },

  onPreview(event: WechatMiniprogram.BaseEvent<Record<string, never>, { path?: string }>) {
    const record = this.recordOf(event.currentTarget.dataset.path)
    if (record === null) return
    openExportFile(record).catch((error: unknown) => toast(errorMessage(error, { LOCAL_FILE: '打不开这个文件' })))
  },

  async onRemove(event: WechatMiniprogram.BaseEvent<Record<string, never>, { path?: string }>) {
    const path = event.currentTarget.dataset.path
    const record = this.records.find((candidate) => candidate.path === path)
    if (record === undefined) return
    const sure = await confirm({ title: '删除这个文件', content: record.fileName, confirmText: '删除', destructive: true })
    if (sure) this.show(removeExport(record.path))
  },
})
