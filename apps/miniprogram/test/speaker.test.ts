import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPEECH_IDLE,
  createSpeaker,
  speechPhase,
  type Playback,
  type Speaker,
  type SpeechStatus,
} from '../miniprogram/lib/speaker.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface FakePlayback {
  path: string
  stopped: boolean
  finished: Deferred<void>
}

/** A speaker whose downloads and playbacks the test settles by hand. */
const harness = (): {
  speaker: Speaker<string>
  loads: Map<string, Deferred<string>>
  playbacks: FakePlayback[]
  seen: SpeechStatus[]
} => {
  const loads = new Map<string, Deferred<string>>()
  const playbacks: FakePlayback[] = []
  const speaker = createSpeaker<string>({
    load: (source) => {
      const load = deferred<string>()
      loads.set(source, load)
      return load.promise
    },
    play: (path): Playback => {
      const fake: FakePlayback = { path, stopped: false, finished: deferred<void>() }
      playbacks.push(fake)
      return {
        done: fake.finished.promise,
        stop: () => {
          fake.stopped = true
          fake.finished.resolve()
        },
      }
    },
  })
  const seen: SpeechStatus[] = []
  speaker.watch((status) => seen.push(status))
  return { speaker, loads, playbacks, seen }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('speechPhase: only the sounding key is busy; an empty key never is', () => {
  const playing: SpeechStatus = { key: 'a', phase: 'playing' }
  assert.equal(speechPhase(playing, 'a'), 'playing')
  assert.equal(speechPhase(playing, 'b'), 'idle')
  assert.equal(speechPhase(SPEECH_IDLE, ''), 'idle')
  assert.equal(speechPhase({ key: 'a', phase: 'loading' }, 'a'), 'loading')
})

test('a request goes loading → playing → idle', async () => {
  const { speaker, loads, playbacks, seen } = harness()
  const spoken = speaker.speak('word', 'k1')
  assert.deepEqual(speaker.status(), { key: 'k1', phase: 'loading' })
  loads.get('word')?.resolve('/tmp/k1.mp3')
  await tick()
  assert.deepEqual(speaker.status(), { key: 'k1', phase: 'playing' })
  assert.equal(playbacks[0]?.path, '/tmp/k1.mp3')
  playbacks[0]?.finished.resolve()
  await spoken
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
  assert.deepEqual(
    seen.map((status) => status.phase),
    ['loading', 'playing', 'idle'],
  )
})

test('toggle stops the key that sounds, and plays any other', async () => {
  const { speaker, loads, playbacks } = harness()
  void speaker.toggle('a', 'ka')
  loads.get('a')?.resolve('/a.mp3')
  await tick()
  assert.equal(speechPhase(speaker.status(), 'ka'), 'playing')

  await speaker.toggle('a', 'ka')
  assert.equal(playbacks[0]?.stopped, true)
  assert.deepEqual(speaker.status(), SPEECH_IDLE)

  void speaker.toggle('b', 'kb')
  assert.equal(speechPhase(speaker.status(), 'kb'), 'loading')
})

test('toggle while loading cancels: the late download never plays', async () => {
  const { speaker, loads, playbacks } = harness()
  const spoken = speaker.toggle('a', 'ka')
  await speaker.toggle('a', 'ka')
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
  loads.get('a')?.resolve('/a.mp3')
  await spoken
  assert.equal(playbacks.length, 0)
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
})

test('a newer request stops the current sound at once and owns the status', async () => {
  const { speaker, loads, playbacks } = harness()
  const first = speaker.speak('a', 'ka')
  loads.get('a')?.resolve('/a.mp3')
  await tick()
  const second = speaker.speak('b', 'kb')
  assert.equal(playbacks[0]?.stopped, true, 'the old sound stops before the new download ends')
  await first
  assert.deepEqual(speaker.status(), { key: 'kb', phase: 'loading' }, 'the old request does not reset the status')
  loads.get('b')?.resolve('/b.mp3')
  await tick()
  playbacks[1]?.finished.resolve()
  await second
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
})

test('errors: the latest request rejects and goes idle; a superseded one is silent', async () => {
  const { speaker, loads, playbacks } = harness()
  const failing = speaker.speak('a', 'ka')
  loads.get('a')?.reject(new Error('offline'))
  await assert.rejects(failing, /offline/)
  assert.deepEqual(speaker.status(), SPEECH_IDLE)

  const stale = speaker.speak('b', 'kb')
  const latest = speaker.speak('c', 'kc')
  loads.get('b')?.reject(new Error('timeout'))
  await stale
  assert.deepEqual(speaker.status(), { key: 'kc', phase: 'loading' })

  loads.get('c')?.resolve('/c.mp3')
  await tick()
  assert.deepEqual(speaker.status(), { key: 'kc', phase: 'playing' })
  playbacks[0]?.finished.reject(new Error('decode'))
  await assert.rejects(latest, /decode/)
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
})

test('watch: one call per change, none after unsubscribing; an empty key is ignored', async () => {
  const { speaker } = harness()
  const calls: string[] = []
  const unwatch = speaker.watch((status) => calls.push(`${status.key}:${status.phase}`))
  await speaker.speak('x', '')
  assert.deepEqual(calls, [])
  void speaker.speak('a', 'ka')
  speaker.stop()
  speaker.stop()
  unwatch()
  void speaker.speak('b', 'kb')
  assert.deepEqual(calls, ['ka:loading', ':idle'])
})
