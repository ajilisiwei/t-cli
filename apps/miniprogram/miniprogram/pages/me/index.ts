/**
 * 我的: records, settings, devices and approving a CLI login.
 */
import { errorMessage } from '../../lib/api'
import type { ExplanationLang } from '../../lib/types'
import { parseUserCode } from '../../lib/user-code'
import { apiBaseUrl, envVersion } from '../../services/platform'
import { explanationLang, refreshSettings, setExplanationLang } from '../../services/settings'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'

interface MeData {
  theme: Theme
  lang: ExplanationLang
  saving: boolean
  /** Shown only in the develop environment, so it is obvious which server is in use. */
  serverLabel: string
}

const initialData: MeData = {
  theme: currentTheme(),
  lang: 'zh',
  saving: false,
  serverLabel: '',
}

const AUTHORIZE_PAGE = '/pages/authorize/index'

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({
      theme: currentTheme(),
      serverLabel: envVersion() === 'develop' ? apiBaseUrl() : '',
    })
  },

  onShow() {
    this.setData({ lang: explanationLang() })
    // Another client may have changed it; quiet when offline.
    refreshSettings()
      .then((lang) => {
        if (!this.data.saving) this.setData({ lang })
      })
      .catch(() => undefined)
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  onHistory() {
    wx.navigateTo({ url: '/pages/history/index', fail: () => undefined })
  },

  onDevices() {
    wx.navigateTo({ url: '/pages/devices/index', fail: () => undefined })
  },

  onTypeCode() {
    wx.navigateTo({ url: AUTHORIZE_PAGE, fail: () => undefined })
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
        wx.navigateTo({ url: `${AUTHORIZE_PAGE}?code=${code}`, fail: () => undefined })
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
})
