/**
 * Text handed from one tab to another (纠错 → "去翻译"). `wx.switchTab`
 * cannot carry a query string, so the text waits here until the target page
 * shows.
 */

let pendingTranslation: string | null = null

export function handOffToTranslate(text: string): void {
  pendingTranslation = text
}

export function takeTranslationHandOff(): string | null {
  const text = pendingTranslation
  pendingTranslation = null
  return text
}
