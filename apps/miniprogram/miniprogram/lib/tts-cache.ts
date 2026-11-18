/**
 * Local files for 朗读: one mp3 per entry under `wx.env.USER_DATA_PATH`, so
 * replaying a result costs no request. The directory has a size quota, so
 * only the newest few are kept.
 */

export const TTS_FILE_PREFIX = 'tts-'
export const TTS_KEEP_FILES = 20

/** File name for an entry's audio; anything outside [A-Za-z0-9_-] is dropped. */
export function ttsFileName(entryId: string): string {
  return `${TTS_FILE_PREFIX}${entryId.replace(/[^A-Za-z0-9_-]/g, '')}.mp3`
}

export interface CachedFile {
  readonly name: string
  /** Last modification, any monotonic unit (seconds from `stat`). */
  readonly modified: number
}

/** Names of TTS files to delete so that at most `keep` remain (newest kept). */
export function filesToEvict(files: readonly CachedFile[], keep: number = TTS_KEEP_FILES): string[] {
  return files
    .filter((file) => file.name.startsWith(TTS_FILE_PREFIX) && file.name.endsWith('.mp3'))
    .sort((a, b) => b.modified - a.modified)
    .slice(Math.max(0, keep))
    .map((file) => file.name)
}
