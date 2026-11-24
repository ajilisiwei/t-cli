import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../miniprogram/lib/api.ts'
import {
  WORD_PAGE_SENTENCE_MAX,
  isLookupDisabled,
  lookupGloss,
  revealScrollTop,
  sheetView,
  wordPageUrl,
} from '../miniprogram/lib/lookup-view.ts'
import type { LookupResult } from '../miniprogram/lib/types.ts'

const RESULT: LookupResult = {
  lemma: 'decision',
  lang: 'en',
  cached: true,
  entry: {
    lemma: 'decision',
    ipa: { us: '/dɪˈsɪʒən/', uk: '/dɪˈsɪʒn/' },
    senses: [
      { pos: 'n.', gloss: '决定；决策', def: 'A choice made after thinking.' },
      { pos: 'n.', gloss: '决心', def: 'Determination.' },
    ],
    forms: [],
    collocations: [],
    examples: [],
    contrasts: [],
    memory: '',
  },
  context: { meaning: '会议上做出的决定。', phrase: { text: 'key decisions', gloss: '关键决策' } },
}

test('sheetView: lemma, US IPA, the written form when it differs, context and senses', () => {
  const view = sheetView(RESULT, 'decisions')
  assert.equal(view.headword, 'decision')
  assert.equal(view.ipa, '/dɪˈsɪʒən/')
  assert.equal(view.asWritten, 'decisions')
  assert.equal(view.meaning, '会议上做出的决定。')
  assert.deepEqual(view.phrase, { text: 'key decisions', gloss: '关键决策' })
  assert.deepEqual(view.senses, [
    { pos: 'n.', gloss: '决定；决策' },
    { pos: 'n.', gloss: '决心' },
  ])
  assert.equal(sheetView(RESULT, ' Decision ').asWritten, '', 'same word, other case: nothing to add')
  const bare = sheetView({ ...RESULT, context: null }, 'decision')
  assert.equal(bare.meaning, '')
  assert.equal(bare.phrase, null)
  assert.equal(lookupGloss(RESULT), '决定；决策')
})

test('wordPageUrl: every key present, encoded, sentence cut to 300 code points', () => {
  assert.equal(
    wordPageUrl('look forward to', 'I look forward to it & you?', '01JABCDEFGHJKMNPQRSTVWXYZ0'),
    '/pages/word/index?lemma=look%20forward%20to&sentence=I%20look%20forward%20to%20it%20%26%20you%3F&entryId=01JABCDEFGHJKMNPQRSTVWXYZ0',
  )
  assert.equal(wordPageUrl('set', '', null), '/pages/word/index?lemma=set&sentence=&entryId=')
  const url = wordPageUrl('a', '字'.repeat(500), null)
  const sentence = decodeURIComponent(/sentence=([^&]*)/.exec(url)?.[1] ?? '')
  assert.equal(Array.from(sentence).length, WORD_PAGE_SENTENCE_MAX)
})

test('revealScrollTop: scrolls a word hidden by the sheet into the space above it', () => {
  const base = { viewTop: 88, visibleBottom: 500, scrollTop: 200, margin: 16 }
  assert.equal(revealScrollTop({ ...base, top: 300, bottom: 330 }), null, 'already visible')
  assert.equal(revealScrollTop({ ...base, top: 600, bottom: 630 }), 200 + 630 + 16 - 500)
  assert.equal(revealScrollTop({ ...base, top: 60, bottom: 90 }), 200 - (88 - (60 - 16)))
  assert.equal(revealScrollTop({ ...base, scrollTop: 0, top: 10, bottom: 40 }), 0, 'never negative')
})

test('isLookupDisabled: only 503 LOOKUP_DISABLED', () => {
  assert.equal(isLookupDisabled(new ApiError({ kind: 'http', status: 503, code: 'LOOKUP_DISABLED', message: '' })), true)
  assert.equal(isLookupDisabled(new ApiError({ kind: 'http', status: 503, code: 'AI_UNAVAILABLE', message: '' })), false)
  assert.equal(isLookupDisabled(null), false)
  assert.equal(isLookupDisabled('LOOKUP_DISABLED'), false)
})
