/**
 * <t-icon name="speaker" tone="accent" size="32" />: one icon of the generated
 * set (scripts/icons.mjs) in the current theme's colour. `tone` is a palette
 * entry (ink, muted, accent, danger, accentInk); `size` is in rpx. Decorative:
 * the tappable parent carries the aria-label.
 */
import { iconPath, type Theme } from '../../lib/palette'
import { currentTheme, followTheme, unfollowTheme } from '../../services/theme'

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
      followTheme(this, (theme) => this.refresh(theme))
      this.refresh(currentTheme())
    },
    detached() {
      unfollowTheme(this)
    },
  },
  methods: {
    refresh(theme: Theme) {
      const src = iconPath(this.data.name, this.data.tone, theme)
      if (src !== this.data.src || theme !== this.data.theme) this.setData({ src, theme })
    },
  },
})
