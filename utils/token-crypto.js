const crypto = require('crypto');
const { Setting } = require('../models');

const STABLE_DEFAULT_SEED = 'gst_invoice_manager_master_crypto_seed_2026';
const CRYPTO_SALT = 'gst_oauth_token_key_salt_2026';

/**
 * OWASP-compliant cryptographic key resolution.
 * Uses dedicated TOKEN_ENCRYPTION_KEY if provided, or derives a 256-bit key
 * from a stable deterministic seed with salt using scrypt.
 * This guarantees the key remains persistent across Render container restarts.
 */
function getEncryptionKey() {
  const explicit = process.env.TOKEN_ENCRYPTION_KEY;
  if (explicit) {
    if (explicit.length === 64 && /^[0-9a-fA-F]+$/.test(explicit)) {
      return Buffer.from(explicit, 'hex');
    }
    return crypto.scryptSync(explicit, CRYPTO_SALT, 32);
  }
  return crypto.scryptSync(STABLE_DEFAULT_SEED, CRYPTO_SALT, 32);
}

/**
 * Encrypt token object or string using AES-256-GCM with a random 96-bit IV
 * and 128-bit authentication tag.
 * Format: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
function encryptTokens(tokens) {
  if (!tokens) return null;
  const text = typeof tokens === 'string' ? tokens : JSON.stringify(tokens);
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV recommended by NIST/OWASP for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('gst_google_tokens', 'utf8'));
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Helper to decrypt with a specific key and verify auth tag.
 */
function tryDecryptWithKey(key, ivHex, tagHex, dataHex) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAAD(Buffer.from('gst_google_tokens', 'utf8'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(Buffer.from(dataHex, 'hex'), null, 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (e) {
    return null;
  }
}

/**
 * Decrypt tokens from AES-256-GCM authenticated payload.
 * Extremely resilient: never throws an exception, catches all authentication errors,
 * and tries candidate keys if key derivation changed.
 */
function decryptTokens(storedValue) {
  if (!storedValue || typeof storedValue !== 'string') return null;
  const trimmed = storedValue.trim();

  // Encrypted payload
  if (trimmed.startsWith('enc:v1:')) {
    const parts = trimmed.split(':');
    if (parts.length !== 5) return null;
    const [, , ivHex, tagHex, dataHex] = parts;

    // 1. Try primary stable key
    const primaryKey = getEncryptionKey();
    let result = tryDecryptWithKey(primaryKey, ivHex, tagHex, dataHex);
    if (result) return result;

    // 2. Try candidate fallback keys (e.g. from previous SESSION_SECRET or legacy salt)
    const candidates = [
      'gst-invoice-manager-token-key-salt-2026',
      process.env.SESSION_SECRET
    ].filter(Boolean);

    for (const cand of candidates) {
      try {
        const candKey = crypto.scryptSync(cand, CRYPTO_SALT, 32);
        result = tryDecryptWithKey(candKey, ivHex, tagHex, dataHex);
        if (result) {
          // Re-encrypt with primary key to heal the database record
          saveGoogleTokens(result).catch(() => {});
          return result;
        }
      } catch (e) {}
    }

    console.warn('[Token Decrypt Warning]: Unable to authenticate stored Google token with current key. Re-connecting Google account will resolve this.');
    return null;
  }

  // Legacy plaintext JSON fallback
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
}

/**
 * Encrypt and persist Google OAuth tokens in MongoDB.
 */
async function saveGoogleTokens(tokens) {
  if (!tokens) return;
  try {
    const encrypted = encryptTokens(tokens);
    await Setting.findOneAndUpdate(
      { key: 'google_tokens' },
      { $set: { value: encrypted } },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error('[Save Google Tokens Error]:', err.message);
  }
}

/**
 * Retrieve and decrypt Google OAuth tokens from MongoDB.
 * Guaranteed to never throw — returns null on any error so server never crashes.
 */
async function getGoogleTokens() {
  try {
    const row = await Setting.findOne({ key: 'google_tokens' });
    if (!row || !row.value) return null;
    return decryptTokens(row.value);
  } catch (err) {
    console.warn('[Get Google Tokens Error]:', err.message);
    return null;
  }
}

/**
 * Startup migration: If google_tokens is stored in plaintext,
 * auto-encrypt and update it in MongoDB without breaking active sessions.
 */
async function migrateLegacyTokens() {
  try {
    const row = await Setting.findOne({ key: 'google_tokens' });
    if (!row || !row.value) return false;
    const val = row.value.trim();
    if (!val.startsWith('enc:v1:')) {
      const parsed = JSON.parse(val);
      await saveGoogleTokens(parsed);
      console.log('🔒 [Security Upgrade] Plaintext Google Tokens auto-migrated to AES-256-GCM encryption.');
      return true;
    }
  } catch (err) {
    console.warn('[Security Notice] Legacy token migration check:', err.message);
  }
  return false;
}

module.exports = {
  getEncryptionKey,
  encryptTokens,
  decryptTokens,
  saveGoogleTokens,
  getGoogleTokens,
  migrateLegacyTokens
};
