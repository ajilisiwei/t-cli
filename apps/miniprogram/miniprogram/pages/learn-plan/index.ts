/**
 * 学习计划: 周期资料 (每天 / 每周 + the weekday / 关闭, and what goes in it),
 * 拓展资料 (on or off, 方向, topics muted by 不感兴趣 with 恢复推荐), 难度 (自动 —
 * with the level in force and why — or A2–C1), and the review settings that
 * also live in 我的 (按重要程度复习, 复习提醒).
 *
 * Settings are local-first (services/settings.ts): a change is in force at
 * once and saved to the account in the background; the view re-renders from
 * the settings whenever they change, including when the account's arrive.
 */
import {
  REMINDER_OPTIONS,
  SUBSCRIBE_MESSAGES,
  hourToOption,
  optionToHour,
  reminderLabel,
} from '../../lib/account'
import { errorMessage } from '../../lib/api'
import { localDateKey } from '../../lib/history'
import {
  FREQUENCY_OPTIONS,
  LEVEL_OPTIONS,
  PART_OPTIONS,
  TOPIC_OPTIONS,
  WEEKDAY_OPTIONS,
  chipsOf,
  frequencyHint,
  levelHint,
  mutedRows,
  togglePart,
  toggleTopic,
  unmute,
  type Chip,
  type MutedRow,
} from '../../lib/learn-plan'
import type { LearnSummary } from '../../lib/learn-types'
import type { ExtendTopic, MaterialFrequency, MaterialPart, MaterialTopic, StudyLevelSetting } from '../../lib/types'
import { fetchReminderTemplate, grantReminder, requestReminder } from '../../services/account'
import { fetchLearnSummary } from '../../services/learn'
import { changeSettings, currentSettings, syncSettingsSoon, watchSettings } from '../../services/settings'
import { bindPageLook, currentLook, type Look } from '../../services/theme'
import { toast } from '../../services/ui'

interface WeekdayChip extends Chip<number> {
  aria: string
}

interface PlanView {
  frequency: MaterialFrequency
  freqs: Chip<MaterialFrequency>[]
  freqHint: string
  weekdays: WeekdayChip[]
  parts: Chip<MaterialPart>[]
  extendEnabled: boolean
  topics: Chip<ExtendTopic>[]
  muted: MutedRow[]
  levels: Chip<StudyLevelSetting>[]
  levelHint: string
  importanceReview: boolean
  reminderIndex: number
  reminderLabel: string
  reminderOn: boolean
}

interface PlanData extends Look, PlanView {
  reminderAvailable: boolean
  reminderOptions: readonly string[]
  grantText: string
  granting: boolean
}

const GRANT_PROMPT = '点此允许'

const planView = (level: LearnSummary['level'] | null): PlanView => {
  const s = currentSettings()
  return {
    frequency: s.materialFrequency,
    freqs: chipsOf(FREQUENCY_OPTIONS, (id) => id === s.materialFrequency),
    freqHint: frequencyHint(s.materialFrequency),
    weekdays: WEEKDAY_OPTIONS.map((option) => ({ ...option, on: option.id === s.materialWeekday })),
    parts: chipsOf(PART_OPTIONS, (id) => s.materialParts.includes(id)),
    extendEnabled: s.extendEnabled,
    topics: chipsOf(TOPIC_OPTIONS, (id) => s.extendTopics.includes(id)),
    muted: mutedRows(s.extendMuted, localDateKey(new Date())),
    levels: chipsOf(LEVEL_OPTIONS, (id) => id === s.studyLevel),
    levelHint: levelHint(s.studyLevel, level),
    importanceReview: s.importanceReview,
    reminderIndex: hourToOption(s.reminderHour),
    reminderLabel: reminderLabel(s.reminderHour),
    reminderOn: s.reminderHour !== null,
  }
}

const has = <T>(options: readonly { id: T }[], value: unknown): value is T => options.some((option) => option.id === value)

const initialData: PlanData = {
  ...currentLook(),
  ...planView(null),
  reminderAvailable: false,
  reminderOptions: REMINDER_OPTIONS,
  grantText: GRANT_PROMPT,
  granting: false,
}

Page({
  data: initialData,
  stopWatching: [] as (() => void)[],
  /** The level in force, from the learn summary; null until it arrives. */
  level: null as LearnSummary['level'] | null,
  /** Undefined until `GET /v1/notify/config` answered; null = reminders off on the server. */
  templateId: undefined as string | null | undefined,

  onLoad() {
    this.stopWatching = [bindPageLook(this), watchSettings(() => this.setData(planView(this.level)))]
  },

  onShow() {
    this.setData(planView(this.level))
    syncSettingsSoon()
    fetchLearnSummary()
      .then((summary) => {
        this.level = summary.level
        this.setData({ levelHint: levelHint(currentSettings().studyLevel, summary.level) })
      })
      .catch((error: unknown) => console.warn('[learn-plan] level unavailable', error))
    if (this.templateId === undefined) {
      fetchReminderTemplate()
        .then((templateId) => {
          this.templateId = templateId
          this.setData({ reminderAvailable: templateId !== null })
        })
        .catch((error: unknown) => console.warn('[learn-plan] reminder config unavailable', error))
    }
  },

  onUnload() {
    for (const stop of this.stopWatching) stop()
    this.stopWatching = []
  },

  onFrequency(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const id = event.currentTarget.dataset.id
    if (has(FREQUENCY_OPTIONS, id) && id !== currentSettings().materialFrequency) changeSettings({ materialFrequency: id })
  },

  onWeekday(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: number }>) {
    const id = Number(event.currentTarget.dataset.id)
    if (has(WEEKDAY_OPTIONS, id) && id !== currentSettings().materialWeekday) changeSettings({ materialWeekday: id })
  },

  onPart(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const id = event.currentTarget.dataset.id
    if (!has(PART_OPTIONS, id)) return
    const parts = togglePart(currentSettings().materialParts, id)
    if (parts === null) {
      toast('至少保留一项')
      return
    }
    changeSettings({ materialParts: parts })
  },

  onExtend() {
    changeSettings({ extendEnabled: !currentSettings().extendEnabled })
  },

  onTopic(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const id = event.currentTarget.dataset.id
    if (has(TOPIC_OPTIONS, id)) changeSettings({ extendTopics: toggleTopic(currentSettings().extendTopics, id) })
  },

  onUnmute(event: WechatMiniprogram.BaseEvent<Record<string, never>, { topic?: MaterialTopic }>) {
    const topic = event.currentTarget.dataset.topic
    if (topic === undefined) return
    changeSettings({ extendMuted: unmute(currentSettings().extendMuted, topic) })
    toast('已恢复推荐')
  },

  onLevel(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const id = event.currentTarget.dataset.id
    if (has(LEVEL_OPTIONS, id) && id !== currentSettings().studyLevel) changeSettings({ studyLevel: id })
  },

  onImportance() {
    changeSettings({ importanceReview: !currentSettings().importanceReview })
  },

  onReminderHour(event: WechatMiniprogram.PickerChange) {
    const hour = optionToHour(event.detail.value)
    if (hour === currentSettings().reminderHour) return
    changeSettings({ reminderHour: hour })
    if (hour !== null && this.data.grantText === GRANT_PROMPT) toast('再点「接收下一次提醒」，允许微信发送')
  },

  /** Straight from the tap: the subscribe dialog only opens from a user gesture. */
  onGrant() {
    const templateId = this.templateId
    if (typeof templateId !== 'string' || this.data.granting) return
    const answer = requestReminder(templateId)
    this.setData({ granting: true })
    answer
      .then(async (outcome) => {
        if (outcome !== 'accept') {
          toast(SUBSCRIBE_MESSAGES[outcome])
          return
        }
        const available = await grantReminder(templateId)
        this.setData({ grantText: `可提醒 ${available} 次` })
        toast('已允许下一次提醒')
      })
      .catch((error: unknown) => toast(errorMessage(error)))
      .finally(() => this.setData({ granting: false }))
  },
})
