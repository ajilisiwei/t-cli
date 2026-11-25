import type { StudyLevel } from './learnContent.ts';
import { askJson, byRef, MAX_ATTEMPTS, type RunContext } from './llmJson.ts';
import type { ReadyItem } from './materialData.ts';
import { dailyExtrasMessages, type MistakeRequest } from './prompts.ts';
import { DailyExtrasSchema, MistakeNoteSchema, StorySchema, type ExplanationLang, type ItemContent } from './schemas.ts';
import { containsCjk, findTarget, wordCount, wordKey } from './text.ts';

/**
 * The model-written parts of a daily material or digest: the story and the
 * mistake notes, in one JSON call (retried for whatever is still invalid).
 * Everything else in a material comes from item contents and statistics.
 */

export const STORY_MIN_WORDS = 5;

export type Story = { title: string; text: string; words: string[]; zh: string };
export type Mistake = { itemId: string; display: string; note: string; example: { en: string; zh: string } };

export function knownExampleOf(item: ItemContent): { en: string; zh: string } {
  if (item.type === 'grammar') return { en: item.content.right, zh: item.content.title };
  const [first, second] = item.content.examples;
  const example = second ?? first;
  return example ? { en: example.en, zh: example.zh } : { en: '', zh: '' };
}

/** Without a model answer, the mistake section repeats the item's own explanation. */
function fallbackNote(item: ReadyItem): Mistake {
  const { parsed } = item;
  const note =
    parsed.type === 'word'
      ? parsed.content.meanings.map((meaning) => `${meaning.pos} ${meaning.zh}`).join('；')
      : parsed.type === 'phrase'
        ? parsed.content.zh
        : parsed.content.rule;
  return { itemId: item.id, display: item.display, note, example: knownExampleOf(parsed) };
}

export function validateStory(raw: unknown, storyWords: readonly string[], lang: ExplanationLang): Story | null {
  const parsed = StorySchema.safeParse(raw);
  if (!parsed.success) return null;
  const story = parsed.data;
  const byKey = new Map(storyWords.map((word) => [wordKey(word), word]));
  const words = [...new Set(story.words.map((word) => byKey.get(wordKey(word))))];
  if (words.some((word) => word === undefined) || words.length < STORY_MIN_WORDS) return null;
  const used = words.filter((word): word is string => word !== undefined);
  if (!used.every((word) => findTarget(story.text, word))) return null;
  const length = wordCount(story.text);
  if (length < 60 || length > 250) return null;
  if (lang === 'zh' && !containsCjk(story.zh)) return null;
  return { title: story.title, text: story.text, words: used, zh: story.zh };
}

function validateNote(raw: unknown, lang: ExplanationLang): { note: string; example: { en: string; zh: string } } | null {
  const parsed = MistakeNoteSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (lang === 'zh' && !containsCjk(parsed.data.note)) return null;
  return { note: parsed.data.note, example: parsed.data.example };
}

export interface ExtrasRequest {
  date: string;
  /** Headwords the story may use; fewer than STORY_MIN_WORDS (or none when the story is off) → no story. */
  storyWords: readonly string[];
  mistakeItems: readonly ReadyItem[];
  /** The account's effective study level: the story is written at it. */
  level: StudyLevel;
}

/** The story and the mistake notes; no call at all when there is neither a story to write nor a mistake to explain. */
export async function dailyExtras(ctx: RunContext, { date, storyWords, mistakeItems, level }: ExtrasRequest): Promise<{ story: Story | null; mistakes: Mistake[] }> {
  if (storyWords.length < STORY_MIN_WORDS && mistakeItems.length === 0) return { story: null, mistakes: [] };
  const requests: MistakeRequest[] = mistakeItems.map((item, i) => ({
    ref: `m${i + 1}`,
    type: item.parsed.type,
    display: item.display,
    knownExample: knownExampleOf(item.parsed).en,
  }));
  let story: Story | null | undefined = storyWords.length >= STORY_MIN_WORDS ? undefined : null;
  let notes = new Map<string, { note: string; example: { en: string; zh: string } }>();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const wantStory = story === undefined;
    const wanted = requests.filter((request) => !notes.has(request.ref));
    if (!wantStory && wanted.length === 0) break;
    const answer = await askJson(ctx, dailyExtrasMessages({ date, storyWords: wantStory ? storyWords : [], mistakes: wanted, level }, ctx.lang));
    if (!answer.ok) continue;
    const extras = DailyExtrasSchema.safeParse(answer.value);
    if (!extras.success) continue;
    if (wantStory) story = validateStory(extras.data.story, storyWords, ctx.lang) ?? undefined;
    const answered = byRef(extras.data.mistakes ?? []);
    const valid = wanted.flatMap((request) => {
      const note = validateNote(answered.get(request.ref), ctx.lang);
      return note ? [[request.ref, note] as const] : [];
    });
    notes = new Map([...notes, ...valid]);
  }

  const mistakes = mistakeItems.map((item, i) => {
    const note = notes.get(`m${i + 1}`);
    return note ? { itemId: item.id, display: item.display, ...note } : fallbackNote(item);
  });
  return { story: story ?? null, mistakes };
}
