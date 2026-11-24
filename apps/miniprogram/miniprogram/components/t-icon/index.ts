/**
 * <t-icon name="speaker" tone="accent" size="32" />: one icon of the generated
 * set (scripts/icons.mjs) in the current theme's colour; `accent` follows the
 * current accent (主题色). `tone` is a palette entry (ink, muted, accent,
 * danger, accentInk); `size` is in rpx. Decorative: the tappable parent
 * carries the aria-label.
 */
import { iconPath } from '../../lib/palette'
import { currentLook, followLook, unfollowTheme, type Look } from '../../services/theme'

Component({
  properties: {
    name: { type: String, value: '' },
    tone: { type: String, value: 'ink' },
    size: { type: Number, value: 40 },
  },
  data: {
    src: '',
  },
  observers: {
    'name, tone'() {
      this.refresh(currentLook())
    },
  },
  lifetimes: {
    attached() {
      followLook(this, (look) => this.refresh(look))
      this.refresh(currentLook())
    },
    detached() {
      unfollowTheme(this)
    },
  },
  methods: {
    refresh(look: Look) {
      const src = iconPath(this.data.name, this.data.tone, look.theme, look.accent)
      if (src !== this.data.src) this.setData({ src })
    },
  },
})
