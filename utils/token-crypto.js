const crypto = require('crypto');
const { Setting } = require('../models');

/**
 * OWASP-compliant cryptographic key resolution.
 * Uses dedicated TOKEN_ENCRYPTION_KEY if present, or derives a 256-bit key
 * from SESSION_SECRET with a cryptographic salt using scrypt.
 */
function getEncryptionKey() {
  const explicit = process.env.TOKEN_ENCRYPTION_KEY;
  if (explicit) {
    if (explicit.length === 64 && /^[0-9a-fA-F]+$/.test(explicit)) {
      return Buffer.from(explicit, 'hex');
    }
    return crypto.scryptSync(explicit, 'gst_oauth_token_key_salt_2026', 32);
  }
  const secret = process.env.SESSION_SECRET || 'gst-invoice-manager-token-key-salt-2026';
  return crypto.scryptSync(secret, 'gst_oauth_token_key_salt_2026', 32);
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
 * Decrypt tokens from AES-256-GCM authenticated payload.
 * Also handles legacy plaintext JSON gracefully for seamless migration.
 */
function decryptTokens(storedValue) {
  if (!storedValue || typeof storedValue !== 'string') return null;
  const trimmed = storedValue.trim();

  // Encrypted payload
  if (trimmed.startsWith('enc:v1:')) {
    const parts = trimmed.split(':');
    if (parts.length !== 5) {
      throw new Error('Invalid encrypted token payload structure');
    }
    const [, , ivHex, tagHex, dataHex] = parts;
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAAD(Buffer.from('gst_google_tokens', 'utf8'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(Buffer.from(dataHex, 'hex'), null, 'utf8');
    decrypted += decipher.final('utf8');
    try {
      return JSON.parse(decrypted);
    } catch (e) {
      return decrypted;
    }
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
  const encrypted = encryptTokens(tokens);
  await Setting.findOneAndUpdate(
    { key: 'google_tokens' },
    { $set: { value: encrypted } },
    { upsert: true, new: true }
  );
}

/**
 * Retrieve and decrypt Google OAuth tokens from MongoDB.
 */
async function getGoogleTokens() {
  const row = await Setting.findOne({ key: 'google_tokens' });
  if (!row || !row.value) return null;
  return decryptTokens(row.value);
}

/**
 * One-time startup migration: If google_tokens is stored in plaintext,
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
