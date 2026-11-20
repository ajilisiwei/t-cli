/**
 * React glue for sync inside the Ink TUI: owns the background syncer, the
 * device-login state machine (useReducer + one timer effect per poll) and
 * the /login, /logout, /sync commands.
 *
 * All output goes through `notify` (the App's message log). Nothing here
 * touches stdin/stdout; timers and requests are cancelled on unmount.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { countRejected, readOutbox, readSyncState } from '../entryLog.js';
import { clearAuth, readAuth } from './authStore.js';
import { createSyncClient } from './client.js';
import { LOGIN_IDLE, isLoginActive, loginReducer } from './deviceFlow.js';
import { defaultDeviceName, pollDeviceLogin, renderQr } from './login.js';
import { resolveServerUrl } from './settings.js';
import { buildSyncStatusLines, describePushSummary, formatSyncIndicator, syncOffLines } from './status.js';
import { createSyncer, toPushRecord } from './syncer.js';

/** @typedef {(text: string, options?: { color?: string, dim?: boolean, bold?: boolean }) => void} Notify */

/**
 * Text shown around the QR code after device/start.
 * @param {{ userCode: string, expiresIn: number }} started
 * @returns {{ before: string, after: string }}
 */
function loginInstructions(started) {
  const minutes = Math.max(1, Math.round(started.expiresIn / 60));
  return {
    before: [
      `Log in this terminal: approve code ${started.userCode}`,
      '  In the mini-program: 我的 → 授权 CLI, then enter the code or scan the QR code below.',
      '  Until the mini-program ships, on the server run:',
      `    npm run admin -w @t-cli/server -- approve-device ${started.userCode} <userId>`,
    ].join('\n'),
    after: `Waiting for approval (code expires in ${minutes} min). Keep using t-cli meanwhile; /login cancel to abort.`,
  };
}

/**
 * @param {{ notify: Notify }} props
 */
export function useSync({ notify }) {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  /** @type {Notify} */
  const say = (text, options) => notifyRef.current(text, options);

  const server = useMemo(() => resolveServerUrl(), []);
  const authLostNoticeRef = useRef(false);
  // While /logout runs, background pushes and "login again" notices are off.
  const suspendedRef = useRef(false);
  const [loggedIn, setLoggedIn] = useState(false);

  const client = useMemo(() => {
    if (!server.ok) return null;
    return createSyncClient({
      serverUrl: server.url,
      onAuthLost: () => {
        setLoggedIn(false);
        if (authLostNoticeRef.current || suspendedRef.current) return;
        authLostNoticeRef.current = true;
        notifyRef.current('Sync paused: the login expired or was revoked. Please /login again.', { color: 'yellow' });
      },
    });
  }, [server]);

  const syncer = useMemo(
    () => (client ? createSyncer({ client, initialLast: toPushRecord(readSyncState().lastPush) }) : null),
    [client],
  );
  const [snapshot, setSnapshot] = useState(() => (syncer ? syncer.getSnapshot() : null));
  const [login, dispatchLogin] = useReducer(loginReducer, LOGIN_IDLE);
  /** @type {React.MutableRefObject<AbortController | null>} */
  const startAbortRef = useRef(null);

  // Lifecycle: subscribe, push once at startup when logged in, clean up on exit.
  useEffect(() => {
    if (!client || !syncer) return undefined;
    const unsubscribe = syncer.subscribe(setSnapshot);
    const auth = client.getAuth();
    setLoggedIn(Boolean(auth));
    if (auth) void syncer.requestPush();
    return () => {
      unsubscribe();
      syncer.dispose();
      startAbortRef.current?.abort();
    };
  }, [client, syncer]);

  // One device-token poll per `polling` state; any state change or unmount
  // cancels the pending timer and the in-flight request.
  useEffect(() => {
    if (!client || login.status !== 'polling') return undefined;
    const controller = new AbortController();
    const { deviceCode } = login;
    const timer = setTimeout(() => {
      void pollDeviceLogin({ client, deviceCode, signal: controller.signal }).then((event) => {
        if (!controller.signal.aborted) dispatchLogin(event);
      });
    }, login.intervalMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, login]);

  // Terminal login outcomes: one message each; a push right after login.
  useEffect(() => {
    if (login.status !== 'done') return;
    switch (login.outcome) {
      case 'approved':
        authLostNoticeRef.current = false;
        setLoggedIn(true);
        say(`Logged in as user ${login.user?.id} (${login.user?.role}), device ${login.deviceId}. Records sync in the background.`, { color: 'green' });
        void syncer?.requestPush({ force: true });
        break;
      case 'expired':
        say('Login code expired. Run /login to get a new one.', { color: 'yellow' });
        break;
      case 'denied':
        say('Login was denied.', { color: 'yellow' });
        break;
      case 'cancelled':
        say('Login cancelled.', { dim: true });
        break;
      default:
        say(`Login failed: ${login.error ?? 'unknown error'}`, { color: 'red' });
    }
  }, [login]);

  const sayOff = () => {
    for (const line of syncOffLines(server)) say(line, { color: 'yellow' });
  };

  const cancelLogin = () => {
    startAbortRef.current?.abort();
    dispatchLogin({ type: 'cancel' });
  };

  /** @param {string} arg */
  const runLogin = async (arg) => {
    if (!client) return sayOff();
    if (arg === 'cancel') {
      if (isLoginActive(login)) cancelLogin();
      else say('No login in progress.', { dim: true });
      return undefined;
    }
    if (arg) return say('Tip: Use /login to log in, /login cancel to abort a pending login.', { color: 'yellow' });
    if (login.status === 'polling') {
      return say(`Login is already waiting for approval (code ${login.userCode}). /login cancel to abort.`, { color: 'yellow' });
    }
    if (login.status === 'starting') return say('Login is starting...', { dim: true });
    const existing = client.getAuth();
    if (existing) {
      return say(`Already logged in as user ${existing.user.id} (device ${existing.deviceId}). /logout first to switch accounts.`, { color: 'yellow' });
    }

    dispatchLogin({ type: 'start' });
    const controller = new AbortController();
    startAbortRef.current = controller;
    try {
      const started = await client.startDeviceAuth({ deviceName: defaultDeviceName(), signal: controller.signal });
      const qr = await renderQr(started.qrPayload);
      if (controller.signal.aborted) return undefined;
      const { before, after } = loginInstructions(started);
      say(before, { color: 'cyan' });
      if (qr) say(qr);
      say(after, { dim: true });
      dispatchLogin({ type: 'started', response: started, now: Date.now() });
    } catch (error) {
      if (!controller.signal.aborted) {
        dispatchLogin({ type: 'start_failed', error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (startAbortRef.current === controller) startAbortRef.current = null;
    }
    return undefined;
  };

  const runLogout = async () => {
    if (isLoginActive(login)) cancelLogin();
    const { auth, corrupt } = readAuth();
    if (!auth && !corrupt) return say('Not logged in.', { dim: true });
    suspendedRef.current = true;
    syncer?.abort();
    let remote = 'skipped';
    try {
      if (client && auth && auth.serverUrl === client.serverUrl) {
        try {
          await client.logout();
          remote = 'revoked';
        } catch (error) {
          remote = error instanceof Error ? error.message : String(error);
        }
      }
      const cleared = clearAuth();
      setLoggedIn(false);
      if (!cleared.ok) return say(`Logout failed: could not delete auth.json (${cleared.error}).`, { color: 'red' });
    } finally {
      suspendedRef.current = false;
    }
    if (remote === 'revoked') return say('Logged out. This device was revoked on the server.', { color: 'green' });
    if (remote === 'skipped') return say('Logged out locally (the saved login was not for the configured server, so no server was contacted).', { color: 'green' });
    return say(`Logged out locally. The server could not be told (${remote}); revoke this device from the mini-program if needed.`, { color: 'yellow' });
  };

  /** @param {string} arg */
  const runSyncCommand = async (arg) => {
    const sub = arg || 'status';
    if (sub === 'status') {
      const auth = client ? client.getAuth() : null;
      if (client) setLoggedIn(Boolean(auth));
      const stored = readAuth().auth;
      const outbox = readOutbox();
      const lines = buildSyncStatusLines({
        server,
        account: auth,
        otherServer: stored && server.ok && stored.serverUrl !== server.url ? stored.serverUrl : null,
        login,
        snapshot: syncer ? syncer.getSnapshot() : null,
        outbox: { pending: outbox.entries.length, invalidLines: outbox.invalidLines, error: outbox.error },
        rejectedCount: countRejected(),
        now: Date.now(),
      });
      return say(lines.join('\n'), server.ok ? undefined : { color: 'yellow' });
    }
    if (sub === 'now') {
      if (!client || !syncer) return sayOff();
      if (!client.getAuth()) return say('Not logged in. Use /login first.', { color: 'yellow' });
      say('Syncing...', { dim: true });
      const summary = await syncer.requestPush({ force: true });
      const { text, ok } = describePushSummary(summary);
      return say(text, { color: ok ? 'green' : 'red' });
    }
    return say('Tip: Use /sync status or /sync now.', { color: 'yellow' });
  };

  /** Called after a record was written to the outbox. */
  const notifyRecorded = () => {
    if (syncer && !suspendedRef.current) void syncer.requestPush();
  };

  return {
    indicator: formatSyncIndicator({ server, loggedIn, login, snapshot }),
    runLogin,
    runLogout,
    runSyncCommand,
    notifyRecorded,
  };
}
