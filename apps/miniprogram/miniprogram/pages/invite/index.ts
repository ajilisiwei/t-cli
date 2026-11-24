/**
 * First run for a new WeChat identity: the server answered `INVITE_REQUIRED`.
 * An invite code creates the account and goes straight to 翻译 — no profile
 * to fill in.
 */
import { errorMessage } from '../../lib/api'
import { hasSession, loginWithInvite } from '../../services/session'
import { syncSettings } from '../../services/settings'
import { bindPageLook, currentTheme, type Theme } from '../../services/theme'

interface InviteData {
  theme: Theme
  code: string
  busy: boolean
  errorText: string
}

const initialData: InviteData = {
  theme: currentTheme(),
  code: '',
  busy: false,
  errorText: '',
}

const TRANSLATE_PAGE = '/pages/translate/index'

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = bindPageLook(this)
    this.setData({ theme: currentTheme() })
  },

  onShow() {
    if (hasSession()) wx.reLaunch({ url: TRANSLATE_PAGE, fail: () => undefined })
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  onInput(event: WechatMiniprogram.Input) {
    this.setData({ code: event.detail.value, errorText: '' })
  },

  async onSubmit() {
    const code = this.data.code.trim()
    if (code === '' || this.data.busy) return
    this.setData({ busy: true, errorText: '' })
    try {
      await loginWithInvite(code)
      // A new account: push anything set on this phone before, take the account's defaults for the rest.
      void syncSettings()
      wx.reLaunch({ url: TRANSLATE_PAGE, fail: () => undefined })
    } catch (error: unknown) {
      this.setData({ errorText: errorMessage(error) })
    } finally {
      this.setData({ busy: false })
    }
  },
})
