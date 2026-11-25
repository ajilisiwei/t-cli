/**
 * 拓展资料 (`?date=YYYY-MM-DD&pages=n`; without a date the latest): why it was
 * recommended (reasons written by the server), the items to tick — those
 * already in review show 已在复习 — 加入复习 for the ticked ones, the passage
 * and the grammar note. 不感兴趣 mutes the topic for 30 days (with 撤销), and
 * the PDF button opens the export sheet. Adding marks the material read.
 */
import { errorMessage } from '../../lib/api'
import { localDateKey } from '../../lib/history'
import { activeMuted, TOPIC_LABELS } from '../../lib/learn-plan'
import type { ExtendContent, ExtendMaterial } from '../../lib/learn-types'
import { dayLabel, exportMaterial, exportMaterialOf } from '../../lib/learn-view'
import {
  FOCUS_LABELS,
  addLabel,
  adoptedText,
  allSelected,
  applyAdopt,
  chosenIndexes,
  dismissText,
  initialSelection,
  itemRows,
  selectAll,
  toggleItem,
  type ExtendItemRow,
} from '../../lib/extend-view'
import type { ExportInput, ExportMaterial } from '../../lib/pdf-export'
import { adoptExtend, dismissExtend, fetchExtend, fetchThisWeek, markRead } from '../../services/learn'
import { safeBottomInset } from '../../services/platform'
import { redirectIfInviteRequired } from '../../services/session'
import { currentSettings } from '../../services/settings'
import { bindPageLook, currentLook, type Look } from '../../services/theme'
import { toast } from '../../services/ui'

type Phase = 'loading' | 'ready' | 'none' | 'error'

interface ExtendData extends Look {
  phase: Phase
  errorText: string
  noneText: string
  tagLabel: string
  meta: string
  title: string
  reasons: string[]
  rows: ExtendItemRow[]
  hasSelectable: boolean
  pickAllLabel: string
  addText: string
  addCount: number
  adding: boolean
  passage: ExtendContent['passage']
  showPassageZh: boolean
  grammar: ExtendContent['grammar']
  canDismiss: boolean
  dismissed: boolean
  dismissNotice: string
  dismissing: boolean
  safeBottom: number
  exportOpen: boolean
  exportInput: ExportInput
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** About five items per A4 page, when the list's estimate did not come along. */
const ITEMS_PER_PAGE = 5

const initialData: ExtendData = {
  ...currentLook(),
  phase: 'loading',
  errorText: '',
  noneText: '',
  tagLabel: '拓展',
  meta: '',
  title: '',
  reasons: [],
  rows: [],
  hasSelectable: false,
  pickAllLabel: '全选',
  addText: addLabel(0),
  addCount: 0,
  adding: false,
  passage: null,
  showPassageZh: false,
  grammar: null,
  canDismiss: false,
  dismissed: false,
  dismissNotice: '',
  dismissing: false,
  safeBottom: 0,
  exportOpen: false,
  exportInput: { origin: 'material', selection: [], week: [], initial: 'one' },
}

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,
  material: null as ExtendMaterial | null,
  known: [] as boolean[],
  selected: [] as boolean[],
  listPages: 0,
  week: [] as ExportMaterial[],

  onLoad(options: Record<string, string | undefined>) {
    this.stopWatchingTheme = bindPageLook(this)
    this.listPages = Number(options['pages'] ?? 0) || 0
    this.setData({ safeBottom: safeBottomInset() })
    const date = options['date']
    void this.load(date !== undefined && DATE_RE.test(date) ? date : undefined)
    fetchThisWeek()
      .then((items) => {
        this.week = items.flatMap((item) => exportMaterialOf(item) ?? [])
      })
      .catch((error: unknown) => console.warn('[extend] this week not loaded', error))
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  async load(date?: string): Promise<void> {
    this.setData({ phase: 'loading', errorText: '' })
    try {
      const material = await fetchExtend(date)
      if (material === null) {
        this.setData({ phase: 'none', noneText: date === undefined ? '还没有拓展资料' : '这天没有拓展资料' })
        return
      }
      this.material = material
      this.known = [...material.known]
      this.selected = initialSelection(material.known)
      const { content } = material
      const muted = activeMuted(currentSettings().extendMuted, localDateKey(new Date()))
      const dismissed = muted.some((entry) => entry.topic === content.topic)
      this.setData({
        phase: 'ready',
        tagLabel: `拓展 · ${FOCUS_LABELS[content.focus]}`,
        meta: [dayLabel(material.date), content.level].filter((part) => part !== '').join(' · '),
        title: content.title === '' ? '拓展资料' : content.title,
        reasons: [...content.reasons],
        passage: content.passage,
        grammar: content.grammar,
        canDismiss: content.topic !== 'other',
        dismissed,
        dismissNotice: dismissText(TOPIC_LABELS[content.topic]),
      })
      this.renderItems()
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ phase: 'error', errorText: errorMessage(error) })
    }
  },

  renderItems() {
    const material = this.material
    if (material === null) return
    const count = chosenIndexes(this.selected, this.known).length
    this.setData({
      rows: itemRows(material.content, this.known, this.selected),
      hasSelectable: this.known.some((isKnown) => !isKnown),
      pickAllLabel: allSelected(this.selected, this.known) ? '全不选' : '全选',
      addText: addLabel(count),
      addCount: count,
    })
  },

  onRetry() {
    void this.load(this.material?.date)
  },

  onToggleItem(event: WechatMiniprogram.BaseEvent<Record<string, never>, { index?: number }>) {
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index)) return
    this.selected = toggleItem(this.selected, this.known, index)
    this.renderItems()
  },

  onPickAll() {
    this.selected = selectAll(this.known, !allSelected(this.selected, this.known))
    this.renderItems()
  },

  onTogglePassageZh() {
    this.setData({ showPassageZh: !this.data.showPassageZh })
  },

  async onAdd() {
    const material = this.material
    if (material === null || this.data.adding) return
    const indexes = chosenIndexes(this.selected, this.known)
    if (indexes.length === 0) {
      toast('先勾选要加入复习的')
      return
    }
    this.setData({ adding: true })
    try {
      const result = await adoptExtend(material.date, indexes)
      this.known = applyAdopt(this.known, result)
      this.selected = this.selected.map((on, i) => on && !this.known[i])
      this.renderItems()
      toast(adoptedText(result))
      if (material.readAt === null) void this.markRead(material)
    } catch (error: unknown) {
      toast(errorMessage(error))
    } finally {
      this.setData({ adding: false })
    }
  },

  /** Adding is studying it: 拓展 shows 已学完 in the list afterwards. Quiet. */
  async markRead(material: ExtendMaterial): Promise<void> {
    try {
      const readAt = await markRead('extend', material.date, true)
      this.material = { ...material, readAt }
    } catch (error: unknown) {
      console.warn('[extend] marking read failed', error)
    }
  },

  async onDismiss() {
    const material = this.material
    if (material === null || this.data.dismissing || !this.data.canDismiss) return
    const undo = this.data.dismissed
    this.setData({ dismissing: true })
    try {
      await dismissExtend(material.date, undo)
      this.setData({ dismissed: !undo })
      if (undo) toast('已恢复推荐')
    } catch (error: unknown) {
      toast(errorMessage(error))
    } finally {
      this.setData({ dismissing: false })
    }
  },

  onExport() {
    const material = this.material
    if (material === null) return
    const items = material.content.items.length
    const pages = this.listPages > 0 ? this.listPages : Math.ceil(items / ITEMS_PER_PAGE)
    const own = exportMaterial('extend', material.date, pages, items)
    this.setData({ exportInput: { origin: 'material', selection: [own], week: this.week, initial: 'one' }, exportOpen: true })
  },

  onExportClose() {
    this.setData({ exportOpen: false })
  },
})
