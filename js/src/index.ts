/**
 * Gitnix SDK - Main Entry Point
 *
 * The `Gitnix` class is the primary interface for using GitHub repos as a database.
 * It orchestrates all layers: transport, encryption, caching, storage, collections,
 * queries, binary storage, and transactions.
 *
 * Usage:
 * ```typescript
 * const db = new Gitnix({
 *   repo: 'owner/my-database',
 *   token: process.env.GITHUB_TOKEN!,
 *   password: 'my-master-password',
 * });
 *
 * await db.connect();
 * const users = db.collection('users');
 * await users.insert({ name: 'Alice', age: 30 });
 * const alice = await users.findOne({ name: 'Alice' });
 * await db.sync();
 * await db.disconnect();
 * ```
 */

import type {
  GitnixConfig,
  GitnixEvent,
  EventListener,
  CollectionOptions,
  TransactionOptions,
  Document,
  CacheStats,
} from './types/index.js';
import { GitnixError, GitnixErrorCode } from './types/index.js';
import { Transport } from './core/transport.js';
import { RateLimiter } from './core/rate-limiter.js';
import { Cache } from './core/cache.js';
import { StorageManager } from './core/storage-manager.js';
import { KeyManager } from './crypto/keys.js';
import { Collection } from './collections/collection.js';
import { Transaction } from './transactions/transaction.js';
import { BinaryStorage } from './binary/storage.js';

export class Gitnix {
  private config: GitnixConfig;
  private transport!: Transport;
  private rateLimiter!: RateLimiter;
  private cache!: Cache;
  private storageManager!: StorageManager;
  private keyManager!: KeyManager;
  private binaryStorage!: BinaryStorage;

  private collections: Map<string, Collection> = new Map();
  private connected = false;
  private listeners: EventListener[] = [];

  constructor(config: GitnixConfig) {
    this.validateConfig(config);
    this.config = config;
  }

  // ─── Connection Lifecycle ──────────────────────────────────────────────

  /**
   * Connect to the GitHub repo database.
   * Initializes all layers, derives encryption keys, loads manifest.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      throw new GitnixError('Already connected', GitnixErrorCode.ALREADY_CONNECTED);
    }

    try {
      // 1. Initialize rate limiter
      this.rateLimiter = new RateLimiter(this.config.rateLimiter);

      // 2. Initialize transport
      this.transport = new Transport({
        token: this.config.token,
        repo: this.config.repo,
        branch: this.config.branch ?? 'main',
        apiBaseUrl: this.config.apiBaseUrl ?? 'https://api.github.com',
        rateLimiter: this.rateLimiter,
      });

      // 3. Check repo exists
      const exists = await this.transport.repoExists();
      if (!exists && this.config.autoCreate) {
        const [, repoName] = this.config.repo.split('/');
        await this.transport.createRepo(repoName!, true);
      } else if (!exists) {
        throw new GitnixError(
          `Repository ${this.config.repo} not found. Set autoCreate: true to create it.`,
          GitnixErrorCode.REPO_NOT_FOUND,
        );
      }

      // 4. Initialize cache
      this.cache = new Cache(this.config.cache);

      // 5. Initialize key manager and derive keys
      this.keyManager = new KeyManager(this.config.encryption);

      // Try to load existing keystore from repo
      const keyStoreData = await this.loadKeyStore();
      await this.keyManager.initialize(this.config.password, keyStoreData ?? undefined);

      // If new, save the keystore
      if (!keyStoreData) {
        await this.saveKeyStore();
      }

      // 6. Initialize storage manager
      this.storageManager = new StorageManager(
        this.transport,
        this.keyManager,
        this.cache,
        this.config.repo,
        this.config.overflowRepos,
      );
      await this.storageManager.initialize();

      // 7. Initialize binary storage
      this.binaryStorage = new BinaryStorage(
        this.transport,
        this.cache,
        this.storageManager,
        this.keyManager,
      );

      this.connected = true;
      this.emit({ type: 'connected', repo: this.config.repo });
    } catch (error) {
      // Clean up on failure
      this.rateLimiter?.destroy();
      this.cache?.destroy();
      this.keyManager?.destroy();
      throw error;
    }
  }

  /**
   * Disconnect and cleanup resources
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    // Sync any dirty collections
    await this.sync();

    // Cleanup
    this.rateLimiter.destroy();
    this.cache.destroy();
    this.keyManager.destroy();
    this.collections.clear();
    this.connected = false;

    this.emit({ type: 'disconnected' });
  }

  // ─── Collections ───────────────────────────────────────────────────────

  /**
   * Get or create a collection
   */
  collection(name: string, options?: Partial<CollectionOptions>): Collection {
    this.ensureConnected();

    if (this.collections.has(name)) {
      return this.collections.get(name)!;
    }

    const collection = new Collection(
      { name, ...options },
      this.transport,
      this.cache,
      this.storageManager,
      this.keyManager,
    );

    this.collections.set(name, collection);
    return collection;
  }

  /**
   * Drop a collection (permanently delete)
   */
  async dropCollection(name: string): Promise<void> {
    this.ensureConnected();

    const collection = this.collections.get(name);
    if (collection) {
      await collection.drop();
      this.collections.delete(name);
    }

    this.keyManager.removeCollectionKey(name);
    await this.saveKeyStore();
  }

  /**
   * List all collections
   */
  listCollections(): string[] {
    return Array.from(this.collections.keys());
  }

  // ─── Binary Storage ────────────────────────────────────────────────────

  /**
   * Get the binary storage interface for files/images
   */
  get binary(): BinaryStorage {
    this.ensureConnected();
    return this.binaryStorage;
  }

  // ─── Transactions ──────────────────────────────────────────────────────

  /**
   * Execute a function within a transaction.
   * All operations are batched and committed atomically.
   */
  async transaction<T>(
    fn: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    this.ensureConnected();

    const tx = new Transaction(
      this.transport,
      this.keyManager,
      this.storageManager,
      this.collections,
      options,
    );

    await tx.begin();

    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (error) {
      tx.abort();
      throw error;
    }
  }

  // ─── Sync ──────────────────────────────────────────────────────────────

  /**
   * Sync all dirty collections to GitHub
   */
  async sync(): Promise<{ collections: number; written: number; deleted: number }> {
    this.ensureConnected();

    let totalWritten = 0;
    let totalDeleted = 0;
    let syncedCollections = 0;

    const dirtyCollections = Array.from(this.collections.values()).filter((c) => c.isDirty());

    if (dirtyCollections.length === 0) {
      return { collections: 0, written: 0, deleted: 0 };
    }

    this.emit({ type: 'sync:start', collections: dirtyCollections.map((c) => c.name) });
    const startTime = Date.now();

    for (const collection of dirtyCollections) {
      const result = await collection.sync();
      totalWritten += result.written;
      totalDeleted += result.deleted;
      syncedCollections++;
    }

    // Save updated keystore if any new collections were created
    await this.saveKeyStore();

    this.emit({ type: 'sync:complete', duration: Date.now() - startTime });

    return { collections: syncedCollections, written: totalWritten, deleted: totalDeleted };
  }

  // ─── Status & Info ─────────────────────────────────────────────────────

  /**
   * Get database status
   */
  getStatus(): {
    connected: boolean;
    repo: string;
    collections: number;
    cacheStats: CacheStats;
    rateLimitState: { remaining: number; limit: number; used: number };
    storage: { totalUsed: number; totalAvailable: number; repoCount: number };
  } {
    if (!this.connected) {
      return {
        connected: false,
        repo: this.config.repo,
        collections: 0,
        cacheStats: { size: 0, hits: 0, misses: 0, hitRatio: 0, memoryUsage: 0, evictions: 0 },
        rateLimitState: { remaining: 5000, limit: 5000, used: 0 },
        storage: { totalUsed: 0, totalAvailable: 0, repoCount: 0 },
      };
    }

    const storageInfo = this.storageManager.getStorageInfo();
    const rlState = this.rateLimiter.getState();

    return {
      connected: true,
      repo: this.config.repo,
      collections: this.collections.size,
      cacheStats: this.cache.getStats(),
      rateLimitState: {
        remaining: rlState.remaining,
        limit: rlState.limit,
        used: rlState.used,
      },
      storage: {
        totalUsed: storageInfo.totalUsed,
        totalAvailable: storageInfo.totalAvailable,
        repoCount: storageInfo.repos.length,
      },
    };
  }

  /**
   * Change the master password (re-encrypts all keys)
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    this.ensureConnected();
    await this.keyManager.rotatePassword(oldPassword, newPassword);
    await this.saveKeyStore();
  }

  // ─── Events ────────────────────────────────────────────────────────────

  /**
   * Subscribe to events
   */
  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: GitnixEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors propagate
      }
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Load keystore from repo
   */
  private async loadKeyStore(): Promise<string | null> {
    try {
      const files = await this.transport.listFiles('.gitnix');
      const keyStoreFile = files.find((f) => f.path === '.gitnix/keystore.dat');
      if (!keyStoreFile) return null;

      const blob = await this.transport.getBlob(keyStoreFile.sha);
      return blob.content;
    } catch {
      return null;
    }
  }

  /**
   * Save keystore to repo
   */
  private async saveKeyStore(): Promise<void> {
    const serialized = this.keyManager.serialize();
    await this.transport.batchWrite(
      [{ path: '.gitnix/keystore.dat', content: serialized, encoding: 'base64' }],
      'gitnix: update keystore',
    );
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: GitnixConfig): void {
    if (!config.repo || !config.repo.includes('/')) {
      throw new GitnixError(
        'Invalid repo format. Must be "owner/repo".',
        GitnixErrorCode.INVALID_CONFIG,
      );
    }
    if (!config.token) {
      throw new GitnixError(
        'GitHub token is required.',
        GitnixErrorCode.INVALID_CONFIG,
      );
    }
    if (!config.password) {
      throw new GitnixError(
        'Encryption password is required.',
        GitnixErrorCode.INVALID_CONFIG,
      );
    }
  }

  /**
   * Ensure we're connected
   */
  private ensureConnected(): void {
    if (!this.connected) {
      throw new GitnixError(
        'Not connected. Call connect() first.',
        GitnixErrorCode.NOT_CONNECTED,
      );
    }
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { Collection } from './collections/collection.js';
export { QueryEngine } from './query/engine.js';
export { BinaryStorage } from './binary/storage.js';
export { Transaction } from './transactions/transaction.js';
export { Cache } from './core/cache.js';
export { Transport } from './core/transport.js';
export { RateLimiter } from './core/rate-limiter.js';
export { StorageManager } from './core/storage-manager.js';
export { KeyManager } from './crypto/keys.js';
export { Encryption } from './crypto/encryption.js';
export { KeyDerivation } from './crypto/kdf.js';
export { Chunker } from './binary/chunker.js';
export { ConflictResolver } from './transactions/conflict.js';
export { SchemaValidator } from './collections/schema.js';
export { IndexManager } from './query/indexes.js';

// Query operator helpers
export {
  $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin,
  $and, $or, $not,
  $contains, $startsWith, $endsWith, $regex,
  $size, $elemMatch, $exists, $type, $between,
  query, QueryBuilder,
} from './query/operators.js';

// Types
export type {
  GitnixConfig,
  GitnixEvent,
  EventListener,
  Document,
  CollectionOptions,
  SchemaDefinition,
  FieldDefinition,
  IndexDefinition,
  QueryFilter,
  QueryOperator,
  QueryOptions,
  QueryResult,
  UpdateOperator,
  TransactionOptions,
  BinaryMetadata,
  UploadOptions,
  UploadProgress,
  DownloadOptions,
  DownloadProgress,
  CacheConfig,
  CacheStats,
  RateLimiterConfig,
  EncryptionConfig,
  MultiRepoManifest,
  RepoInfo,
  StorageAllocation,
} from './types/index.js';

export { GitnixError, GitnixErrorCode } from './types/index.js';
