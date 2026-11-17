import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '@t-cli/core/ulid';
import {
  formatRefreshToken,
  generateInviteCode,
  generateSecret,
  generateUserCode,
  hashesEqual,
  normalizeInviteCode,
  parseRefreshToken,
  sha256Hex,
} from '../src/modules/auth/tokens.ts';

test('secrets are 32 random bytes in base64url', () => {
  const a = generateSecret();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.notEqual(a, generateSecret());
});

test('refresh tokens round-trip as <deviceId>.<secret>', () => {
  const deviceId = ulid();
  const secret = generateSecret();
  const token = formatRefreshToken(deviceId, secret);
  assert.equal(token, `${deviceId}.${secret}`);
  assert.deepEqual(parseRefreshToken(token), { deviceId, secret });
});

test('malformed refresh tokens are rejected', () => {
  const deviceId = ulid();
  const secret = generateSecret();
  for (const token of ['', secret, `${deviceId}`, `${deviceId}.`, `.${secret}`, `${deviceId.toLowerCase()}.${secret}`, `${deviceId}.${secret}x`, `${deviceId}.${secret}.x`, `${deviceId}.${secret.slice(1)}=`]) {
    assert.equal(parseRefreshToken(token), null, token);
  }
});

test('hash comparison is exact and length-safe', () => {
  const h = sha256Hex('a');
  assert.equal(h.length, 64);
  assert.equal(hashesEqual(h, sha256Hex('a')), true);
  assert.equal(hashesEqual(h, sha256Hex('b')), false);
  assert.equal(hashesEqual(h, h.slice(0, 62)), false);
  assert.equal(hashesEqual('', ''), false);
});

test('user codes are six digits', () => {
  for (let i = 0; i < 200; i += 1) assert.match(generateUserCode(), /^\d{6}$/);
});

test('invite codes avoid look-alike characters and normalise', () => {
  for (let i = 0; i < 100; i += 1) assert.match(generateInviteCode(), /^[A-HJKMNP-Z2-9]{12}$/);
  assert.equal(normalizeInviteCode('  abcd2345 '), 'ABCD2345');
});
