/**
 * <t-stars level="{{stars}}" size="32" bind:change="onStars" />: a note's
 * importance (重要程度) as four stars, filled up to `level` (0–4; 0 = not
 * saved). Tapping star N emits `change` with `{ level: N }` when N differs
 * from `level`. Controlled: it shows `level` and never changes it itself, so
 * the page decides (save, update, or ignore offline). Where it sits — beside
 * the bookmark in a wide action bar, or on its own line under a narrow row —
 * is the parent's layout. Each star is a tap target of at least 30×36 px.
 */

const MAX_STARS = 4

interface StarView {
  n: number
  filled: boolean
  label: string
}

const clampLevel = (level: number): number =>
  Number.isFinite(level) ? Math.min(MAX_STARS, Math.max(0, Math.round(level))) : 0

const starsFor = (level: number): StarView[] =>
  Array.from({ length: MAX_STARS }, (_, i) => ({ n: i + 1, filled: i < level, label: `重要程度 ${i + 1} 星` }))

Component({
  properties: {
    level: { type: Number, value: 0 },
    /** Icon size in rpx; the tap target stays at least 30×36 px. */
    size: { type: Number, value: 32 },
  },
  data: {
    stars: starsFor(0),
  },
  observers: {
    level(level: number) {
      this.setData({ stars: starsFor(clampLevel(level)) })
    },
  },
  methods: {
    onTap(event: WechatMiniprogram.BaseEvent<Record<string, never>, { n?: number }>) {
      const n = Number(event.currentTarget.dataset.n)
      if (!Number.isInteger(n) || n < 1 || n > MAX_STARS) return
      if (n === clampLevel(this.data.level)) return
      this.triggerEvent('change', { level: n })
    },
  },
})
