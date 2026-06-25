/**
 * Column-level encryption for sensitive at-rest fields (e.g. bank account
 * numbers stored in provider_bank_accounts.account_number_enc).
 *
 * AES-256-GCM, app-layer — the key never reaches Postgres, so a DB leak
 * alone does not expose plaintext. Ciphertext format (base64):
 *   iv(12) | authTag(16) | ciphertext
 *
 * Provision for production:
 *   COLUMN_ENCRYPTION_KEY=<64-hex-char (32-byte) key>
 *   Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Dev fallback: if the env key is missing in non-production, a fixed dev key
 * is used with a loud warning. In production a missing key throws — we never
 * silently store bank data with a default key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const DEV_KEY_HEX = '0'.repeat(64) // 32 zero-bytes — DEV ONLY, never production

function getKey(): Buffer {
  const hex = process.env['COLUMN_ENCRYPTION_KEY']
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, 'hex')
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'COLUMN_ENCRYPTION_KEY is missing or invalid (need 64 hex chars). Refusing to encrypt bank data with a default key in production.',
    )
  }
  console.warn(
    '⚠ COLUMN_ENCRYPTION_KEY not set — using INSECURE dev key. Provision before going live.',
  )
  return Buffer.from(DEV_KEY_HEX, 'hex')
}

export function encryptColumn(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
}

export function decryptColumn(encoded: string): string {
  const key = getKey()
  const raw = Buffer.from(encoded, 'base64')
  const iv = raw.subarray(0, 12)
  const authTag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Last 4 digits for display ("••••3456") without decrypting on read paths. */
export function maskAccountNumber(plaintext: string): string {
  return '••••' + plaintext.slice(-4)
}
