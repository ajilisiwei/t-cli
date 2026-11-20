/**
 * 我的: records and learning (统计, 周报, 词库), settings, account and
 * devices, and approving a CLI login.
 *
 * Settings save optimistically and roll back on failure. 复习提醒 appears
 * only when the server has a reminder template: the hour is a setting, and
 * every reminder needs one acceptance of WeChat's subscribe dialog, which
 * can only open from a tap — hence the separate 接收下一次提醒 row.
 */
import {
  REMINDER_OPTIONS,
  SUBSCRIBE_MESSAGES,
  hourToOption,
  optionToHour,
  reminderLabel,
} from '../../lib/account'
import { errorMessage } from '../../lib/api'
import type { ExplanationLang, Settings } from '../../lib/types'
import { parseUserCode } from '../../lib/user-code'
import { fetchReminderTemplate, grantReminder, requestReminder } from '../../services/account'
import { apiBaseUrl, envVersion } from '../../services/platform'
import {
  autoSpeakOnFlip,
  autoSpeakWord,
  explanationLang,
  refreshSettings,
  reminderHour,
  saveSettings,
  setExplanationLang,
} from '../../services/settings'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'

type ToggleKey = 'autoSpeakWord' | 'autoSpeakOnFlip'

interface ReminderView {
  reminderIndex: number
  reminderLabel: string
  reminderOn: boolean
}

interface MeData extends ReminderView {
  theme: Theme
  lang: ExplanationLang
  saving: boolean
  autoSpeakWord: boolean
  autoSpeakOnFlip: boolean
  /** The server has a reminder template: show 复习提醒. */
  reminderAvailable: boolean
  reminderOptions: readonly string[]
  grantText: string
  granting: boolean
  /** Shown only in the develop environment, so it is obvious which server is in use. */
  serverLabel: string
}

const GRANT_PROMPT = '点此允许'

const reminderView = (hour: number | null): ReminderView => ({
  reminderIndex: hourToOption(hour),
  reminderLabel: reminderLabel(hour),
  reminderOn: hour !== null,
})

const initialData: MeData = {
  theme: currentTheme(),
  lang: 'zh',
  saving: false,
  autoSpeakWord: true,
  autoSpeakOnFlip: true,
  reminderAvailable: false,
  reminderOptions: REMINDER_OPTIONS,
  ...reminderView(null),
  grantText: GRANT_PROMPT,
  granting: false,
  serverLabel: '',
}

const AUTHORIZE_PAGE = '/pages/authorize/index'

const settingsView = (): Partial<MeData> => ({
  lang: explanationLang(),
  autoSpeakWord: autoSpeakWord(),
  autoSpeakOnFlip: autoSpeakOnFlip(),
  ...reminderView(reminderHour()),
})

const open = (url: string): void => {
  wx.navigateTo({ url, fail: () => undefined })
}

Page({
  data: initialData,
  /** Undefined until `GET /v1/notify/config` answered; null = reminders off on the server. */
  templateId: undefined as string | null | undefined,
  /** Saves in flight: a background refresh must not overwrite their optimistic values. */
  pendingSaves: 0,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({
      theme: currentTheme(),
      serverLabel: envVersion() === 'develop' ? apiBaseUrl() : '',
    })
  },

  onShow() {
    this.setData(settingsView())
    // Another client may have changed them; quiet when offline.
    refreshSettings()
      .then(() => {
        if (!this.data.saving && this.pendingSaves === 0) this.setData(settingsView())
      })
      .catch(() => undefined)
    if (this.templateId === undefined) {
      fetchReminderTemplate()
        .then((templateId) => {
          this.templateId = templateId
          this.setData({ reminderAvailable: templateId !== null })
        })
        .catch((error: unknown) => console.warn('[me] reminder config unavailable', error))
    }
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  onHistory() {
    open('/pages/history/index')
  },

  onStats() {
    open('/pages/stats/index')
  },

  onWeekly() {
    open('/pages/weekly/index')
  },

  onLibrary() {
    open('/pages/library/index')
  },

  onDevices() {
    open('/pages/devices/index')
  },

  onAccount() {
    open('/pages/account/index')
  },

  onTypeCode() {
    open(AUTHORIZE_PAGE)
  },

  onScan() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (result) => {
        const code = parseUserCode(result.result)
        if (code === null) {
          toast('这不是 t-cli 登录二维码')
          return
        }
        open(`${AUTHORIZE_PAGE}?code=${code}`)
      },
      // Cancelling the scanner is not an error.
      fail: () => undefined,
    })
  },

  onLang(event: WechatMiniprogram.BaseEvent<Record<string, never>, { lang?: string }>) {
    const lang = event.currentTarget.dataset.lang
    if ((lang !== 'zh' && lang !== 'en') || lang === this.data.lang || this.data.saving) return
    const previous = this.data.lang
    this.setData({ lang, saving: true })
    setExplanationLang(lang)
      .then((saved) => this.setData({ lang: saved, saving: false }))
      .catch((error: unknown) => {
        this.setData({ lang: previous, saving: false })
        toast(errorMessage(error))
      })
  },

  /** Saves `patch`; `revert` undoes the optimistic change when the save fails. */
  save(patch: Settings, revert: () => void) {
    this.pendingSaves += 1
    saveSettings(patch)
      .catch((error: unknown) => {
        revert()
        toast(errorMessage(error))
      })
      .finally(() => {
        this.pendingSaves -= 1
      })
  },

  onToggle(event: WechatMiniprogram.BaseEvent<Record<string, never>, { key?: string }>) {
    const key = event.currentTarget.dataset.key
    if (key !== 'autoSpeakWord' && key !== 'autoSpeakOnFlip') return
    const toggleKey: ToggleKey = key
    const next = !this.data[toggleKey]
    this.setData({ [toggleKey]: next })
    this.save({ [toggleKey]: next }, () => this.setData({ [toggleKey]: !next }))
  },

  onReminderHour(event: WechatMiniprogram.PickerChange) {
    const hour = optionToHour(event.detail.value)
    const previous = optionToHour(this.data.reminderIndex)
    if (hour === previous) return
    this.setData(reminderView(hour))
    this.save({ reminderHour: hour }, () => this.setData(reminderView(previous)))
    if (hour !== null && this.data.grantText === GRANT_PROMPT) toast('再点「接收下一次提醒」，允许微信发送')
  },

  /** Straight from the tap: the subscribe dialog only opens from a user gesture. */
  onGrant() {
    const templateId = this.templateId
    if (typeof templateId !== 'string' || this.data.granting) return
    const answer = requestReminder(templateId)
    this.setData({ granting: true })
    answer
      .then(async (outcome) => {
        if (outcome !== 'accept') {
          toast(SUBSCRIBE_MESSAGES[outcome])
          return
        }
        const available = await grantReminder(templateId)
        this.setData({ grantText: `可提醒 ${available} 次` })
        toast('已允许下一次提醒')
      })
      .catch((error: unknown) => toast(errorMessage(error)))
      .finally(() => this.setData({ granting: false }))
  },
})
