/**
 * Typed wrappers for the JSON endpoints the mini-program calls
 * (docs/api-v1.md). Response shapes are checked where a screen depends on
 * them (lib/wire.ts, lib/history.ts); a mismatch is a `BAD_RESPONSE`, never
 * a crash in a page.
 *
 * `POST /v1/tts` returns audio, not JSON: it lives in services/speech.ts
 * (send `part`, read the part headers with `readSpeechParts`).
 */
import { ApiError } from '../lib/api'
import { readHistoryPage } from '../lib/history'
import type {
  Device,
  DeviceDecision,
  DeviceLookup,
  EntryDay,
  HistoryFilters,
  HistoryPage,
  LookupRequest,
  LookupResult,
  Me,
  Note,
  NoteChanges,
  NoteInput,
  NotesPage,
  NotesQuery,
  Settings,
  SourceFilter,
} from '../lib/types'
import {
  readEntryDays,
  readLookupResult,
  readNoteChanges,
  readNoteEnvelope,
  readNotesPage,
  readSettings,
} from '../lib/wire'
import { api } from './session'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const badResponse = (what: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: `malformed ${what}` })

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

/** Newest first; `filters` (v2) narrow to one local day, a source or a search in the input. */
export async function fetchHistory(before: number | null, filters: HistoryFilters = {}): Promise<HistoryPage> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/entries/history',
    query: {
      before,
      limit: HISTORY_PAGE_SIZE,
      date: filters.date,
      utcOffsetMinutes: filters.utcOffsetMinutes,
      source: filters.source,
      q: filters.q,
    },
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

// ---------------------------------------------------------------------- v2

/** Local dates in [from, to] (YYYY-MM-DD) with at least one record, ascending. */
export async function fetchEntryDays(params: {
  readonly from: string
  readonly to: string
  readonly utcOffsetMinutes: number
  readonly source?: SourceFilter
}): Promise<EntryDay[]> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/entries/days',
    query: { from: params.from, to: params.to, utcOffsetMinutes: params.utcOffsetMinutes, source: params.source },
  })
  const days = readEntryDays(data)
  if (days === null) throw badResponse('entry days')
  return days
}

/** 点词查词: the word's lexicon entry and, with a sentence, its meaning there. */
export async function lookupWord(request: LookupRequest): Promise<LookupResult> {
  const data = await api.request<unknown>({ method: 'POST', path: '/v1/lookup', body: request })
  const result = readLookupResult(data)
  if (result === null) throw badResponse('lookup')
  return result
}

const notePath = (id: string): string => `/v1/notes/${encodeURIComponent(id)}`

/** Save or update a note under its client ULID (idempotent). */
export async function saveNote(id: string, input: NoteInput): Promise<Note> {
  const data = await api.request<unknown>({ method: 'PUT', path: notePath(id), body: input })
  const note = readNoteEnvelope(data)
  if (note === null) throw badResponse('note')
  return note
}

/** 取消收藏 (soft delete). `NOT_FOUND` means there is nothing to delete. */
export async function deleteNote(id: string): Promise<Note> {
  const data = await api.request<unknown>({ method: 'DELETE', path: notePath(id) })
  const note = readNoteEnvelope(data)
  if (note === null) throw badResponse('note')
  return note
}

export const NOTES_PAGE_SIZE = 30

/** The notebook, newest first. */
export async function listNotes(query: NotesQuery = {}): Promise<NotesPage> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/notes',
    query: { kind: query.kind, stars: query.stars, before: query.before, limit: query.limit ?? NOTES_PAGE_SIZE },
  })
  const page = readNotesPage(data)
  if (page === null) throw badResponse('notes page')
  return page
}

export const NOTE_CHANGES_PAGE_SIZE = 200

/** Notes changed after the `after` cursor (deleted ones included); persist `nextAfter`. */
export async function fetchNoteChanges(after: number, limit: number = NOTE_CHANGES_PAGE_SIZE): Promise<NoteChanges> {
  const data = await api.request<unknown>({ method: 'GET', path: '/v1/notes/changes', query: { after, limit } })
  const changes = readNoteChanges(data)
  if (changes === null) throw badResponse('note changes')
  return changes
}
