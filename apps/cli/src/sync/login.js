/**
 * I/O steps of the device login, each turned into a `loginReducer` event.
 * Tokens are persisted here and never reach React state or the screen.
 */
import os from 'node:os';
import QRCode from 'qrcode';

/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/** @typedef {import('./deviceFlow.js').LoginEvent} LoginEvent */

const DEVICE_NAME_MAX = 64;

/** e.g. "t-cli @ my-macbook" (1–64 chars, as the API requires). */
export function defaultDeviceName() {
  let host = '';
  try {
    host = os.hostname().replace(/\.local$/, '').trim();
  } catch {
    host = '';
  }
  return (host ? `t-cli @ ${host}` : 't-cli').slice(0, DEVICE_NAME_MAX);
}

/**
 * Poll the device token once; on approval store the credentials.
 * Never throws.
 * @param {{ client: SyncClient, deviceCode: string, signal?: AbortSignal, now?: () => number }} args
 * @returns {Promise<LoginEvent>}
 */
export async function pollDeviceLogin({ client, deviceCode, signal, now = Date.now }) {
  const result = await client.pollDeviceToken({ deviceCode, signal });
  const at = now();
  if (result.outcome === 'approved') {
    const adopted = client.adoptTokenPair(result.pair);
    if (!adopted.ok) {
      return { type: 'poll', deviceCode, now: at, outcome: 'error', error: `could not save credentials: ${adopted.error}`, transient: false };
    }
    return { type: 'poll', deviceCode, now: at, outcome: 'approved', user: adopted.auth.user, deviceId: adopted.auth.deviceId };
  }
  if (result.outcome === 'error') {
    return { type: 'poll', deviceCode, now: at, outcome: 'error', error: result.error.message, transient: result.transient };
  }
  return { type: 'poll', deviceCode, now: at, outcome: result.outcome };
}

/**
 * Render the QR code as a string (ANSI, two rows per line). Never prints.
 * @param {string} payload
 * @returns {Promise<string|null>} null when it cannot be rendered
 */
export async function renderQr(payload) {
  try {
    const text = await QRCode.toString(payload, { type: 'terminal', small: true });
    return text.replace(/\n+$/, '');
  } catch {
    return null;
  }
}
