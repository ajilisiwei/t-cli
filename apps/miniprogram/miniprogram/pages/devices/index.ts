/**
 * 我的 → 设备: the account's signed-in devices; any but this one can be
 * revoked (it is signed out at its next request).
 */
import { errorMessage } from '../../lib/api'
import { formatInstant } from '../../lib/history'
import type { Device } from '../../lib/types'
import { listDevices, revokeDevice } from '../../services/endpoints'
import { redirectIfInviteRequired } from '../../services/session'
import { bindPageLook, currentTheme, type Theme } from '../../services/theme'
import { confirm, toast } from '../../services/ui'

interface DeviceRow {
  id: string
  name: string
  kindLabel: string
  lastSeen: string
  current: boolean
}

interface DevicesData {
  theme: Theme
  devices: DeviceRow[]
  loading: boolean
  errorText: string
}

const KIND_LABELS: Readonly<Record<string, string>> = { cli: 'CLI', mp: '小程序', h5: '网页' }

const toRow = (device: Device, now: Date): DeviceRow => ({
  id: device.id,
  name: device.name,
  kindLabel: KIND_LABELS[device.kind] ?? device.kind,
  lastSeen: formatInstant(device.lastSeenAt ?? device.createdAt, now),
  current: device.current,
})

const initialData: DevicesData = {
  theme: currentTheme(),
  devices: [],
  loading: true,
  errorText: '',
}

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = bindPageLook(this)
    this.setData({ theme: currentTheme() })
  },

  onShow() {
    void this.load()
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  async load() {
    this.setData({ loading: true, errorText: '' })
    try {
      const now = new Date()
      const devices = (await listDevices())
        .filter((device) => device.revokedAt === null)
        .map((device) => toRow(device, now))
      this.setData({ devices })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ errorText: errorMessage(error) })
    } finally {
      this.setData({ loading: false })
    }
  },

  async onRevoke(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const row = this.data.devices.find((device) => device.id === event.currentTarget.dataset.id)
    if (row === undefined || row.current) return
    const confirmed = await confirm({
      title: '撤销设备',
      content: `「${row.name}」将退出登录，需要重新授权才能再用。`,
      confirmText: '撤销',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await revokeDevice(row.id)
      toast('已撤销')
      await this.load()
    } catch (error: unknown) {
      toast(errorMessage(error, { NOT_FOUND: '设备已不存在' }))
      await this.load()
    }
  },
})
