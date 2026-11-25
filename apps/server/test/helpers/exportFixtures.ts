import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * PDF export test support: the materials of the approved prototype
 * (PdfP1–PdfP4) as stored content, and the Typst toolchain to render with.
 *
 * Render tests need Typst and the fonts: set TYPST_BIN and TYPST_FONT_PATH
 * (CI installs both with apps/server/deploy/fetch-typst.sh, which fetches
 * the Linux x86_64 binary; on a Mac use a typst 0.13.1 build for macOS and
 * the same font files). Without them those tests are skipped.
 */

export const TYPST_BIN = process.env.TYPST_BIN ?? 'typst';
export const TYPST_FONT_PATH = process.env.TYPST_FONT_PATH ?? '';

function typstMissing(): string | false {
  if (!TYPST_FONT_PATH || !existsSync(TYPST_FONT_PATH)) return 'TYPST_FONT_PATH is not set to an existing font directory';
  const probe = spawnSync(TYPST_BIN, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? false : `typst is not runnable (${TYPST_BIN})`;
}

const missing = typstMissing();
// CI sets TYPST_REQUIRED=1: there the render tests must run, never skip.
if (missing && process.env.TYPST_REQUIRED === '1') throw new Error(`TYPST_REQUIRED=1 but ${missing}`);

export const skipWithoutTypst: string | false = missing;

const example = (en: string, zh: string, fromUser = false) => ({ en, zh, fromUser });

const word = (itemId: string, headword: string, ipa: string, meanings: [string, string][], examples: [string, string][]) => ({
  itemId,
  headword,
  ipa,
  meanings: meanings.map(([pos, zh]) => ({ pos, zh })),
  examples: examples.map(([en, zh]) => example(en, zh)),
  collocations: [],
  synonyms: [],
  family: [],
});

const phrase = (itemId: string, text: string, zh: string, examples: [string, string][]) => ({
  itemId,
  phrase: text,
  zh,
  register: 'neutral',
  alternatives: [
    { en: 'come back to', note: '更口语' },
    { en: 'revisit', note: '更正式' },
  ],
  examples: examples.map(([en, zh]) => example(en, zh)),
});

/** The prototype's daily material (11月24日): 6 words, 2 phrases, 2 grammar points, a story, 1 mistake. */
export function prototypeDaily(date = '2026-11-24'): Record<string, unknown> {
  return {
    date,
    overview: { newWords: 6, newPhrases: 2, corrections: 2, streakDays: 5 },
    words: [
      word('w1', 'mitigate', '/ˈmɪtɪɡeɪt/', [['v.', '减轻；缓和']], [
        ['We added a backup server to mitigate the risk.', '我们加了一台备用服务器来降低风险。'],
        ['Wearing a helmet can mitigate the damage in an accident.', '戴头盔可以减轻事故中的伤害。'],
      ]),
      word('w2', 'concise', '/kənˈsaɪs/', [['adj.', '简洁的；简明的']], [
        ['Keep your summary concise and clear.', '总结要写得简洁清楚。'],
        ['Could you make the slides more concise?', '你能把幻灯片做得更简洁些吗？'],
      ]),
      word('w3', 'meticulous', '/məˈtɪkjələs/', [['adj.', '一丝不苟的']], [
        ['She is meticulous about every number.', '她对每一个数字都一丝不苟。'],
        ['He keeps meticulous notes.', '他的笔记记得非常仔细。'],
      ]),
      word('w4', 'deadline', '/ˈdedlaɪn/', [['n.', '截止日期；最后期限']], [
        ['The deadline for the report is Friday.', '报告的截止日期是周五。'],
        ['The deadline for the application is next Monday.', '申请的截止日期是下周一。'],
      ]),
      word('w5', 'postpone', '/poʊstˈpoʊn/', [['v.', '推迟；延期']], [
        ['They postponed the launch by a week.', '他们把发布推迟了一周。'],
        ['It is raining hard, so they will postpone the picnic.', '雨下得很大，他们会推迟野餐。'],
      ]),
      word('w6', 'solve', '/sɑːlv/', [['v.', '解决；解答']], [
        ['This problem is easy to solve.', '这个问题很好解决。'],
        ['Nobody could solve the last puzzle.', '最后一个谜题谁都没解开。'],
      ]),
    ],
    phrases: [
      phrase('p1', 'circle back', '回头再讨论', [["Let's circle back on this after lunch.", '这件事我们午饭后再谈。']]),
      phrase('p2', 'follow up on', '跟进；继续处理', [["I'll follow up on the invoice today.", '我今天会跟进这张发票。']]),
    ],
    grammar: [
      {
        itemId: 'g1',
        title: '一般过去时',
        rule: '有 yesterday 这类明确的过去时间，用一般过去时。',
        wrong: 'I have sent it yesterday.',
        right: 'I sent it yesterday.',
        exercises: [
          { wrong: 'I have seen him last week.', right: 'I saw him last week.' },
          { wrong: 'She has left two days ago.', right: 'She left two days ago.' },
          { wrong: 'We have met in 2020.', right: 'We met in 2020.' },
        ],
      },
      {
        itemId: 'g2',
        title: '主谓一致',
        rule: "主语是第三人称单数，助动词用 doesn't。",
        wrong: "She don't know the answer.",
        right: "She doesn't know the answer.",
        exercises: [
          { wrong: "He don't like coffee.", right: "He doesn't like coffee." },
          { wrong: "It don't matter.", right: "It doesn't matter." },
          { wrong: "My boss don't agree.", right: "My boss doesn't agree." },
        ],
      },
    ],
    story: {
      title: 'A Quiet Monday Meeting',
      text:
        'The team had a tight deadline, so Mia kept her update concise. She was meticulous about the numbers and suggested two ways to mitigate the risk of a late launch.\n' +
        'Most questions were easy to solve. The last one was not: nobody knew whether the new supplier could deliver on time. Instead of guessing, the manager decided to postpone the decision and circle back on Friday.\n' +
        'After the meeting, Mia wrote a short email to follow up on the supplier question.',
      words: ['deadline', 'concise', 'meticulous', 'mitigate', 'solve', 'postpone'],
      zh: '团队的截止日期很紧，米娅把汇报写得很简洁，对数字一丝不苟，还提出两个降低延期风险的办法。最后一个问题暂时没法确定，经理决定推迟，周五再议；会后米娅发邮件跟进。',
    },
    mistakes: [
      {
        itemId: 'w7',
        display: 'allocate',
        note: '分配；拨出。常和 to 连用：allocate money to a project。',
        example: { en: 'We need to allocate more time to testing.', zh: '我们需要给测试分配更多时间。' },
      },
    ],
  };
}

/** A digest over 11月18日–24日: the daily content plus what was forgotten in review. */
export function prototypeDigest(date = '2026-11-24'): Record<string, unknown> {
  return {
    ...prototypeDaily(date),
    range: { start: '2026-11-18', end: date },
    review: [
      { itemId: 'w8', display: 'reluctant', gloss: 'adj. 不情愿的', lapses: 3 },
      { itemId: 'w9', display: 'feasible', gloss: 'adj. 可行的', lapses: 2 },
    ],
  };
}

/** An extension material (职场, B1). */
export function prototypeExtend(): Record<string, unknown> {
  const item = (text: string, kind: 'word' | 'phrase', gloss: string, en: string, zh: string) => ({ text, kind, gloss, example: { en, zh } });
  return {
    focus: 'topic',
    topic: 'work',
    title: '开会和跟进的常用说法',
    level: 'B1',
    reasons: ['最近 7 天你查了 deadline、postpone 等 6 个职场用词', 'circle back 在复习时忘了 2 次'],
    evidence: ['deadline', 'postpone', 'circle back'],
    items: [
      item('agenda', 'word', 'n. 议程', 'Let me share the agenda before we start.', '开始前我先把议程发给大家。'),
      item('minutes', 'word', 'n. 会议记录', 'Who is taking the minutes today?', '今天谁做会议记录？'),
      item('action item', 'phrase', '待办事项', 'Each action item needs an owner.', '每个待办事项都要有负责人。'),
      item('touch base', 'phrase', '简单沟通一下', "Let's touch base on Friday.", '我们周五简单碰一下。'),
      item('wrap up', 'phrase', '收尾；结束', "Let's wrap up the meeting here.", '会议就到这里吧。'),
      item('stakeholder', 'word', 'n. 利益相关方', 'We should update every stakeholder.', '我们应该向每个相关方同步进展。'),
    ],
    passage: {
      title: 'Before the Weekly Sync',
      text: 'Before the weekly sync, Leo sent the agenda to every stakeholder. During the meeting, Ana took the minutes and listed each action item.\nAt the end, Leo said they would touch base on Friday and wrap up the project by the end of the month.',
      zh: '周会前，Leo 把议程发给了所有相关方。会上 Ana 做记录并列出每个待办事项。最后 Leo 说周五再碰一下，月底前把项目收尾。',
    },
    grammar: {
      rule: 'look forward to 后面接名词或动名词（-ing），不接动词原形。',
      examples: [
        { wrong: 'I look forward to hear from you.', right: 'I look forward to hearing from you.' },
        { wrong: 'We look forward to work with you.', right: 'We look forward to working with you.' },
      ],
    },
  };
}

/** Strings that would do something if Typst ever read them as markup or code. */
export const INJECTION_STRINGS = {
  setPage: '#set page(fill: red)',
  evalCall: '#eval("1+1")',
  markup: '*bold* _emph_ $x^2$ @ref <lbl> `raw`',
  escapes: '\\ backslash ] [ // comment /* block */',
  readFile: '#read("/etc/passwd")',
} as const;
