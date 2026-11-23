/**
 * <t-icon name="speaker" tone="accent" size="32" />: one icon of the generated
 * set (scripts/icons.mjs) in the current theme's colour. `tone` is a palette
 * entry (ink, muted, accent, danger, accentInk); `size` is in rpx. Decorative:
 * the tappable parent carries the aria-label.
 */
import { iconPath, type Theme } from '../../lib/palette'
import { currentTheme, watchTheme } from '../../services/theme'

/** Theme subscriptions per mounted icon, dropped when it detaches. */
const subscriptions = new WeakMap<object, () => void>()

Component({
  properties: {
    name: { type: String, value: '' },
    tone: { type: String, value: 'ink' },
    size: { type: Number, value: 40 },
  },
  data: {
    src: '',
    // The right theme before `attached`, so the first paint uses it.
    theme: currentTheme() as Theme,
  },
  observers: {
    'name, tone'() {
      this.refresh(this.data.theme)
    },
  },
  lifetimes: {
    attached() {
      subscriptions.set(
        this,
        watchTheme((theme) => this.refresh(theme)),
      )
      this.refresh(currentTheme())
    },
    detached() {
      subscriptions.get(this)?.()
      subscriptions.delete(this)
    },
  },
  methods: {
    refresh(theme: Theme) {
      const src = iconPath(this.data.name, this.data.tone, theme)
      if (src !== this.data.src || theme !== this.data.theme) this.setData({ src, theme })
    },
  },
})
