/**
 * Gitnix SDK - Encryption Layer
 *
 * Zero-knowledge client-side encryption using:
 * - XChaCha20-Poly1305 (via tweetnacl secretbox)
 * - Per-record random nonces (24 bytes)
 * - Fixed-size padding to prevent size analysis
 *
 * Note: tweetnacl's secretbox uses XSalsa20-Poly1305 which provides
 * equivalent security guarantees (256-bit key, 192-bit nonce, AEAD).
 */

import nacl from 'tweetnacl';
import { decodeUTF8, encodeUTF8, encodeBase64, decodeBase64 } from 'tweetnacl-util';
import type { EncryptedBlob, EncryptionConfig } from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';

/** Current encryption format version */
const BLOB_VERSION = 1;

/** Key size in bytes (256-bit) */
const KEY_SIZE = 32;

/** Nonce size in bytes (192-bit for XSalsa20) */
const NONCE_SIZE = 24;

/** Auth tag size (Poly1305) */
const AUTH_TAG_SIZE = 16;

export class Encryption {
  private config: Required<EncryptionConfig>;

  constructor(config: EncryptionConfig = {}) {
    this.config = {
      argon2MemoryCost: config.argon2MemoryCost ?? 65536,
      argon2TimeCost: config.argon2TimeCost ?? 3,
      argon2Parallelism: config.argon2Parallelism ?? 1,
      enablePadding: config.enablePadding ?? true,
      paddingBlockSize: config.paddingBlockSize ?? 256,
    };
  }

  // ─── Core Encrypt/Decrypt ──────────────────────────────────────────────

  /**
   * Encrypt plaintext bytes with a key.
   * Output format: [version(1)] [nonce(24)] [ciphertext+tag(N+16)]
   */
  encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
    if (key.length !== KEY_SIZE) {
      throw new GitnixError(
        `Invalid key size: expected ${KEY_SIZE}, got ${key.length}`,
        GitnixErrorCode.ENCRYPTION_FAILED,
      );
    }

    // Apply padding if enabled
    const padded = this.config.enablePadding ? this.pad(plaintext) : plaintext;

    // Generate random nonce
    const nonce = nacl.randomBytes(NONCE_SIZE);

    // Encrypt with authenticated encryption (secretbox = XSalsa20-Poly1305)
    const ciphertext = nacl.secretbox(padded, nonce, key);

    // Assemble blob: [version][nonce][ciphertext]
    const blob = new Uint8Array(1 + NONCE_SIZE + ciphertext.length);
    blob[0] = BLOB_VERSION;
    blob.set(nonce, 1);
    blob.set(ciphertext, 1 + NONCE_SIZE);

    return blob;
  }

  /**
   * Decrypt an encrypted blob with a key.
   */
  decrypt(blob: Uint8Array, key: Uint8Array): Uint8Array {
    if (key.length !== KEY_SIZE) {
      throw new GitnixError(
        `Invalid key size: expected ${KEY_SIZE}, got ${key.length}`,
        GitnixErrorCode.DECRYPTION_FAILED,
      );
    }

    if (blob.length < 1 + NONCE_SIZE + AUTH_TAG_SIZE) {
      throw new GitnixError(
        'Encrypted blob too short',
        GitnixErrorCode.DECRYPTION_FAILED,
      );
    }

    const version = blob[0];
    if (version !== BLOB_VERSION) {
      throw new GitnixError(
        `Unsupported blob version: ${version}`,
        GitnixErrorCode.DECRYPTION_FAILED,
      );
    }

    const nonce = blob.slice(1, 1 + NONCE_SIZE);
    const ciphertext = blob.slice(1 + NONCE_SIZE);

    // Decrypt and verify authentication tag
    const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
    if (decrypted === null) {
      throw new GitnixError(
        'Decryption failed: invalid key or tampered data',
        GitnixErrorCode.DECRYPTION_FAILED,
      );
    }

    // Remove padding if enabled
    return this.config.enablePadding ? this.unpad(decrypted) : decrypted;
  }

  // ─── JSON Helpers ──────────────────────────────────────────────────────

  /**
   * Encrypt a JSON-serializable object
   */
  encryptJSON(data: unknown, key: Uint8Array): Uint8Array {
    const json = JSON.stringify(data);
    const bytes = decodeUTF8(json);
    return this.encrypt(bytes, key);
  }

  /**
   * Decrypt to a JSON object
   */
  decryptJSON<T = unknown>(blob: Uint8Array, key: Uint8Array): T {
    const decrypted = this.decrypt(blob, key);
    const json = encodeUTF8(decrypted);
    try {
      return JSON.parse(json) as T;
    } catch {
      throw new GitnixError(
        'Failed to parse decrypted data as JSON',
        GitnixErrorCode.DECRYPTION_FAILED,
      );
    }
  }

  // ─── Base64 Helpers (for GitHub API) ───────────────────────────────────

  /**
   * Encrypt and return as base64 (ready for GitHub blob API)
   */
  encryptToBase64(plaintext: Uint8Array, key: Uint8Array): string {
    const encrypted = this.encrypt(plaintext, key);
    return encodeBase64(encrypted);
  }

  /**
   * Decrypt from base64 string
   */
  decryptFromBase64(base64: string, key: Uint8Array): Uint8Array {
    const blob = decodeBase64(base64);
    return this.decrypt(blob, key);
  }

  /**
   * Encrypt JSON and return as base64
   */
  encryptJSONToBase64(data: unknown, key: Uint8Array): string {
    const encrypted = this.encryptJSON(data, key);
    return encodeBase64(encrypted);
  }

  /**
   * Decrypt base64 to JSON
   */
  decryptJSONFromBase64<T = unknown>(base64: string, key: Uint8Array): T {
    const blob = decodeBase64(base64);
    return this.decryptJSON<T>(blob, key);
  }

  // ─── Key Operations ────────────────────────────────────────────────────

  /**
   * Generate a random 256-bit key
   */
  generateKey(): Uint8Array {
    return nacl.randomBytes(KEY_SIZE);
  }

  /**
   * Encrypt a key with the master key (key wrapping)
   */
  wrapKey(key: Uint8Array, masterKey: Uint8Array): { encrypted: Uint8Array; nonce: Uint8Array } {
    const nonce = nacl.randomBytes(NONCE_SIZE);
    const encrypted = nacl.secretbox(key, nonce, masterKey);
    return { encrypted, nonce };
  }

  /**
   * Decrypt a wrapped key
   */
  unwrapKey(encryptedKey: Uint8Array, nonce: Uint8Array, masterKey: Uint8Array): Uint8Array {
    const key = nacl.secretbox.open(encryptedKey, nonce, masterKey);
    if (key === null) {
      throw new GitnixError(
        'Failed to unwrap key: invalid master key',
        GitnixErrorCode.INVALID_PASSWORD,
      );
    }
    return key;
  }

  /**
   * Create a verification hash to validate the master password
   * without storing the key itself
   */
  createVerificationHash(masterKey: Uint8Array): Uint8Array {
    // Hash a known constant with the key
    const constant = decodeUTF8('GITNIX_KEY_VERIFICATION_v1');
    const nonce = new Uint8Array(NONCE_SIZE); // Zero nonce is OK here (deterministic)
    return nacl.secretbox(constant, nonce, masterKey);
  }

  /**
   * Verify a master key against a stored verification hash
   */
  verifyMasterKey(masterKey: Uint8Array, verificationHash: Uint8Array): boolean {
    const constant = decodeUTF8('GITNIX_KEY_VERIFICATION_v1');
    const nonce = new Uint8Array(NONCE_SIZE);
    const result = nacl.secretbox.open(verificationHash, nonce, masterKey);
    return result !== null;
  }

  // ─── Hashing ───────────────────────────────────────────────────────────

  /**
   * SHA-256 hash for content addressing and filename obfuscation
   */
  hash(data: Uint8Array): Uint8Array {
    return nacl.hash(data).slice(0, 32); // nacl.hash is SHA-512, take first 32 bytes
  }

  /**
   * Hash a string (for filenames, collection names)
   */
  hashString(str: string): string {
    const bytes = decodeUTF8(str);
    const hashed = this.hash(bytes);
    return encodeBase64(hashed)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  // ─── Padding ───────────────────────────────────────────────────────────

  /**
   * PKCS7-style padding to fixed block size.
   * Hides the true size of records from traffic analysis.
   */
  private pad(data: Uint8Array): Uint8Array {
    const blockSize = this.config.paddingBlockSize;
    // Calculate padded size: next multiple of blockSize
    const paddedSize = Math.ceil((data.length + 4) / blockSize) * blockSize;
    const padded = new Uint8Array(paddedSize);

    // Store original length in first 4 bytes (big-endian uint32)
    const view = new DataView(padded.buffer);
    view.setUint32(0, data.length, false);

    // Copy data after length prefix
    padded.set(data, 4);

    // Fill remaining with random bytes (not zeros, to avoid patterns)
    const randomFill = nacl.randomBytes(paddedSize - 4 - data.length);
    padded.set(randomFill, 4 + data.length);

    return padded;
  }

  /**
   * Remove padding
   */
  private unpad(data: Uint8Array): Uint8Array {
    if (data.length < 4) {
      throw new GitnixError('Invalid padded data', GitnixErrorCode.DECRYPTION_FAILED);
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const originalLength = view.getUint32(0, false);

    if (originalLength > data.length - 4) {
      throw new GitnixError(
        'Invalid padding: claimed length exceeds data',
        GitnixErrorCode.DECRYPTION_FAILED,
      );
    }

    return data.slice(4, 4 + originalLength);
  }

  // ─── Config Access ─────────────────────────────────────────────────────

  getConfig(): Readonly<Required<EncryptionConfig>> {
    return { ...this.config };
  }
}
