/**
 * Application shell: starts the silent sign-in at launch so the first
 * translation usually finds a session ready. A new user is sent to the invite
 * page; any other failure (offline at launch) is retried by the first request.
 * Once signed in, settings changed offline are pushed and the account's
 * settings pulled (services/settings.ts; again when the network returns).
 * Every return to the foreground posts queued ratings and refreshes the 学习
 * tab badge (throttled; quiet on failure). Exported PDFs older than 7 days are
 * deleted at launch.
 */
import { pruneExports } from './services/pdf'
import { refreshReviewBadge } from './services/review'
import { INVITE_PAGE, ensureSession, hasSession } from './services/session'
import { startSettingsSync, syncSettings } from './services/settings'

App({
  onLaunch() {
    startSettingsSync()
    try {
      pruneExports()
    } catch (error: unknown) {
      console.warn('[app] pruning old exports failed', error)
    }
    ensureSession()
      .then((state) => {
        if (state === 'invite') wx.reLaunch({ url: INVITE_PAGE, fail: () => undefined })
        else void syncSettings()
      })
      .catch((error: unknown) => {
        console.warn('[app] sign-in at launch failed; the first request retries', error)
      })
  },

  onShow() {
    if (hasSession()) void refreshReviewBadge()
  },
})
