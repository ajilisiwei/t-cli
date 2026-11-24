/**
 * <t-speak-icon phase="{{speakPhase}}" tone="accent" size="30" />: the icon of
 * every 朗读 button. idle → the speaker; loading (audio downloading) → three
 * dots pulsing in turn; playing → three bars bouncing like a level meter.
 * `phase` is a SpeechPhase (lib/speaker.ts) that pages take from
 * services/speech.ts. Decorative: the tappable parent carries the tap and the
 * aria-label. Colours come from lib/palette.ts (Skyline has no currentColor)
 * and follow the current theme and accent (主题色).
 */
import { iconPath, toneColor } from '../../lib/palette'
import { currentLook, followLook, unfollowTheme, type Look } from '../../services/theme'

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
    src: '',
    boxStyle: '',
    barStyle: '',
  },
  observers: {
    'phase, tone, size'() {
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
      const { theme, accent } = look
      const { phase, tone, size } = this.data
      const width = Math.max(3, Math.round(size * BAR_WIDTH))
      // Loading draws dots: bars as tall as they are wide.
      const height = phase === 'playing' ? Math.round(size * BAR_HEIGHT) : width
      this.setData({
        src: iconPath('speaker', tone, theme, accent),
        boxStyle: `width: ${size}rpx; height: ${size}rpx; gap: ${Math.round(size * BAR_GAP)}rpx;`,
        barStyle:
          `width: ${width}rpx; height: ${height}rpx; border-radius: ${width / 2}rpx; ` +
          `background-color: ${toneColor(tone, theme, accent)};`,
      })
    },
  },
})
