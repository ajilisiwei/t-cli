import { createEntry, validateEntry, type Entry, type EntryKind, type EntrySrcLang } from '@t-cli/core/entry';
import { toIsoWithOffset } from '../../db/entriesRepo.ts';
import type { AiMode, AiTask } from './prompt.ts';

export interface MpEntryFields {
  text: string;
  output: string;
  task: AiTask;
  mode: AiMode;
  srcLang: EntrySrcLang;
  /** As announced in the stream's `meta` line, so the stored entry matches it. */
  kind: EntryKind;
  /** Server time when the result finished. */
  now: Date;
  /** The client's local offset; createdAt is expressed in it. */
  utcOffsetMinutes: number;
}

/**
 * Build the Entry stored for a finished mini-program request.
 *
 * createEntry derives id, kind, normalized text and correctedInput exactly as
 * the CLI does, but formats createdAt in the server process's time zone; the
 * timestamp is rebuilt in the client's offset and the entry re-validated.
 */
export function buildMpEntry({ text, output, task, mode, srcLang, kind, now, utcOffsetMinutes }: MpEntryFields): Entry {
  const createdAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const draft = createEntry({ source: 'mp', task, input: text, output, mode, srcLang, kind, createdAt });
  const result = validateEntry({ ...draft, createdAt: toIsoWithOffset(createdAt, utcOffsetMinutes) });
  if (!result.ok) throw new Error(`invalid entry: ${result.errors.join('; ')}`);
  return result.entry;
}
