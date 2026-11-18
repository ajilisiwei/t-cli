/**
 * `wx.request` as a {@link Transport} for the JSON endpoints, plus helpers
 * shared with the binary and streaming requests.
 */
import { ApiError, type HttpRequest, type HttpResponse, type Transport } from '../lib/api'

export const JSON_TIMEOUT_MS = 20_000

/** Classifies a `fail` callback: the request never produced a response. */
export function transportError(errMsg: string): ApiError {
  if (/abort/i.test(errMsg)) return new ApiError({ kind: 'aborted', code: 'ABORTED', message: errMsg })
  if (/timeout|timed out/i.test(errMsg)) return new ApiError({ kind: 'timeout', code: 'TIMEOUT', message: errMsg })
  return new ApiError({ kind: 'network', code: 'NETWORK', message: errMsg })
}

/**
 * The body to send. `wx.request` declares `content-type: application/json` by
 * default, and Fastify rejects an empty body declared as JSON — so a request
 * without a body that is not a GET still sends `{}`.
 */
export function wireBody(method: HttpRequest['method'], body: unknown): string | undefined {
  if (body !== undefined) return JSON.stringify(body)
  return method === 'GET' ? undefined : '{}'
}

export const wxTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const data = wireBody(request.method, request.body)
    const header: Record<string, string> = { ...request.headers }
    if (data !== undefined) header['content-type'] = 'application/json'
    wx.request({
      url: request.url,
      method: request.method,
      header,
      ...(data === undefined ? {} : { data }),
      dataType: 'json',
      responseType: 'text',
      timeout: JSON_TIMEOUT_MS,
      success: (response) => resolve({ status: response.statusCode, body: response.data }),
      fail: (error) => reject(transportError(error.errMsg)),
    })
  })
