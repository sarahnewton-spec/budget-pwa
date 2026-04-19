const crypto = require('crypto');
const ALG = 'aes-256-gcm';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv:tag:ciphertext all as hex, joined
  return [iv, tag, enc].map(b => b.toString('hex')).join(':');
}

function decrypt(payload) {
  const [ivHex, tagHex, encHex] = payload.split(':');
  const decipher = crypto.createDecipheriv(ALG, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };
