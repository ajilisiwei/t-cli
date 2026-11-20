/**
 * React glue for account settings sync (logic: settingsSync.js). Quiet by
 * design: pushes and the startup read never print; only a language taken
 * from the account is announced (through `applyLang`). Requests are
 * cancelled on unmount; an unsent change stays pending for the next start.
 */
import { useEffect, useRef } from 'react';
import { flushPendingSettings, markLangPending, reconcileSettings } from './settingsSync.js';

/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */

/**
 * @param {{ client: SyncClient | null, loggedIn: boolean, getLang: () => string,
 *           applyLang: (lang: 'zh'|'en') => void }} props
 */
export function useSettingsSync({ client, loggedIn, getLang, applyLang }) {
  const propsRef = useRef({ getLang, applyLang });
  propsRef.current = { getLang, applyLang };
  /** Bumped by every /lang; a startup read that raced a change is dropped. */
  const changesRef = useRef(0);
  /** Pushes run one after another, each sending the latest pending value. */
  const chainRef = useRef(Promise.resolve());
  const controllerRef = useRef(new AbortController());

  useEffect(() => () => controllerRef.current.abort(), []);

  // At startup and after every login: push a pending change or adopt the
  // account's explanation language.
  useEffect(() => {
    if (!client || !loggedIn) return undefined;
    const controller = new AbortController();
    const changesAtStart = changesRef.current;
    void reconcileSettings({ client, localLang: propsRef.current.getLang(), signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || result.action !== 'apply') return;
      if (changesRef.current !== changesAtStart) return;
      propsRef.current.applyLang(result.lang);
    });
    return () => controller.abort();
  }, [client, loggedIn]);

  /**
   * After a local /lang change (already saved to config.json).
   * @param {'zh'|'en'} lang
   */
  const pushLang = (lang) => {
    changesRef.current += 1;
    if (!client || !client.getAuth()) return;
    markLangPending(lang);
    const { signal } = controllerRef.current;
    chainRef.current = chainRef.current
      .then(() => (signal.aborted ? undefined : flushPendingSettings({ client, signal })))
      .catch(() => undefined);
  };

  return { pushLang };
}
