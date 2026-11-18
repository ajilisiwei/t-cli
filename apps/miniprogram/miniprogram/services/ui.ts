/**
 * Small promise wrappers over WeChat's toast and modal.
 */

export function toast(message: string): void {
  wx.showToast({ title: message, icon: 'none', duration: 2500, fail: () => undefined })
}

export interface ConfirmOptions {
  readonly title: string
  readonly content: string
  readonly confirmText?: string
  readonly cancelText?: string
  readonly destructive?: boolean
}

/** Resolves true for confirm, false for cancel or a dismissed dialog. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: options.title,
      content: options.content,
      confirmText: options.confirmText ?? '确定',
      cancelText: options.cancelText ?? '取消',
      ...(options.destructive === true ? { confirmColor: '#9c3426' } : {}),
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    })
  })
}
