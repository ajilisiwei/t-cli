/**
 * The navigation bar. Skyline pages have no native bar (`navigationStyle:
 * custom`), so this one sits below the status bar and lines up with the
 * capsule button: its height mirrors the capsule's vertical margins.
 */
const DEFAULT_STATUS_BAR = 20
const DEFAULT_BAR = 44

const measure = (): { statusBarHeight: number; barHeight: number } => {
  let statusBarHeight = DEFAULT_STATUS_BAR
  let barHeight = DEFAULT_BAR
  try {
    statusBarHeight = wx.getWindowInfo().statusBarHeight || DEFAULT_STATUS_BAR
    const capsule = wx.getMenuButtonBoundingClientRect()
    if (capsule.height > 0 && capsule.top >= statusBarHeight) {
      barHeight = (capsule.top - statusBarHeight) * 2 + capsule.height
    }
  } catch {
    // Defaults fit most phones.
  }
  return { statusBarHeight, barHeight }
}

Component({
  properties: {
    title: { type: String, value: '' },
    back: { type: Boolean, value: false },
  },
  data: {
    statusBarHeight: DEFAULT_STATUS_BAR,
    barHeight: DEFAULT_BAR,
  },
  lifetimes: {
    attached() {
      this.setData(measure())
    },
  },
  methods: {
    onBack() {
      wx.navigateBack({
        // Opened directly (e.g. after a relaunch): there is nothing to go back to.
        fail: () => wx.switchTab({ url: '/pages/me/index', fail: () => undefined }),
      })
    },
  },
})
