/**
 * 我的: records and learning (统计, 周报, 词库), settings, account and
 * devices, and approving a CLI login.
 *
 * Settings are local-first (services/settings.ts): a change is in force at
 * once and saved to the account in the background, so nothing here waits or
 * rolls back. The view re-renders from the settings whenever they change,
 * including when the account's values arrive. 深浅模式 and 阅读模式 open 外观.
 *
 * 复习提醒 appears only when the server has a reminder template: the hour is
 * a setting, and every reminder needs one acceptance of WeChat's subscribe
 * dialog, which can only open from a tap — hence the separate 接收下一次提醒 row.
 */
import {
  REMINDER_OPTIONS,
  SUBSCRIBE_MESSAGES,
  hourToOption,
  optionToHour,
  reminderLabel,
} from '../../lib/account'
import { errorMessage } from '../../lib/api'
import { ACCENT_LABELS, themeModeSummary } from '../../lib/appearance'
import { ACCENTS, DEFAULT_ACCENT, isAccent, paletteFor, type Theme } from '../../lib/palette'
import type { Accent, ExplanationLang, Settings } from '../../lib/types'
import { parseUserCode } from '../../lib/user-code'
import { fetchReminderTemplate, grantReminder, requestReminder } from '../../services/account'
import { confirmTap } from '../../services/haptics'
import { apiBaseUrl, envVersion } from '../../services/platform'
import { changeSettings, currentSettings, syncSettingsSoon, watchSettings } from '../../services/settings'
import { currentLook, watchLook, type Look } from '../../services/theme'
import { toast } from '../../services/ui'

type ToggleKey = 'autoSpeakWord' | 'autoSpeakOnFlip' | 'showDirection' | 'importanceReview'

const LANGS: readonly ExplanationLang[] = ['zh', 'en']
const LANG_OPTIONS: readonly string[] = ['中文', 'English']

interface ReminderView {
  reminderIndex: number
  reminderLabel: string
  reminderOn: boolean
}

interface AccentOption {
  id: Accent
  label: string
  color: string
  checked: boolean
  /** Inline style of the ring: in the swatch's colour when chosen. */
  ringStyle: string
}

interface SettingsView extends ReminderView {
  langIndex: number
  langLabel: string
  autoSpeakWord: boolean
  autoSpeakOnFlip: boolean
  showDirection: boolean
  directionHint: string
  importanceReview: boolean
  accents: AccentOption[]
  themeModeText: string
  readingText: string
}

interface MeData extends SettingsView {
  theme: Theme
  accent: Accent
  accentClass: string
  langOptions: readonly string[]
  /** The server has a reminder template: show 复习提醒. */
  reminderAvailable: boolean
  reminderOptions: readonly string[]
  grantText: string
  granting: boolean
  /** Shown only in the develop environment, so it is obvious which server is in use. */
  serverLabel: string
}

const GRANT_PROMPT = '点此允许'
const AUTHORIZE_PAGE = '/pages/authorize/index'
const APPEARANCE_PAGE = '/pages/appearance/index'

const reminderView = (hour: number | null): ReminderView => ({
  reminderIndex: hourToOption(hour),
  reminderLabel: reminderLabel(hour),
  reminderOn: hour !== null,
})

const accentOptions = (theme: Theme, chosen: Accent): AccentOption[] =>
  ACCENTS.map((id) => {
    const color = paletteFor(theme, id).accent
    const checked = id === chosen
    return {
      id,
      label: id === DEFAULT_ACCENT ? `${ACCENT_LABELS[id]}（默认）` : ACCENT_LABELS[id],
      color,
      checked,
      ringStyle: checked ? `border-color: ${color};` : '',
    }
  })

const settingsView = (theme: Theme): SettingsView => {
  const s = currentSettings()
  const langIndex = Math.max(0, LANGS.indexOf(s.explanationLang))
  return {
    langIndex,
    langLabel: LANG_OPTIONS[langIndex] ?? '',
    autoSpeakWord: s.autoSpeakWord,
    autoSpeakOnFlip: s.autoSpeakOnFlip,
    showDirection: s.showDirection,
    directionHint: s.showDirection
      ? '输入框左下角显示「中文 ⇄ 英文」，点一下切换'
      : '关闭时自动识别：中文译成英文，英文译成中文',
    importanceReview: s.importanceReview,
    accents: accentOptions(theme, s.accent),
    themeModeText: themeModeSummary({
      mode: s.themeMode,
      fixed: s.themeFixed,
      dayStart: s.themeDayStart,
      nightStart: s.themeNightStart,
    }),
    readingText: s.readingMode ? '开' : '关',
    ...reminderView(s.reminderHour),
  }
}

const togglePatch = (key: ToggleKey, value: boolean): Settings => {
  switch (key) {
    case 'autoSpeakWord':
      return { autoSpeakWord: value }
    case 'autoSpeakOnFlip':
      return { autoSpeakOnFlip: value }
    case 'showDirection':
      return { showDirection: value }
    case 'importanceReview':
      return { importanceReview: value }
  }
}

const isToggleKey = (key: unknown): key is ToggleKey =>
  key === 'autoSpeakWord' || key === 'autoSpeakOnFlip' || key === 'showDirection' || key === 'importanceReview'

const initialLook = currentLook()

const initialData: MeData = {
  ...initialLook,
  ...settingsView(initialLook.theme),
  langOptions: LANG_OPTIONS,
  reminderAvailable: false,
  reminderOptions: REMINDER_OPTIONS,
  grantText: GRANT_PROMPT,
  granting: false,
  serverLabel: '',
}

const open = (url: string): void => {
  wx.navigateTo({ url, fail: () => undefined })
}

Page({
  data: initialData,
  /** Undefined until `GET /v1/notify/config` answered; null = reminders off on the server. */
  templateId: undefined as string | null | undefined,
  stopWatching: [] as (() => void)[],

  onLoad() {
    const render = (look: Look): void => this.setData({ ...look, ...settingsView(look.theme) })
    this.stopWatching = [watchLook(render), watchSettings(() => this.setData(settingsView(currentLook().theme)))]
    render(currentLook())
    this.setData({ serverLabel: envVersion() === 'develop' ? apiBaseUrl() : '' })
  },

  onShow() {
    this.setData(settingsView(currentLook().theme))
    // Another client may have changed them; quiet when offline.
    syncSettingsSoon()
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
    for (const stop of this.stopWatching) stop()
    this.stopWatching = []
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

  onAppearance() {
    open(APPEARANCE_PAGE)
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

  onLang(event: WechatMiniprogram.PickerChange) {
    const lang = LANGS[Number(event.detail.value)]
    if (lang === undefined || lang === currentSettings().explanationLang) return
    changeSettings({ explanationLang: lang })
  },

  onToggle(event: WechatMiniprogram.BaseEvent<Record<string, never>, { key?: string }>) {
    const key = event.currentTarget.dataset.key
    if (!isToggleKey(key)) return
    confirmTap()
    changeSettings(togglePatch(key, !currentSettings()[key]))
  },

  onAccent(event: WechatMiniprogram.BaseEvent<Record<string, never>, { accent?: string }>) {
    const accent = event.currentTarget.dataset.accent
    if (!isAccent(accent) || accent === currentSettings().accent) return
    confirmTap()
    changeSettings({ accent })
  },

  onReminderHour(event: WechatMiniprogram.PickerChange) {
    const hour = optionToHour(event.detail.value)
    if (hour === currentSettings().reminderHour) return
    changeSettings({ reminderHour: hour })
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
