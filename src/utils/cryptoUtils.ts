import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

const CREDENTIAL_KEY_STORAGE = "credential_encryption_key";
const ALGO = "AES-GCM";
const IV_BYTES = 12;
const KEY_BITS = 256;

/** Prefix to identify encrypted values in DB (avoids double-encryption). */
const ENCRYPTED_PREFIX = "enc:";

let cachedKey: CryptoKey | null = null;

/**
 * Returns the AES-256-GCM key for credential encryption.
 * Creates and stores a new key in SecureStorage on first use.
 * Key is cached in memory for the session.
 */
async function getOrCreateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  try {
    const stored = await SecureStoragePlugin.get({ key: CREDENTIAL_KEY_STORAGE });
    const rawBytes = base64ToBytes(stored.value);
    cachedKey = await crypto.subtle.importKey("raw", rawBytes, ALGO, false, ["encrypt", "decrypt"]);
    return cachedKey;
  } catch {
    // Key doesn't exist — generate new one
    cachedKey = await crypto.subtle.generateKey(
      { name: ALGO, length: KEY_BITS },
      true,
      ["encrypt", "decrypt"]
    );
    const exported = await crypto.subtle.exportKey("raw", cachedKey);
    await SecureStoragePlugin.set({
      key: CREDENTIAL_KEY_STORAGE,
      value: bytesToBase64(new Uint8Array(exported)),
    });
    return cachedKey;
  }
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns a prefixed base64 string: "enc:<iv>:<ciphertext>"
 * Empty strings are returned as-is (nothing to protect).
 */
export async function encryptCredential(plaintext: string): Promise<string> {
  if (!plaintext) return "";
  if (plaintext.startsWith(ENCRYPTED_PREFIX)) return plaintext; // Already encrypted

  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);

  return ENCRYPTED_PREFIX + bytesToBase64(iv) + ":" + bytesToBase64(new Uint8Array(ciphertext));
}

/**
 * Decrypts an AES-256-GCM encrypted credential string.
 * If the value is not encrypted (no prefix), returns it as-is
 * for backwards compatibility with existing plaintext data.
 */
export async function decryptCredential(encrypted: string): Promise<string> {
  if (!encrypted) return "";
  if (!encrypted.startsWith(ENCRYPTED_PREFIX)) return encrypted; // Plaintext (legacy)

  const parts = encrypted.slice(ENCRYPTED_PREFIX.length).split(":");
  if (parts.length !== 2) return encrypted; // Malformed — return as-is

  const key = await getOrCreateKey();
  const iv = base64ToBytes(parts[0]);
  const ciphertext = base64ToBytes(parts[1]);

  const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

/** Returns true if the value is already encrypted. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
