/**
 * 笔记本 (tab): the user's saved words, phrases and sentences with their stars.
 * Stub so the app compiles; the notebook feature fills it in (docs/v2-plan.html, section 8).
 */
import { currentTheme, watchTheme, type Theme } from '../../services/theme'

interface StubData {
  theme: Theme
}

const initialData: StubData = { theme: currentTheme() }

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({ theme: currentTheme() })
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },
})
