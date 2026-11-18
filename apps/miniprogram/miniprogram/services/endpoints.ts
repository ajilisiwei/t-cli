/**
 * Typed wrappers for the JSON endpoints the mini-program calls
 * (docs/api-v1.md). Response shapes are checked where a screen depends on
 * them; a mismatch is a `BAD_RESPONSE`, never a crash in a page.
 */
import { ApiError } from '../lib/api'
import { readHistoryPage } from '../lib/history'
import type { Device, DeviceDecision, DeviceLookup, HistoryPage, Me, Settings } from '../lib/types'
import { api } from './session'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const badResponse = (what: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: `malformed ${what}` })

const readSettings = (value: unknown): Settings => {
  if (!isRecord(value)) return {}
  const lang = value['explanationLang']
  return lang === 'zh' || lang === 'en' ? { explanationLang: lang } : {}
}

export async function fetchMe(): Promise<Me> {
  const data = await api.request<unknown>({ method: 'GET', path: '/v1/me' })
  if (!isRecord(data) || typeof data['id'] !== 'string') throw badResponse('me')
  return {
    id: data['id'],
    role: typeof data['role'] === 'string' ? data['role'] : '',
    createdAt: typeof data['createdAt'] === 'string' ? data['createdAt'] : '',
    settings: readSettings(data['settings']),
  }
}

/** `POST /v1/me/settings` merges a partial Settings (wx.request cannot send PATCH). */
export async function updateSettings(patch: Settings): Promise<Settings> {
  const data = await api.request<unknown>({ method: 'POST', path: '/v1/me/settings', body: patch })
  if (!isRecord(data)) throw badResponse('settings')
  return readSettings(data['settings'])
}

const isDevice = (value: unknown): value is Device =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  typeof value['name'] === 'string' &&
  typeof value['kind'] === 'string' &&
  typeof value['current'] === 'boolean'

export async function listDevices(): Promise<Device[]> {
  const data = await api.request<unknown>({ method: 'GET', path: '/v1/devices' })
  if (!isRecord(data) || !Array.isArray(data['devices'])) throw badResponse('devices')
  return data['devices'].filter(isDevice)
}

export async function revokeDevice(id: string): Promise<void> {
  await api.request<unknown>({ method: 'DELETE', path: `/v1/devices/${encodeURIComponent(id)}` })
}

export const HISTORY_PAGE_SIZE = 30

export async function fetchHistory(before: number | null): Promise<HistoryPage> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/entries/history',
    query: { before, limit: HISTORY_PAGE_SIZE },
  })
  const page = readHistoryPage(data)
  if (page === null) throw badResponse('history page')
  return page
}

export async function lookupDevice(userCode: string): Promise<DeviceLookup> {
  const data = await api.request<unknown>({ method: 'POST', path: '/v1/auth/device/lookup', body: { userCode } })
  if (!isRecord(data) || typeof data['deviceName'] !== 'string') throw badResponse('device lookup')
  return { deviceName: data['deviceName'], expiresIn: typeof data['expiresIn'] === 'number' ? data['expiresIn'] : 0 }
}

export async function decideDevice(userCode: string, approve: boolean): Promise<DeviceDecision> {
  const data = await api.request<unknown>({
    method: 'POST',
    path: '/v1/auth/device/approve',
    body: { userCode, approve },
  })
  if (!isRecord(data) || typeof data['deviceName'] !== 'string') throw badResponse('device decision')
  return { deviceName: data['deviceName'], approved: data['approved'] === true }
}
