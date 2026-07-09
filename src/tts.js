import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { containsCJK } from './utils/detect.js';

// Edge Read Aloud is an unofficial free endpoint with no SLA. Microsoft has
// tightened its auth before (Sec-MS-GEC token), so synthesis can start failing
// at any time — that is why a local `say` fallback is kept below.
const VOICES = {
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-AriaNeural'
};

const SAY_VOICES = {
  zh: 'Tingting',
  en: 'Samantha'
};

const SYNTH_TIMEOUT_MS = 15000;

let session = null;

/**
 * Pick a neural voice based on the text language.
 * @param {string} text
 * @returns {string}
 */
export function detectVoice(text) {
  return containsCJK(text) ? VOICES.en : VOICES.zh;
}

export function isSpeaking() {
  return session !== null;
}

/**
 * Stop the current playback/synthesis. Idempotent.
 */
export function stop() {
  if (!session) return;
  session.cancelled = true;
  if (session.child && session.child.exitCode === null) {
    session.child.kill();
  }
  session = null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function synthesize(text, voice) {
  const tts = new MsEdgeTTS();
  try {
    await withTimeout(
      tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3),
      SYNTH_TIMEOUT_MS,
      'edge-tts connection'
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-tts-'));
    const { audioFilePath } = await withTimeout(
      tts.toFile(dir, text),
      SYNTH_TIMEOUT_MS,
      'edge-tts synthesis'
    );
    return audioFilePath;
  } finally {
    if (typeof tts.close === 'function') {
      try { tts.close(); } catch (_) { /* best effort */ }
    }
  }
}

function getPlayerCommand(file) {
  if (process.platform === 'darwin') {
    return { command: 'afplay', args: [file] };
  }
  if (process.platform === 'linux') {
    return { command: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] };
  }
  return null;
}

function runChild(command, args, currentSession) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    currentSession.child = child;
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
}

async function playLocalFallback(text, currentSession, onWarn) {
  if (process.platform !== 'darwin') {
    if (onWarn) onWarn('No local TTS fallback available on this platform.');
    return;
  }
  const voice = containsCJK(text) ? SAY_VOICES.zh : SAY_VOICES.en;
  try {
    await runChild('say', ['-v', voice, text], currentSession);
  } catch (_) {
    // Voice may be missing on this machine — retry with the system default.
    if (currentSession.cancelled) return;
    try {
      await runChild('say', [text], currentSession);
    } catch (error) {
      if (onWarn) onWarn(`Local TTS failed: ${error.message}`);
    }
  }
}

function cleanupFile(file) {
  if (!file) return;
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch (_) { /* best effort */ }
}

/**
 * Speak the given text: synthesize via edge-tts and play the resulting mp3,
 * falling back to the local `say` command when synthesis or playback fails.
 * Any previous playback is stopped first. Resolves when playback ends.
 * @param {string} text
 * @param {{ onWarn?: (message: string) => void }} [options]
 */
export async function speak(text, { onWarn } = {}) {
  stop();
  const currentSession = { cancelled: false, child: null };
  session = currentSession;

  let file = null;
  try {
    try {
      file = await synthesize(text, detectVoice(text));
    } catch (error) {
      if (currentSession.cancelled) return;
      if (onWarn) onWarn(`edge-tts unavailable (${error.message}). Falling back to local voice.`);
      await playLocalFallback(text, currentSession, onWarn);
      return;
    }

    if (currentSession.cancelled) return;

    const player = getPlayerCommand(file);
    if (!player) {
      if (onWarn) onWarn('No audio player available on this platform. Falling back to local voice.');
      await playLocalFallback(text, currentSession, onWarn);
      return;
    }

    try {
      await runChild(player.command, player.args, currentSession);
    } catch (error) {
      if (currentSession.cancelled) return;
      if (onWarn) onWarn(`Audio player failed (${error.message}). Falling back to local voice.`);
      await playLocalFallback(text, currentSession, onWarn);
    }
  } finally {
    cleanupFile(file);
    if (session === currentSession) {
      session = null;
    }
  }
}
