/**
 * Account data and reminders (docs/api-v1.md, "Account" and "Reminders"):
 *
 *  - 导出: `POST /v1/export` answers Markdown, not JSON. The bytes go to a
 *    file under `wx.env.USER_DATA_PATH`, which `wx.shareFileMessage` sends to
 *    a chat (文件传输助手). Only the request domain is whitelisted, so this is
 *    a `wx.request`, never `wx.downloadFile`.
 *  - 注销: `POST /v1/me/delete`, then everything stored on this phone goes.
 *  - 提醒: WeChat subscribe messages are one-time: each acceptance lets the
 *    server send one reminder, recorded with `POST /v1/notify/grant`.
 *
 * `wx.shareFileMessage` and `wx.requestSubscribeMessage` only work from a
 * tap: pages call these wrappers first thing in the handler, before any await.
 */
import {
  DELETE_CONFIRM,
  exportFileName,
  headerValue,
  isExportFile,
  readDeleted,
  readGrantAvailable,
  readReminderTemplate,
  subscribeFailure,
  subscribeOutcome,
  type SubscribeOutcome,
} from '../lib/account'
import { ApiError, parseEnvelope } from '../lib/api'
import { EXPORTS_DIR_NAME } from '../lib/export-records'
import { createUtf8Decoder } from '../lib/utf8'
import { transportError } from './http'
import { api } from './session'
import { stopSpeaking } from './speech'

const EXPORT_TIMEOUT_MS = 60_000

const badResponse = (what: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: `malformed ${what}` })

const localFileError = (errMsg: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'LOCAL_FILE', message: errMsg })

const fs = (): WechatMiniprogram.FileSystemManager => wx.getFileSystemManager()

const decodeText = (data: unknown): unknown => {
  if (!(data instanceof ArrayBuffer)) return data
  const decoder = createUtf8Decoder()
  return decoder.decode(data) + decoder.flush()
}

interface ExportResponse {
  readonly bytes: ArrayBuffer
  readonly disposition: string | null
}

const requestExport = (accessToken: string): Promise<ExportResponse> =>
  new Promise((resolve, reject) => {
    wx.request({
      url: `${api.baseUrl}/v1/export`,
      method: 'POST',
      header: {
        accept: 'text/markdown, application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      // Fastify rejects an empty body declared as JSON.
      data: '{}',
      responseType: 'arraybuffer',
      timeout: EXPORT_TIMEOUT_MS,
      success: (response) => {
        const data: unknown = response.data
        if (response.statusCode === 200 && data instanceof ArrayBuffer && data.byteLength > 0) {
          resolve({ bytes: data, disposition: headerValue(response.header, 'content-disposition') })
          return
        }
        try {
          // Errors are JSON envelopes (401, 429 RATE_LIMITED, …).
          parseEnvelope(response.statusCode, decodeText(data))
          reject(badResponse('export'))
        } catch (error: unknown) {
          reject(error)
        }
      },
      fail: (error) => reject(transportError(error.errMsg)),
    })
  })

/** Earlier exports only take up the user data quota. */
const removeOldExports = (): void => {
  try {
    const dir = wx.env.USER_DATA_PATH
    for (const name of fs().readdirSync(dir)) {
      if (isExportFile(name)) fs().unlinkSync(`${dir}/${name}`)
    }
  } catch (error: unknown) {
    console.warn('[account] removing old exports failed', error)
  }
}

const writeFile = (path: string, data: ArrayBuffer): Promise<void> =>
  new Promise((resolve, reject) => {
    fs().writeFile({
      filePath: path,
      data,
      success: () => resolve(),
      fail: (error) => reject(localFileError(error.errMsg)),
    })
  })

export interface ExportFile {
  readonly path: string
  readonly fileName: string
  readonly bytes: number
}

/** Downloads the Markdown export into a local file, replacing earlier exports. */
export async function exportRecords(now: Date = new Date()): Promise<ExportFile> {
  const response = await api.authorized(requestExport)
  const fileName = exportFileName(response.disposition, now)
  const path = `${wx.env.USER_DATA_PATH}/${fileName}`
  removeOldExports()
  await writeFile(path, response.bytes)
  return { path, fileName, bytes: response.bytes.byteLength }
}

/** True when the file still exists (the user data directory can be cleared by the system). */
export function exportFileExists(path: string): boolean {
  try {
    fs().accessSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Opens WeChat's chat picker to send the file. Resolves false when the user
 * backs out. Call it directly from a tap handler.
 */
export function shareExportFile(file: ExportFile): Promise<boolean> {
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath: file.path,
      fileName: file.fileName,
      success: () => resolve(true),
      fail: (error) => {
        if (/cancel/i.test(error.errMsg)) resolve(false)
        else reject(localFileError(error.errMsg))
      },
    })
  })
}

/** Deletes the account and all of its data on the server. */
export async function deleteAccount(): Promise<void> {
  const data = await api.request<unknown>({ method: 'POST', path: '/v1/me/delete', body: { confirm: DELETE_CONFIRM } })
  if (!readDeleted(data)) throw badResponse('account deletion')
}

/**
 * Forgets everything this phone holds for the account: tokens, settings and
 * caches in storage, cached audio, exports and exported PDFs in the user data
 * directory.
 */
export function clearLocalData(): void {
  stopSpeaking()
  try {
    wx.clearStorageSync()
  } catch (error: unknown) {
    console.warn('[account] clearing storage failed', error)
  }
  try {
    const dir = wx.env.USER_DATA_PATH
    for (const name of fs().readdirSync(dir)) {
      const path = `${dir}/${name}`
      const stats = fs().statSync(path) as WechatMiniprogram.Stats
      // Exported PDFs live in their own folder (services/pdf.ts); other folders are the system's.
      if (!stats.isDirectory()) fs().unlinkSync(path)
      else if (name === EXPORTS_DIR_NAME) fs().rmdirSync(path, true)
    }
  } catch (error: unknown) {
    console.warn('[account] clearing files failed', error)
  }
}

/** The reminder template, or null when the server has reminders off. */
export async function fetchReminderTemplate(): Promise<string | null> {
  const data = await api.request<unknown>({ method: 'GET', path: '/v1/notify/config' })
  const templateId = readReminderTemplate(data)
  if (templateId === undefined) throw badResponse('notify config')
  return templateId
}

/**
 * Shows WeChat's subscribe dialog for one reminder. Call it directly from a
 * tap handler; resolves with the user's answer.
 */
export function requestReminder(templateId: string): Promise<SubscribeOutcome> {
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (result) => resolve(subscribeOutcome(result, templateId)),
      fail: (error) => {
        console.warn('[account] subscribe dialog failed', error.errCode, error.errMsg)
        resolve(subscribeFailure(error.errCode))
      },
    })
  })
}

/** Tells the server about one accepted reminder; resolves with how many it may now send. */
export async function grantReminder(templateId: string): Promise<number> {
  const data = await api.request<unknown>({ method: 'POST', path: '/v1/notify/grant', body: { templateId } })
  const available = readGrantAvailable(data)
  if (available === null) throw badResponse('notify grant')
  return available
}
