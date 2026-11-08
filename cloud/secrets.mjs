// Encryption for users' own AI keys at rest: AES-256-GCM with a key derived from AI_KEY_SECRET. The user ID and
// provider are bound in as associated data, so a stored value cannot be moved to another account or provider.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const keyFrom = secret => createHash('sha256').update(`pixel-studio-ai-keys:${secret}`).digest();

export function sealSecret(secret, plaintext, context) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map(part => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

/** The plaintext, or null when the value was sealed with another secret or context (or is damaged). */
export function openSecret(secret, sealed, context) {
  try {
    const [version, iv, tag, data] = String(sealed).split('.');
    if (version !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

/** Shown instead of the key: provider prefix and last four characters. */
export const keyHint = key => `${key.slice(0, key.startsWith('sk-') ? 3 : 4)}…${key.slice(-4)}`;
