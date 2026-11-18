/**
 * The 6-digit code a CLI shows for `/login` (docs/api-v1.md "CLI device
 * authorization"). It reaches the mini-program either as the QR payload
 * `tcli://device?code=123456` or typed by hand.
 */

const USER_CODE_RE = /^\d{6}$/
// `URL` is not guaranteed in the mini-program runtime, so the payload is matched directly.
const QR_PAYLOAD_RE = /^tcli:\/\/device\/?\?(.*)$/i

/** A typed code: digits, tolerating the spaces or dashes people add when copying. */
export function normalizeTypedCode(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '')
  return USER_CODE_RE.test(digits) ? digits : null
}

/**
 * Extracts the user code from a scan result or typed text; null when the
 * input is neither a `tcli://device` payload nor six digits.
 */
export function parseUserCode(raw: string): string | null {
  const text = raw.trim()
  const payload = QR_PAYLOAD_RE.exec(text)
  if (payload === null) return normalizeTypedCode(text)
  for (const pair of (payload[1] ?? '').split('&')) {
    const [key, value] = pair.split('=')
    if (key === 'code' && value !== undefined && USER_CODE_RE.test(value)) return value
  }
  return null
}
