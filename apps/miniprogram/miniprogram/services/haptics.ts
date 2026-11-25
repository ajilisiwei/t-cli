/**
 * Light haptic feedback for a choice that just took effect: a review rating,
 * a star level, a saved note, a cloze answer. Never for plain navigation, so
 * it stays meaningful. Silent where the phone or base library lacks it.
 */
export function confirmTap(): void {
  wx.vibrateShort({ type: 'light', fail: () => undefined })
}
