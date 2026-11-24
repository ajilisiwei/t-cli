/**
 * 单词详情: one word's lexicon entry (`POST /v1/lookup`) and the user's records of it.
 * Stub so the app compiles; the word-detail feature fills it in (docs/v2-plan.html, section 8).
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
