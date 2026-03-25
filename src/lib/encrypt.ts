/**
 * AES-256-GCM encryption helpers for LinkedIn tokens and session cookies.
 *
 * Format: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 *
 * IMPORTANT: Never log or expose plaintext values — these contain credentials.
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.LINKEDIN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'LINKEDIN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string.
 * Returns "iv:authTag:ciphertext" all as hex.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  }) as crypto.CipherGCM;

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Decrypts a string produced by encrypt().
 * Throws on invalid format, wrong key, or tampered ciphertext.
 */
export function decrypt(encryptedStr: string): string {
  const parts = encryptedStr.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted string format — expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  }) as crypto.DecipherGCM;
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
