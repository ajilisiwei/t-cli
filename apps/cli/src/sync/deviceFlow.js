/**
 * CLI device login (RFC 8628 style) as a pure state machine. The TUI holds
 * the state in React (useReducer) and an effect schedules one poll per
 * `polling` state; nothing here does I/O or reads time on its own.
 *
 *   idle ──start──▶ starting ──started──▶ polling ──poll(pending)──▶ polling (attempt+1)
 *                      │                     ├─poll(slow_down)──▶ polling (interval+5 s)
 *                      │                     ├─poll(approved)───▶ done/approved
 *                      │                     ├─poll(expired) / local expiry ─▶ done/expired
 *                      │                     ├─poll(denied)─────▶ done/denied
 *                      │                     └─poll(error)──────▶ polling if transient, else done/failed
 *                      └─start_failed──▶ done/failed            cancel (starting|polling) ─▶ done/cancelled
 */

export const SLOW_DOWN_STEP_MS = 5_000;
export const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * @typedef {'approved'|'expired'|'denied'|'cancelled'|'failed'} LoginOutcome
 * @typedef {{ status: 'idle' }
 *   | { status: 'starting' }
 *   | { status: 'polling', deviceCode: string, userCode: string, intervalMs: number, expiresAt: number, attempt: number }
 *   | { status: 'done', outcome: LoginOutcome, userCode: string|null, user?: { id: string, role: string },
 *       deviceId?: string, error?: string }} LoginState
 * @typedef {{ type: 'start' }
 *   | { type: 'started', response: { deviceCode: string, userCode: string, expiresIn: number, interval: number }, now: number }
 *   | { type: 'start_failed', error: string }
 *   | { type: 'cancel' }
 *   | { type: 'poll', deviceCode: string, now: number, outcome: 'pending'|'slow_down'|'expired'|'denied'|'aborted' }
 *   | { type: 'poll', deviceCode: string, now: number, outcome: 'approved', user: { id: string, role: string }, deviceId: string }
 *   | { type: 'poll', deviceCode: string, now: number, outcome: 'error', error: string, transient: boolean }} LoginEvent
 */

/** @type {LoginState} */
export const LOGIN_IDLE = Object.freeze({ status: 'idle' });

/**
 * @param {LoginState} state
 * @returns {boolean} a login is starting or waiting for approval
 */
export function isLoginActive(state) {
  return state.status === 'starting' || state.status === 'polling';
}

/**
 * @param {LoginState} state
 * @param {LoginEvent} event
 * @returns {LoginState}
 */
export function loginReducer(state, event) {
  switch (event.type) {
    case 'start':
      return isLoginActive(state) ? state : { status: 'starting' };
    case 'started':
      if (state.status !== 'starting') return state; // cancelled while starting
      return {
        status: 'polling',
        deviceCode: event.response.deviceCode,
        userCode: event.response.userCode,
        intervalMs: Math.max(MIN_POLL_INTERVAL_MS, event.response.interval * 1000),
        expiresAt: event.now + event.response.expiresIn * 1000,
        attempt: 0,
      };
    case 'start_failed':
      return state.status === 'starting' ? done('failed', null, { error: event.error }) : state;
    case 'cancel':
      if (!isLoginActive(state)) return state;
      return done('cancelled', state.status === 'polling' ? state.userCode : null);
    case 'poll':
      if (state.status !== 'polling' || event.deviceCode !== state.deviceCode) return state; // stale poll
      return onPoll(state, event);
    default:
      return state;
  }
}

/**
 * @param {Extract<LoginState, { status: 'polling' }>} state
 * @param {Extract<LoginEvent, { type: 'poll' }>} event
 * @returns {LoginState}
 */
function onPoll(state, event) {
  const expired = event.now >= state.expiresAt;
  const next = { ...state, attempt: state.attempt + 1 };
  switch (event.outcome) {
    case 'approved':
      return done('approved', state.userCode, { user: event.user, deviceId: event.deviceId });
    case 'expired':
      return done('expired', state.userCode);
    case 'denied':
      return done('denied', state.userCode);
    case 'slow_down':
      return expired ? done('expired', state.userCode) : { ...next, intervalMs: state.intervalMs + SLOW_DOWN_STEP_MS };
    case 'pending':
      return expired ? done('expired', state.userCode) : next;
    case 'error':
      if (expired) return done('expired', state.userCode);
      return event.transient ? next : done('failed', state.userCode, { error: event.error });
    case 'aborted':
    default:
      return state;
  }
}

/**
 * @param {LoginOutcome} outcome
 * @param {string|null} userCode
 * @param {{ user?: { id: string, role: string }, deviceId?: string, error?: string }} [extra]
 * @returns {LoginState}
 */
function done(outcome, userCode, extra = {}) {
  return { status: 'done', outcome, userCode, ...extra };
}
