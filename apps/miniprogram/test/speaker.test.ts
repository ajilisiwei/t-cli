import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPEECH_IDLE,
  createSpeaker,
  speechPhase,
  speechProgress,
  type LoadedPart,
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

/** A downloaded part; `parts` is what the first part's answer says. */
const part = (path: string, parts = 1): LoadedPart => ({ path, parts })

/**
 * A speaker whose downloads and playbacks the test settles by hand. Part 0
 * of a source is `loads.get(source)`, part n `loads.get('source#n')`.
 */
const harness = (): {
  speaker: Speaker<string>
  loads: Map<string, Deferred<LoadedPart | null>>
  playbacks: FakePlayback[]
  seen: SpeechStatus[]
} => {
  const loads = new Map<string, Deferred<LoadedPart | null>>()
  const playbacks: FakePlayback[] = []
  const speaker = createSpeaker<string>({
    load: (source, _key, index) => {
      const load = deferred<LoadedPart | null>()
      loads.set(index === 0 ? source : `${source}#${index}`, load)
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
  loads.get('word')?.resolve(part('/tmp/k1.mp3'))
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
  loads.get('a')?.resolve(part('/a.mp3'))
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
  loads.get('a')?.resolve(part('/a.mp3'))
  await spoken
  assert.equal(playbacks.length, 0)
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
})

test('a newer request stops the current sound at once and owns the status', async () => {
  const { speaker, loads, playbacks } = harness()
  const first = speaker.speak('a', 'ka')
  loads.get('a')?.resolve(part('/a.mp3'))
  await tick()
  const second = speaker.speak('b', 'kb')
  assert.equal(playbacks[0]?.stopped, true, 'the old sound stops before the new download ends')
  await first
  assert.deepEqual(speaker.status(), { key: 'kb', phase: 'loading' }, 'the old request does not reset the status')
  loads.get('b')?.resolve(part('/b.mp3'))
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

  loads.get('c')?.resolve(part('/c.mp3'))
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

// ---- speech in parts ----

test('parts play in sequence under one key; the next part downloads while one plays', async () => {
  const { speaker, loads, playbacks, seen } = harness()
  const spoken = speaker.speak('long', 'k')
  assert.equal(loads.size, 1, 'only part 0 is requested before its answer says how many parts there are')
  loads.get('long')?.resolve(part('/p0.mp3', 3))
  await tick()
  assert.deepEqual(speaker.status(), { key: 'k', phase: 'playing', part: 1, parts: 3 })
  assert.ok(loads.has('long#1'), 'part 1 is fetched while part 0 plays')
  assert.equal(loads.has('long#2'), false)

  loads.get('long#1')?.resolve(part('/p1.mp3', 3))
  playbacks[0]?.finished.resolve()
  await tick()
  assert.deepEqual(speaker.status(), { key: 'k', phase: 'playing', part: 2, parts: 3 })
  assert.equal(playbacks[1]?.path, '/p1.mp3')
  assert.ok(loads.has('long#2'))

  playbacks[1]?.finished.resolve()
  await tick()
  assert.deepEqual(speaker.status(), { key: 'k', phase: 'loading', part: 3, parts: 3 }, 'waiting for a slow part shows loading')
  loads.get('long#2')?.resolve(part('/p2.mp3', 3))
  await tick()
  assert.deepEqual(speaker.status(), { key: 'k', phase: 'playing', part: 3, parts: 3 })
  playbacks[2]?.finished.resolve()
  await spoken
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
  assert.deepEqual(
    playbacks.map((playback) => playback.path),
    ['/p0.mp3', '/p1.mp3', '/p2.mp3'],
  )
  assert.equal(loads.has('long#3'), false, 'no part past the count is requested')
  assert.equal(seen.at(-1)?.phase, 'idle')
})

test('a part that is ready when the previous one ends plays without a loading flicker', async () => {
  const { speaker, loads, playbacks, seen } = harness()
  const spoken = speaker.speak('long', 'k')
  loads.get('long')?.resolve(part('/p0.mp3', 2))
  await tick()
  loads.get('long#1')?.resolve(part('/p1.mp3', 2))
  await tick()
  playbacks[0]?.finished.resolve()
  await tick()
  playbacks[1]?.finished.resolve()
  await spoken
  assert.deepEqual(
    seen.map((status) => `${status.phase}${status.part ?? ''}`),
    ['loading', 'playing1', 'playing2', 'idle'],
  )
})

test('tapping a multi-part text stops the whole sequence; parts still downloading never play', async () => {
  const { speaker, loads, playbacks } = harness()
  const spoken = speaker.toggle('long', 'k')
  loads.get('long')?.resolve(part('/p0.mp3', 3))
  await tick()
  assert.equal(speechPhase(speaker.status(), 'k'), 'playing')

  await speaker.toggle('long', 'k')
  assert.equal(playbacks[0]?.stopped, true)
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
  loads.get('long#1')?.resolve(part('/p1.mp3', 3))
  await spoken
  await tick()
  assert.equal(playbacks.length, 1, 'part 1 arrived after the stop and does not play')
  assert.equal(loads.has('long#2'), false)
})

test('a stopped sequence ignores a later failure of the part it was fetching', async () => {
  const { speaker, loads } = harness()
  const spoken = speaker.speak('long', 'k')
  loads.get('long')?.resolve(part('/p0.mp3', 2))
  await tick()
  speaker.stop()
  loads.get('long#1')?.reject(new Error('offline'))
  await spoken
  await tick()
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
})

test('a failing later part rejects the request after the earlier parts played', async () => {
  const { speaker, loads, playbacks } = harness()
  const spoken = speaker.speak('long', 'k')
  loads.get('long')?.resolve(part('/p0.mp3', 2))
  await tick()
  loads.get('long#1')?.reject(new Error('timeout'))
  playbacks[0]?.finished.resolve()
  await assert.rejects(spoken, /timeout/)
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
})

test('a missing later part (null) ends the sequence quietly', async () => {
  const { speaker, loads, playbacks } = harness()
  const spoken = speaker.speak('long', 'k')
  loads.get('long')?.resolve(part('/p0.mp3', 3))
  await tick()
  loads.get('long#1')?.resolve(null)
  playbacks[0]?.finished.resolve()
  await spoken
  assert.equal(playbacks.length, 1)
  assert.deepEqual(speaker.status(), SPEECH_IDLE)
})

test('a newer key during a multi-part text takes over at once', async () => {
  const { speaker, loads, playbacks } = harness()
  const first = speaker.speak('long', 'k1')
  loads.get('long')?.resolve(part('/p0.mp3', 4))
  await tick()
  const second = speaker.speak('short', 'k2')
  assert.equal(playbacks[0]?.stopped, true)
  await first
  assert.deepEqual(speaker.status(), { key: 'k2', phase: 'loading' })
  loads.get('long#1')?.resolve(part('/p1.mp3', 4))
  loads.get('short')?.resolve(part('/s.mp3'))
  await tick()
  playbacks[1]?.finished.resolve()
  await second
  assert.deepEqual(
    playbacks.map((playback) => playback.path),
    ['/p0.mp3', '/s.mp3'],
  )
})

test('speechProgress: "part/parts" for the sounding multi-part key only', () => {
  assert.equal(speechProgress({ key: 'k', phase: 'playing', part: 2, parts: 9 }, 'k'), '2/9')
  assert.equal(speechProgress({ key: 'k', phase: 'loading', part: 3, parts: 9 }, 'k'), '3/9')
  assert.equal(speechProgress({ key: 'k', phase: 'playing', part: 2, parts: 9 }, 'other'), '')
  assert.equal(speechProgress({ key: 'k', phase: 'playing' }, 'k'), '')
  assert.equal(speechProgress(SPEECH_IDLE, ''), '')
})
