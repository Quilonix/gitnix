/**
 * Gitnix SDK - Key Derivation Function
 *
 * Uses Argon2id for deriving encryption keys from passwords.
 * Argon2id is the recommended KDF by OWASP for password hashing,
 * resistant to both side-channel and GPU attacks.
 *
 * Fallback: If argon2 is unavailable, uses PBKDF2 with high iterations
 * (less secure but works everywhere).
 */

import nacl from 'tweetnacl';
import { decodeUTF8 } from 'tweetnacl-util';
import type { DerivedKeys, EncryptionConfig } from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';

/** Salt size in bytes */
const SALT_SIZE = 32;

/** Derived key size in bytes */
const KEY_SIZE = 32;

/** PBKDF2 iterations (fallback) */
const PBKDF2_ITERATIONS = 600_000;

export interface KDFParams {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export class KeyDerivation {
  private params: KDFParams;
  private argon2Available: boolean | null = null;

  constructor(config: EncryptionConfig = {}) {
    this.params = {
      memoryCost: config.argon2MemoryCost ?? 65536,
      timeCost: config.argon2TimeCost ?? 3,
      parallelism: config.argon2Parallelism ?? 1,
    };
  }

  /**
   * Derive a master key from a password.
   * Generates a new salt if none provided.
   */
  async deriveKey(password: string, existingSalt?: Uint8Array): Promise<DerivedKeys> {
    const salt = existingSalt ?? nacl.randomBytes(SALT_SIZE);
    const passwordBytes = decodeUTF8(password);

    try {
      // Try Argon2id first
      const masterKey = await this.deriveArgon2(passwordBytes, salt);
      return { masterKey, salt };
    } catch {
      // Fallback to PBKDF2
      try {
        const masterKey = await this.derivePBKDF2(passwordBytes, salt);
        return { masterKey, salt };
      } catch (error) {
        throw new GitnixError(
          `Key derivation failed: ${error instanceof Error ? error.message : 'unknown'}`,
          GitnixErrorCode.KDF_FAILED,
        );
      }
    }
  }

  /**
   * Derive using Argon2id (preferred)
   */
  private async deriveArgon2(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    // Dynamic import for argon2-browser (may not be available in all environments)
    try {
      const argon2 = await import('argon2-browser');
      const result = await argon2.hash({
        pass: password,
        salt: salt,
        type: argon2.ArgonType.Argon2id,
        hashLen: KEY_SIZE,
        mem: this.params.memoryCost,
        time: this.params.timeCost,
        parallelism: this.params.parallelism,
      });
      this.argon2Available = true;
      return new Uint8Array(result.hash);
    } catch {
      this.argon2Available = false;
      throw new Error('Argon2 not available');
    }
  }

  /**
   * Derive using PBKDF2 (fallback for environments without argon2)
   * Uses Web Crypto API (available in Node 18+ and browsers)
   */
  private async derivePBKDF2(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    // Use Web Crypto API (available in Node.js 18+ and all modern browsers)
    if (typeof globalThis.crypto?.subtle === 'undefined') {
      // Final fallback: simple scrypt-like stretching using nacl
      return this.deriveNaclFallback(password, salt);
    }

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      password,
      'PBKDF2',
      false,
      ['deriveBits'],
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      KEY_SIZE * 8,
    );

    return new Uint8Array(derivedBits);
  }

  /**
   * Last-resort fallback using nacl hash iterations
   */
  private deriveNaclFallback(password: Uint8Array, salt: Uint8Array): Uint8Array {
    // Concatenate password + salt
    const combined = new Uint8Array(password.length + salt.length);
    combined.set(password);
    combined.set(salt, password.length);

    // Iterate hash 100,000 times for key stretching
    let hash = nacl.hash(combined);
    for (let i = 0; i < 100_000; i++) {
      hash = nacl.hash(hash);
    }

    return hash.slice(0, KEY_SIZE);
  }

  /**
   * Generate a new random salt
   */
  generateSalt(): Uint8Array {
    return nacl.randomBytes(SALT_SIZE);
  }

  /**
   * Check if Argon2 is available in this environment
   */
  async isArgon2Available(): Promise<boolean> {
    if (this.argon2Available !== null) return this.argon2Available;
    try {
      await import('argon2-browser');
      this.argon2Available = true;
    } catch {
      this.argon2Available = false;
    }
    return this.argon2Available;
  }

  /**
   * Get the KDF parameters
   */
  getParams(): Readonly<KDFParams> {
    return { ...this.params };
  }
}
