/**
 * 导出 PDF (docs/api-v1.md, "PDF export"): `POST /v1/exports/pdf` answers
 * the PDF bytes. They go to `${USER_DATA_PATH}/exports/<name>.pdf` (a
 * `wx.request` with an arraybuffer: only the request domain is whitelisted,
 * never `downloadFile`), and a record of the file is kept in storage for
 * 导出记录. Files live 7 days: `pruneExports` (app start, 导出记录) deletes
 * older ones and files no record knows.
 *
 * `wx.shareFileMessage` only works straight from a tap: callers run
 * `shareExportFile` first thing in the handler, before any await.
 * `wx.openDocument` takes local paths only, hence the file.
 */
import { formatBytes, headerValue } from '../lib/account'
import { ApiError, parseEnvelope } from '../lib/api'
import {
  EXPORTS_DIR_NAME,
  addRecord,
  orphanFiles,
  pruneRecords,
  readRecords,
  type ExportRecord,
} from '../lib/export-records'
import { localDateKey } from '../lib/history'
import type { PdfExportRequest } from '../lib/learn-types'
import { defaultPdfName, pdfFileName, readPdfPages } from '../lib/pdf-export'
import { createUtf8Decoder } from '../lib/utf8'
import { transportError } from './http'
import { api } from './session'
import { STORAGE_KEYS, readStorage, writeStorage } from './storage'

export type { ExportRecord }

/** The renderer may take up to 15 s; the bytes then still have to arrive. */
const PDF_TIMEOUT_MS = 60_000

const fs = (): WechatMiniprogram.FileSystemManager => wx.getFileSystemManager()

const localFileError = (errMsg: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'LOCAL_FILE', message: errMsg })

const badResponse = (what: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: `malformed ${what}` })

const decodeText = (data: unknown): unknown => {
  if (!(data instanceof ArrayBuffer)) return data
  const decoder = createUtf8Decoder()
  return decoder.decode(data) + decoder.flush()
}

export const exportsDir = (): string => `${wx.env.USER_DATA_PATH}/${EXPORTS_DIR_NAME}`

interface PdfResponse {
  readonly bytes: ArrayBuffer
  readonly disposition: string | null
  readonly pages: number | null
}

const requestPdf = (accessToken: string, request: PdfExportRequest): Promise<PdfResponse> =>
  new Promise((resolve, reject) => {
    wx.request({
      url: `${api.baseUrl}/v1/exports/pdf`,
      method: 'POST',
      header: {
        accept: 'application/pdf, application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      data: JSON.stringify(request),
      responseType: 'arraybuffer',
      timeout: PDF_TIMEOUT_MS,
      success: (response) => {
        const data: unknown = response.data
        if (response.statusCode === 200 && data instanceof ArrayBuffer && data.byteLength > 0) {
          resolve({
            bytes: data,
            disposition: headerValue(response.header, 'content-disposition'),
            pages: readPdfPages(headerValue(response.header, 'x-pdf-pages')),
          })
          return
        }
        try {
          // Errors are JSON envelopes (429, 422 TOO_MANY_PAGES, 502, 503, …).
          parseEnvelope(response.statusCode, decodeText(data))
          reject(badResponse('pdf'))
        } catch (error: unknown) {
          reject(error)
        }
      },
      fail: (error) => reject(transportError(error.errMsg)),
    })
  })

const ensureDir = (dir: string): void => {
  try {
    fs().accessSync(dir)
  } catch {
    try {
      fs().mkdirSync(dir, true)
    } catch (error: unknown) {
      throw localFileError(error instanceof Error ? error.message : String(error))
    }
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

const loadRecords = (): ExportRecord[] => readRecords(readStorage(STORAGE_KEYS.exportRecords))

const saveRecords = (records: readonly ExportRecord[]): void => writeStorage(STORAGE_KEYS.exportRecords, records)

/** True when the file still exists (the system may clear the user data directory). */
export function exportFileExists(path: string): boolean {
  try {
    fs().accessSync(path)
    return true
  } catch {
    return false
  }
}

const removeFile = (path: string): void => {
  try {
    fs().unlinkSync(path)
  } catch (error: unknown) {
    // Already gone, or the system cleared it: nothing to do.
    console.warn('[pdf] could not delete an export', error)
  }
}

/**
 * Renders the PDF on the server and keeps it on this phone; resolves with its
 * record. The record is stored here, so leaving the page meanwhile loses nothing.
 */
export async function exportPdf(request: PdfExportRequest, now: Date = new Date()): Promise<ExportRecord> {
  const response = await api.authorized((accessToken) => requestPdf(accessToken, request))
  const dir = exportsDir()
  ensureDir(dir)
  const fileName = pdfFileName(response.disposition, defaultPdfName(request, localDateKey(now)))
  const path = `${dir}/${fileName}`
  await writeFile(path, response.bytes)
  const record: ExportRecord = {
    path,
    fileName,
    pages: response.pages,
    bytes: response.bytes.byteLength,
    createdAt: now.getTime(),
  }
  saveRecords(addRecord(loadRecords(), record))
  return record
}

/**
 * Deletes files older than 7 days and files no record knows, forgets records
 * whose file is gone; returns the records left (newest first). Quiet.
 */
export function pruneExports(now: number = Date.now()): ExportRecord[] {
  const { kept, expired } = pruneRecords(loadRecords(), now, exportFileExists)
  for (const record of expired) removeFile(record.path)
  saveRecords(kept)
  const dir = exportsDir()
  try {
    for (const name of orphanFiles(fs().readdirSync(dir), dir, kept)) removeFile(`${dir}/${name}`)
  } catch {
    // No exports folder yet.
  }
  return [...kept]
}

/** The records as stored (call `pruneExports` first for a cleaned list). */
export function exportRecords(): ExportRecord[] {
  return loadRecords()
}

/** Deletes one export and its record; returns the records left. */
export function removeExport(path: string): ExportRecord[] {
  removeFile(path)
  const records = loadRecords().filter((record) => record.path !== path)
  saveRecords(records)
  return records
}

/** "386 KB". */
export const exportSize = (record: Pick<ExportRecord, 'bytes'>): string => formatBytes(record.bytes)

/**
 * Opens WeChat's chat picker to send the file (发给微信好友). Resolves false
 * when the user backs out. Call it directly from a tap handler.
 */
export function shareExportFile(record: Pick<ExportRecord, 'path' | 'fileName'>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath: record.path,
      fileName: record.fileName,
      success: () => resolve(true),
      fail: (error) => {
        if (/cancel/i.test(error.errMsg)) resolve(false)
        else reject(localFileError(error.errMsg))
      },
    })
  })
}

/** 预览: the system viewer, whose「…」menu saves, opens elsewhere or prints. */
export function openExportFile(record: Pick<ExportRecord, 'path'>): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath: record.path,
      fileType: 'pdf',
      showMenu: true,
      success: () => resolve(),
      fail: (error) => reject(localFileError(error.errMsg)),
    })
  })
}
