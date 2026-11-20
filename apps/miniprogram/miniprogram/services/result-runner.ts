/**
 * Runs one translate/check request at a time for a page.
 *
 * A new run aborts the previous one, and a generation counter drops anything
 * the old request still delivers. Rendering during streaming is throttled:
 * `setData` per delta would flood the render thread on a fast stream.
 */
import { ApiError, errorMessage, isApiError } from '../lib/api'
import {
  IDLE_RESULT,
  WAITING_RESULT,
  applyStreamEvent,
  failResult,
  finishResult,
  stopResult,
  type ResultState,
} from '../lib/result'
import type { TranslateRequest } from '../lib/types'
import { redirectIfInviteRequired } from './session'
import { startTranslateStream, type StreamHandle } from './stream'

const RENDER_INTERVAL_MS = 60

export interface RunnerView {
  readonly state: ResultState
  /** The Chinese error line to show, or ''. */
  readonly errorText: string
}

export interface ResultRunner {
  run(request: TranslateRequest): Promise<void>
  stop(): void
  reset(): void
  current(): RunnerView
}

export function createResultRunner(render: (view: RunnerView) => void): ResultRunner {
  let state: ResultState = IDLE_RESULT
  let errorText = ''
  let handle: StreamHandle | null = null
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const renderNow = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    render({ state, errorText })
  }

  const scheduleRender = (): void => {
    if (timer !== null) return
    timer = setTimeout(renderNow, RENDER_INTERVAL_MS)
  }

  const cancel = (): void => {
    generation += 1
    handle?.abort()
    handle = null
  }

  return {
    async run(request) {
      cancel()
      const mine = generation
      state = WAITING_RESULT
      errorText = ''
      renderNow()
      const running = startTranslateStream(request, (event) => {
        if (mine !== generation) return
        state = applyStreamEvent(state, event)
        if (event.type === 'error') {
          errorText = errorMessage(new ApiError({ kind: 'http', code: event.code, message: event.message }))
        }
        scheduleRender()
      })
      handle = running
      try {
        await running.done
        if (mine !== generation) return
        state = finishResult(state)
        if (state.status === 'failed' && errorText === '') {
          errorText = errorMessage(new ApiError({ kind: 'http', code: state.errorCode ?? 'INTERNAL', message: '' }))
        }
      } catch (error: unknown) {
        if (mine !== generation) return
        if (isApiError(error) && error.code === 'ABORTED') return
        if (redirectIfInviteRequired(error)) return
        state = failResult(state, isApiError(error) ? error.code : 'INTERNAL')
        errorText = errorMessage(error)
      }
      handle = null
      renderNow()
    },
    stop() {
      cancel()
      state = stopResult(state)
      renderNow()
    },
    reset() {
      cancel()
      state = IDLE_RESULT
      errorText = ''
      renderNow()
    },
    current() {
      return { state, errorText }
    },
  }
}
