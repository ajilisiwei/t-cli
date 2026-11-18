/**
 * Application shell: starts the silent sign-in at launch so the first
 * translation usually finds a session ready. A new user is sent to the invite
 * page; any other failure (offline at launch) is retried by the first request.
 */
import { INVITE_PAGE, ensureSession } from './services/session'

App({
  onLaunch() {
    ensureSession()
      .then((state) => {
        if (state === 'invite') wx.reLaunch({ url: INVITE_PAGE, fail: () => undefined })
      })
      .catch((error: unknown) => {
        console.warn('[app] sign-in at launch failed; the first request retries', error)
      })
  },
})
