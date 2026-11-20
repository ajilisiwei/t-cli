/** 学习单元 — phase-0 stub, owned by the mp-library agent (docs/api-v1.md, "Learning"). */
import { currentTheme, type Theme } from '../../services/theme'

interface StubData {
  theme: Theme
}

const initialData: StubData = { theme: currentTheme() }

Page({
  data: initialData,
})
