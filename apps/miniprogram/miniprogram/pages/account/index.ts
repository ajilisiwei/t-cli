/**
 * 账号与数据: export every record as Markdown (to send to 文件传输助手) and
 * delete the account.
 *
 * Export is two taps on purpose: the first builds the file, the second sends
 * it — `wx.shareFileMessage` has to run directly in a tap handler, which an
 * awaited download in between would break. Deletion asks twice, then clears
 * this phone and relaunches the app like a first start.
 */
import { formatBytes } from '../../lib/account'
import { errorMessage, isApiError } from '../../lib/api'
import {
  clearLocalData,
  deleteAccount,
  exportFileExists,
  exportRecords,
  shareExportFile,
  type ExportFile,
} from '../../services/account'
import { fetchMe } from '../../services/endpoints'
import { redirectIfInviteRequired } from '../../services/session'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { confirm, toast } from '../../services/ui'

const ENTRY_PAGE = '/pages/translate/index'

interface AccountData {
  theme: Theme
  /** "2026年11月1日" — when the account was created; '' until known. */
  since: string
  exporting: boolean
  /** The file ready to send, or null. */
  fileName: string
  fileSize: string
  exportError: string
  deleting: boolean
  deleteError: string
}

const initialData: AccountData = {
  theme: currentTheme(),
  since: '',
  exporting: false,
  fileName: '',
  fileSize: '',
  exportError: '',
  deleting: false,
  deleteError: '',
}

const EXPORT_ERRORS: Readonly<Record<string, string>> = {
  // The server's retry-after is up to an hour: seconds would read badly.
  RATE_LIMITED: '每小时最多导出 3 次，请稍后再试',
  LOCAL_FILE: '手机存储空间不足，无法保存文件',
}

const formatDay = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

Page({
  data: initialData,
  file: null as ExportFile | null,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({ theme: currentTheme() })
    fetchMe()
      .then((me) => this.setData({ since: formatDay(me.createdAt) }))
      .catch((error: unknown) => {
        if (!redirectIfInviteRequired(error)) console.warn('[account] me failed', error)
      })
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  async onExport() {
    if (this.data.exporting || this.data.deleting) return
    this.setData({ exporting: true, exportError: '' })
    try {
      const file = await exportRecords()
      this.file = file
      this.setData({ fileName: file.fileName, fileSize: formatBytes(file.bytes) })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ exportError: errorMessage(error, EXPORT_ERRORS) })
    } finally {
      this.setData({ exporting: false })
    }
  },

  /** Runs straight from the tap: `wx.shareFileMessage` needs the tap's user gesture. */
  onShare() {
    const file = this.file
    if (file === null) return
    if (!exportFileExists(file.path)) {
      this.file = null
      this.setData({ fileName: '', fileSize: '' })
      toast('文件已被清理，请重新导出')
      return
    }
    shareExportFile(file)
      .then((sent) => {
        if (sent) toast('已发送')
      })
      .catch((error: unknown) => toast(errorMessage(error, { LOCAL_FILE: '发送失败，请重试' })))
  },

  async onDelete() {
    if (this.data.deleting || this.data.exporting) return
    const first = await confirm({
      title: '注销账号',
      content: '账号和它的全部数据都会删除，无法恢复。确定要继续吗？',
      confirmText: '继续',
      destructive: true,
    })
    if (!first) return
    const second = await confirm({
      title: '最后确认',
      content: '确认永久删除账号和全部记录？电脑上的 t-cli 也会退出登录。',
      confirmText: '永久注销',
      cancelText: '再想想',
      destructive: true,
    })
    if (!second) return
    this.setData({ deleting: true, deleteError: '' })
    try {
      await deleteAccount()
    } catch (error: unknown) {
      // INVITE_REQUIRED: signing in again found no account, so it is already gone.
      if (!isApiError(error) || error.code !== 'INVITE_REQUIRED') {
        this.setData({ deleting: false, deleteError: errorMessage(error) })
        return
      }
    }
    clearLocalData()
    wx.showModal({
      title: '账号已注销',
      content: '这台手机上的记录和设置也已清除。',
      showCancel: false,
      confirmText: '好',
      complete: () => wx.reLaunch({ url: ENTRY_PAGE, fail: () => undefined }),
    })
  },
})
