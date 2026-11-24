/**
 * <t-speak-icon phase="{{speakPhase}}" tone="accent" size="30" />: the icon of
 * every 朗读 button. idle → the speaker; loading (audio downloading) → three
 * dots pulsing in turn; playing → three bars bouncing like a level meter.
 * `phase` is a SpeechPhase (lib/speaker.ts) that pages take from
 * services/speech.ts. Decorative: the tappable parent carries the tap and the
 * aria-label. Colours come from lib/palette.ts (Skyline has no currentColor).
 */
import { iconPath, toneColor, type Theme } from '../../lib/palette'
import { currentTheme, followTheme, unfollowTheme } from '../../services/theme'

/** Bar width, gap and full height as shares of `size`. */
const BAR_WIDTH = 0.16
const BAR_GAP = 0.12
const BAR_HEIGHT = 0.72

Component({
  properties: {
    phase: { type: String, value: 'idle' },
    tone: { type: String, value: 'accent' },
    size: { type: Number, value: 32 },
  },
  data: {
    // The right theme before `attached`, so the first paint uses it.
    theme: currentTheme() as Theme,
    src: '',
    boxStyle: '',
    barStyle: '',
  },
  observers: {
    'phase, tone, size'() {
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
      const { phase, tone, size } = this.data
      const width = Math.max(3, Math.round(size * BAR_WIDTH))
      // Loading draws dots: bars as tall as they are wide.
      const height = phase === 'playing' ? Math.round(size * BAR_HEIGHT) : width
      this.setData({
        theme,
        src: iconPath('speaker', tone, theme),
        boxStyle: `width: ${size}rpx; height: ${size}rpx; gap: ${Math.round(size * BAR_GAP)}rpx;`,
        barStyle:
          `width: ${width}rpx; height: ${height}rpx; border-radius: ${width / 2}rpx; ` +
          `background-color: ${toneColor(tone, theme)};`,
      })
    },
  },
})
