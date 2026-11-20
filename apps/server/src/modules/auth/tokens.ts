import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Opaque credentials: refresh tokens, device codes, user codes, invite codes.
 * Only SHA-256 hashes of refresh tokens and device codes are ever stored.
 */

const SECRET_BYTES = 32;
/** 32 bytes in unpadded base64url. */
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 32 random bytes, base64url. */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function formatRefreshToken(deviceId: string, secret: string): string {
  return `${deviceId}.${secret}`;
}

/** Split `<deviceId>.<secret>`; null when the shape is wrong. */
export function parseRefreshToken(token: string): { deviceId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const deviceId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!DEVICE_ID_RE.test(deviceId) || !SECRET_RE.test(secret)) return null;
  return { deviceId, secret };
}

/** Six random digits, zero-padded. */
export function generateUserCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * A human-typable invite code: 12 characters without look-alikes
 * (no 0/O, 1/I/L), about 59 bits of entropy.
 */
export function generateInviteCode(length = 12): string {
  return Array.from({ length }, () => INVITE_ALPHABET[randomInt(0, INVITE_ALPHABET.length)]).join('');
}

/** Invite codes are matched case-insensitively and without surrounding spaces. */
export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}
