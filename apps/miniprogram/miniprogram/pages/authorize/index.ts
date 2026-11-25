/**
 * 授权 CLI 登录: the CLI's `/login` shows a 6-digit code and a QR code of
 * `tcli://device?code=NNNNNN`. The code arrives here scanned (query `code`)
 * or typed; `device/lookup` names the device asking, the user decides, and
 * `device/approve` sends the decision.
 */
import { errorMessage } from '../../lib/api'
import { normalizeTypedCode, parseUserCode } from '../../lib/user-code'
import { decideDevice, lookupDevice } from '../../services/endpoints'
import { redirectIfInviteRequired } from '../../services/session'
import { bindPageLook, currentTheme, type Theme } from '../../services/theme'
import { confirm, toast } from '../../services/ui'

interface AuthorizeData {
  theme: Theme
  code: string
  busy: boolean
  resultText: string
  /** The last decision was 允许 (resultText marked ✓) rather than 拒绝 (✗). */
  approved: boolean
  errorText: string
}

const initialData: AuthorizeData = {
  theme: currentTheme(),
  code: '',
  busy: false,
  resultText: '',
  approved: false,
  errorText: '',
}

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  NOT_FOUND: '授权码无效或已过期，请在终端重新执行 /login',
  VALIDATION_FAILED: '授权码应为 6 位数字',
}

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    this.stopWatchingTheme = bindPageLook(this)
    this.setData({ theme: currentTheme() })
    const code = parseUserCode(query['code'] ?? '')
    if (code !== null) {
      this.setData({ code })
      void this.authorize(code)
    }
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  onInput(event: WechatMiniprogram.Input) {
    const code = event.detail.value.replace(/\D/g, '').slice(0, 6)
    this.setData({ code, errorText: '', resultText: '' })
    if (code.length === 6) void this.authorize(code)
  },

  onConfirm() {
    const code = normalizeTypedCode(this.data.code)
    if (code === null) {
      this.setData({ errorText: CODE_MESSAGES['VALIDATION_FAILED'] ?? '' })
      return
    }
    void this.authorize(code)
  },

  onScan() {
    if (this.data.busy) return
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (result) => {
        const code = parseUserCode(result.result)
        if (code === null) {
          toast('这不是 t-cli 登录二维码')
          return
        }
        this.setData({ code })
        void this.authorize(code)
      },
      fail: () => undefined,
    })
  },

  async authorize(code: string) {
    if (this.data.busy) return
    this.setData({ busy: true, errorText: '', resultText: '' })
    try {
      const { deviceName } = await lookupDevice(code)
      const approve = await confirm({
        title: '授权 CLI 登录',
        content: `允许「${deviceName}」登录你的 t-cli 账号吗？`,
        confirmText: '允许',
        cancelText: '拒绝',
      })
      const decision = await decideDevice(code, approve)
      this.setData({
        code: '',
        approved: decision.approved,
        resultText: decision.approved
          ? `已允许「${decision.deviceName}」登录，回到终端即可继续。`
          : `已拒绝「${decision.deviceName}」。`,
      })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ errorText: errorMessage(error, CODE_MESSAGES) })
    } finally {
      this.setData({ busy: false })
    }
  },
})
