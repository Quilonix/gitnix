/**
 * Gitnix SDK - Key Management
 *
 * Manages the key hierarchy:
 * - Master key (derived from password via Argon2id)
 * - Per-collection keys (wrapped/encrypted with master key)
 * - Key rotation and verification
 *
 * The key store is persisted as an encrypted blob in the repo.
 */

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import type { CollectionKey, DerivedKeys, KeyStore, EncryptionConfig } from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';
import { Encryption } from './encryption.js';
import { KeyDerivation } from './kdf.js';

/** KeyStore format version */
const KEYSTORE_VERSION = 1;

export class KeyManager {
  private encryption: Encryption;
  private kdf: KeyDerivation;
  private masterKey: Uint8Array | null = null;
  private salt: Uint8Array | null = null;
  private collectionKeys: Map<string, Uint8Array> = new Map();
  private keyStore: KeyStore | null = null;

  constructor(config: EncryptionConfig = {}) {
    this.encryption = new Encryption(config);
    this.kdf = new KeyDerivation(config);
  }

  // ─── Initialization ────────────────────────────────────────────────────

  /**
   * Initialize the key manager with a password.
   * If an existing key store is provided, unlocks it.
   * Otherwise, creates a new key store.
   */
  async initialize(password: string, existingKeyStoreBase64?: string): Promise<void> {
    if (existingKeyStoreBase64) {
      await this.unlock(password, existingKeyStoreBase64);
    } else {
      await this.createNew(password);
    }
  }

  /**
   * Create a fresh key store (first-time setup)
   */
  private async createNew(password: string): Promise<void> {
    const derived = await this.kdf.deriveKey(password);
    this.masterKey = derived.masterKey;
    this.salt = derived.salt;

    // Create verification hash
    const verificationHash = this.encryption.createVerificationHash(this.masterKey);

    this.keyStore = {
      version: KEYSTORE_VERSION,
      salt: derived.salt,
      kdfParams: this.kdf.getParams(),
      collections: {},
      verificationHash,
    };
  }

  /**
   * Unlock an existing key store with a password
   */
  private async unlock(password: string, keyStoreBase64: string): Promise<void> {
    // Deserialize the key store (it's stored as JSON with base64 fields)
    const raw = JSON.parse(
      Buffer.from(keyStoreBase64, 'base64').toString('utf-8'),
    ) as SerializedKeyStore;

    const salt = decodeBase64(raw.salt);

    // Derive master key with the stored salt
    const derived = await this.kdf.deriveKey(password, salt);
    this.masterKey = derived.masterKey;
    this.salt = salt;

    // Verify the password
    const verificationHash = decodeBase64(raw.verificationHash);
    if (!this.encryption.verifyMasterKey(this.masterKey, verificationHash)) {
      this.masterKey = null;
      this.salt = null;
      throw new GitnixError(
        'Invalid password: verification failed',
        GitnixErrorCode.INVALID_PASSWORD,
      );
    }

    // Rebuild key store
    this.keyStore = {
      version: raw.version,
      salt,
      kdfParams: raw.kdfParams,
      collections: {},
      verificationHash,
    };

    // Unwrap collection keys
    for (const [collectionId, serialized] of Object.entries(raw.collections)) {
      const encryptedKey = decodeBase64(serialized.encryptedKey);
      const nonce = decodeBase64(serialized.nonce);
      const collectionKey = this.encryption.unwrapKey(encryptedKey, nonce, this.masterKey);
      this.collectionKeys.set(collectionId, collectionKey);

      this.keyStore.collections[collectionId] = {
        collectionId,
        encryptedKey,
        nonce,
        createdAt: serialized.createdAt,
        version: serialized.version,
      };
    }
  }

  // ─── Collection Keys ───────────────────────────────────────────────────

  /**
   * Get or create a key for a collection
   */
  getCollectionKey(collectionId: string): Uint8Array {
    this.ensureUnlocked();

    const existing = this.collectionKeys.get(collectionId);
    if (existing) return existing;

    // Generate a new collection key
    const newKey = this.encryption.generateKey();
    this.setCollectionKey(collectionId, newKey);
    return newKey;
  }

  /**
   * Store a collection key (wrapped with master key)
   */
  private setCollectionKey(collectionId: string, key: Uint8Array): void {
    this.ensureUnlocked();

    const { encrypted, nonce } = this.encryption.wrapKey(key, this.masterKey!);
    this.collectionKeys.set(collectionId, key);

    this.keyStore!.collections[collectionId] = {
      collectionId,
      encryptedKey: encrypted,
      nonce,
      createdAt: Date.now(),
      version: 1,
    };
  }

  /**
   * Check if a collection key exists
   */
  hasCollectionKey(collectionId: string): boolean {
    return this.collectionKeys.has(collectionId);
  }

  /**
   * Remove a collection key
   */
  removeCollectionKey(collectionId: string): void {
    this.collectionKeys.delete(collectionId);
    if (this.keyStore) {
      delete this.keyStore.collections[collectionId];
    }
  }

  // ─── Key Rotation ──────────────────────────────────────────────────────

  /**
   * Rotate the master key (change password).
   * Re-wraps all collection keys with the new master key.
   */
  async rotatePassword(oldPassword: string, newPassword: string): Promise<void> {
    this.ensureUnlocked();

    // Verify old password
    const oldDerived = await this.kdf.deriveKey(oldPassword, this.salt!);
    if (!this.encryption.verifyMasterKey(oldDerived.masterKey, this.keyStore!.verificationHash)) {
      throw new GitnixError(
        'Old password verification failed',
        GitnixErrorCode.INVALID_PASSWORD,
      );
    }

    // Derive new master key (new salt)
    const newDerived = await this.kdf.deriveKey(newPassword);
    const newMasterKey = newDerived.masterKey;
    const newSalt = newDerived.salt;

    // Re-wrap all collection keys with new master key
    const newCollections: Record<string, CollectionKey> = {};
    for (const [collectionId, key] of this.collectionKeys) {
      const { encrypted, nonce } = this.encryption.wrapKey(key, newMasterKey);
      newCollections[collectionId] = {
        collectionId,
        encryptedKey: encrypted,
        nonce,
        createdAt: this.keyStore!.collections[collectionId]?.createdAt ?? Date.now(),
        version: (this.keyStore!.collections[collectionId]?.version ?? 0) + 1,
      };
    }

    // Update state
    this.masterKey = newMasterKey;
    this.salt = newSalt;
    this.keyStore = {
      version: KEYSTORE_VERSION,
      salt: newSalt,
      kdfParams: this.kdf.getParams(),
      collections: newCollections,
      verificationHash: this.encryption.createVerificationHash(newMasterKey),
    };
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  /**
   * Serialize the key store for persisting to the repo.
   * Returns a base64 string (safe for GitHub blob API).
   */
  serialize(): string {
    this.ensureUnlocked();

    const serialized: SerializedKeyStore = {
      version: this.keyStore!.version,
      salt: encodeBase64(this.keyStore!.salt),
      kdfParams: this.keyStore!.kdfParams,
      collections: {},
      verificationHash: encodeBase64(this.keyStore!.verificationHash),
    };

    for (const [id, ck] of Object.entries(this.keyStore!.collections)) {
      serialized.collections[id] = {
        encryptedKey: encodeBase64(ck.encryptedKey),
        nonce: encodeBase64(ck.nonce),
        createdAt: ck.createdAt,
        version: ck.version,
      };
    }

    const json = JSON.stringify(serialized);
    return Buffer.from(json, 'utf-8').toString('base64');
  }

  // ─── Encryption Proxy ──────────────────────────────────────────────────

  /**
   * Encrypt data for a specific collection
   */
  encryptForCollection(collectionId: string, data: unknown): string {
    const key = this.getCollectionKey(collectionId);
    return this.encryption.encryptJSONToBase64(data, key);
  }

  /**
   * Decrypt data from a specific collection
   */
  decryptForCollection<T = unknown>(collectionId: string, base64Data: string): T {
    const key = this.getCollectionKey(collectionId);
    return this.encryption.decryptJSONFromBase64<T>(base64Data, key);
  }

  /**
   * Encrypt raw bytes for a collection
   */
  encryptBytesForCollection(collectionId: string, data: Uint8Array): string {
    const key = this.getCollectionKey(collectionId);
    return this.encryption.encryptToBase64(data, key);
  }

  /**
   * Decrypt raw bytes for a collection
   */
  decryptBytesForCollection(collectionId: string, base64Data: string): Uint8Array {
    const key = this.getCollectionKey(collectionId);
    return this.encryption.decryptFromBase64(base64Data, key);
  }

  /**
   * Hash a collection name for filename obfuscation
   */
  hashCollectionName(name: string): string {
    return this.encryption.hashString(`collection:${name}`);
  }

  /**
   * Hash a document ID for filename obfuscation
   */
  hashDocumentId(collectionName: string, docId: string): string {
    return this.encryption.hashString(`doc:${collectionName}:${docId}`);
  }

  // ─── State ─────────────────────────────────────────────────────────────

  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  getCollectionIds(): string[] {
    return Array.from(this.collectionKeys.keys());
  }

  /**
   * Securely destroy all keys from memory
   */
  destroy(): void {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    for (const key of this.collectionKeys.values()) {
      key.fill(0);
    }
    this.collectionKeys.clear();
    this.keyStore = null;
    this.salt = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private ensureUnlocked(): void {
    if (!this.masterKey) {
      throw new GitnixError(
        'Key manager is locked. Call initialize() first.',
        GitnixErrorCode.KEY_NOT_FOUND,
      );
    }
  }
}

// ─── Serialization Types ─────────────────────────────────────────────────────

interface SerializedKeyStore {
  version: number;
  salt: string;
  kdfParams: { memoryCost: number; timeCost: number; parallelism: number };
  collections: Record<
    string,
    {
      encryptedKey: string;
      nonce: string;
      createdAt: number;
      version: number;
    }
  >;
  verificationHash: string;
}
