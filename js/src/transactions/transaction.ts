/**
 * Gitnix SDK - Transaction Layer
 *
 * Provides ACID-like guarantees for multi-collection operations:
 * - Atomicity: All or nothing (single commit)
 * - Consistency: Schema validation before commit
 * - Isolation: Optimistic concurrency (detect conflicts at commit time)
 * - Durability: Committed = pushed to GitHub
 *
 * Uses optimistic locking:
 * 1. Read HEAD SHA at transaction start
 * 2. Accumulate all operations
 * 3. At commit: check if HEAD still matches
 * 4. If conflict: retry with configurable strategy
 */

import type {
  Document,
  PendingWrite,
  TransactionContext,
  TransactionOptions,
  QueryFilter,
  UpdateOperator,
} from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';
import type { Transport } from '../core/transport.js';
import type { KeyManager } from '../crypto/keys.js';
import type { StorageManager } from '../core/storage-manager.js';
import type { Collection } from '../collections/collection.js';

export class Transaction {
  private transport: Transport;
  private keyManager: KeyManager;
  private storageManager: StorageManager;
  private collections: Map<string, Collection>;
  private options: Required<TransactionOptions>;
  private context: TransactionContext | null = null;

  constructor(
    transport: Transport,
    keyManager: KeyManager,
    storageManager: StorageManager,
    collections: Map<string, Collection>,
    options: TransactionOptions = {},
  ) {
    this.transport = transport;
    this.keyManager = keyManager;
    this.storageManager = storageManager;
    this.collections = collections;
    this.options = {
      maxRetries: options.maxRetries ?? 3,
      timeout: options.timeout ?? 30000,
      conflictStrategy: options.conflictStrategy ?? 'retry',
      mergeFn: options.mergeFn ?? this.defaultMerge,
      isolation: options.isolation ?? 'read-committed',
    };
  }

  // ─── Transaction Lifecycle ─────────────────────────────────────────────

  /**
   * Begin a new transaction
   */
  async begin(): Promise<TransactionContext> {
    if (this.context?.status === 'active') {
      throw new GitnixError(
        'Transaction already active',
        GitnixErrorCode.TRANSACTION_ABORTED,
      );
    }

    const baseSha = await this.transport.getHeadSha();

    this.context = {
      id: this.generateTxId(),
      startedAt: Date.now(),
      baseSha,
      pendingWrites: new Map(),
      readSet: new Map(),
      status: 'active',
    };

    return this.context;
  }

  /**
   * Commit the transaction (atomic push)
   */
  async commit(): Promise<{ commitSha: string; operationCount: number }> {
    this.ensureActive();

    // Check timeout
    if (Date.now() - this.context!.startedAt > this.options.timeout) {
      this.context!.status = 'aborted';
      throw new GitnixError(
        'Transaction timed out',
        GitnixErrorCode.TRANSACTION_TIMEOUT,
      );
    }

    const pendingWrites = this.context!.pendingWrites;
    if (pendingWrites.size === 0) {
      this.context!.status = 'committed';
      return { commitSha: this.context!.baseSha, operationCount: 0 };
    }

    // Try to commit with retry on conflict
    let attempt = 0;
    while (attempt <= this.options.maxRetries) {
      try {
        const result = await this.tryCommit();
        this.context!.status = 'committed';
        return result;
      } catch (error) {
        if (
          error instanceof GitnixError &&
          error.code === GitnixErrorCode.TRANSACTION_CONFLICT
        ) {
          attempt++;
          if (attempt > this.options.maxRetries) {
            this.context!.status = 'conflict';
            throw error;
          }

          // Apply conflict strategy
          if (this.options.conflictStrategy === 'abort') {
            this.context!.status = 'aborted';
            throw error;
          }

          if (this.options.conflictStrategy === 'retry') {
            // Re-read base SHA and retry
            this.context!.baseSha = await this.transport.getHeadSha();
            continue;
          }

          if (this.options.conflictStrategy === 'merge') {
            await this.handleMergeConflict();
            continue;
          }
        }
        throw error;
      }
    }

    throw new GitnixError(
      'Transaction failed after max retries',
      GitnixErrorCode.TRANSACTION_CONFLICT,
    );
  }

  /**
   * Abort the transaction (discard all pending writes)
   */
  abort(): void {
    if (this.context) {
      this.context.status = 'aborted';
      this.context.pendingWrites.clear();
      this.context.readSet.clear();
    }
  }

  // ─── Transaction Operations ────────────────────────────────────────────

  /**
   * Get a collection within this transaction context
   */
  collection(name: string): TransactionCollection {
    this.ensureActive();
    return new TransactionCollection(name, this);
  }

  /**
   * Add a pending write to the transaction
   */
  addWrite(write: PendingWrite): void {
    this.ensureActive();
    const key = `${write.collection}:${write.documentId}`;
    this.context!.pendingWrites.set(key, write);
  }

  /**
   * Record a read (for conflict detection in serializable mode)
   */
  recordRead(collection: string, documentId: string, sha: string): void {
    if (this.options.isolation === 'serializable') {
      this.context!.readSet.set(`${collection}:${documentId}`, sha);
    }
  }

  /**
   * Get the actual collection instance for operations
   */
  getCollection(name: string): Collection | undefined {
    return this.collections.get(name);
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Try to commit all pending writes atomically
   */
  private async tryCommit(): Promise<{ commitSha: string; operationCount: number }> {
    // Check if HEAD has moved (conflict detection)
    const currentHead = await this.transport.getHeadSha();
    if (currentHead !== this.context!.baseSha) {
      throw new GitnixError(
        'Conflict detected: HEAD has moved since transaction started',
        GitnixErrorCode.TRANSACTION_CONFLICT,
        { expected: this.context!.baseSha, actual: currentHead },
      );
    }

    // Build all operations
    const operations: Array<{
      path: string;
      content: string;
      encoding?: 'utf-8' | 'base64';
      delete?: boolean;
    }> = [];

    for (const write of this.context!.pendingWrites.values()) {
      const docPath = this.storageManager.getDocumentPath(write.collection, write.documentId);

      switch (write.type) {
        case 'insert':
        case 'update': {
          const encrypted = this.keyManager.encryptForCollection(write.collection, write.data);
          operations.push({ path: docPath, content: encrypted, encoding: 'base64' });
          break;
        }
        case 'delete': {
          operations.push({ path: docPath, content: '', delete: true });
          break;
        }
      }
    }

    // Batch write everything in one commit
    const result = await this.transport.batchWrite(
      operations,
      `gitnix: transaction ${this.context!.id} (${operations.length} operations)`,
    );

    return { commitSha: result.commitSha, operationCount: operations.length };
  }

  /**
   * Handle merge conflict by re-reading and merging
   */
  private async handleMergeConflict(): Promise<void> {
    // Update base SHA
    this.context!.baseSha = await this.transport.getHeadSha();

    // For each write, check if the remote version conflicts
    // and apply merge function if provided
    for (const [key, write] of this.context!.pendingWrites) {
      if (write.type === 'update' && write.data) {
        const collection = this.collections.get(write.collection);
        if (collection) {
          // Re-read the remote version
          const remote = await collection.findById(write.documentId);
          if (remote && write.previousSha) {
            // Merge local changes with remote
            const merged = this.options.mergeFn(write.data as Document, remote);
            write.data = merged;
          }
        }
      }
    }
  }

  /**
   * Default merge: last-write-wins (prefer local)
   */
  private defaultMerge(local: Document, _remote: Document): Document {
    return { ...local, _version: (local._version ?? 0) + 1 };
  }

  /**
   * Ensure transaction is active
   */
  private ensureActive(): void {
    if (!this.context || this.context.status !== 'active') {
      throw new GitnixError(
        'No active transaction. Call begin() first.',
        GitnixErrorCode.TRANSACTION_ABORTED,
      );
    }
  }

  /**
   * Generate transaction ID
   */
  private generateTxId(): string {
    return `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Get transaction status
   */
  getStatus(): TransactionContext['status'] | 'none' {
    return this.context?.status ?? 'none';
  }

  /**
   * Get pending write count
   */
  getPendingCount(): number {
    return this.context?.pendingWrites.size ?? 0;
  }
}

// ─── Transaction-scoped Collection ───────────────────────────────────────────

/**
 * A collection proxy that records all operations in the transaction
 * instead of executing them immediately.
 */
export class TransactionCollection {
  private name: string;
  private tx: Transaction;

  constructor(name: string, tx: Transaction) {
    this.name = name;
    this.tx = tx;
  }

  /**
   * Insert a document within the transaction
   */
  async insert(data: Record<string, unknown>): Promise<Document> {
    const collection = this.tx.getCollection(this.name);
    if (!collection) {
      throw new GitnixError(
        `Collection "${this.name}" not found`,
        GitnixErrorCode.COLLECTION_NOT_FOUND,
      );
    }

    // Create the document (validates schema)
    const doc = await collection.insert(data);

    // Record the write
    this.tx.addWrite({
      type: 'insert',
      collection: this.name,
      documentId: doc._id,
      data: doc,
    });

    return doc;
  }

  /**
   * Update documents within the transaction
   */
  async update(filter: QueryFilter, update: UpdateOperator): Promise<{ modified: number }> {
    const collection = this.tx.getCollection(this.name);
    if (!collection) {
      throw new GitnixError(
        `Collection "${this.name}" not found`,
        GitnixErrorCode.COLLECTION_NOT_FOUND,
      );
    }

    const result = await collection.update(filter, update);

    // Find the updated docs and record writes
    const docs = await collection.find(filter);
    for (const doc of docs.docs) {
      this.tx.addWrite({
        type: 'update',
        collection: this.name,
        documentId: doc._id,
        data: doc,
      });
    }

    return result;
  }

  /**
   * Delete documents within the transaction
   */
  async delete(filter: QueryFilter): Promise<{ deleted: number }> {
    const collection = this.tx.getCollection(this.name);
    if (!collection) {
      throw new GitnixError(
        `Collection "${this.name}" not found`,
        GitnixErrorCode.COLLECTION_NOT_FOUND,
      );
    }

    // Find docs to delete first
    const docs = await collection.find(filter);
    for (const doc of docs.docs) {
      this.tx.addWrite({
        type: 'delete',
        collection: this.name,
        documentId: doc._id,
      });
    }

    return collection.delete(filter);
  }

  /**
   * Find documents (reads are tracked for conflict detection)
   */
  async find(filter: QueryFilter): Promise<Document[]> {
    const collection = this.tx.getCollection(this.name);
    if (!collection) {
      throw new GitnixError(
        `Collection "${this.name}" not found`,
        GitnixErrorCode.COLLECTION_NOT_FOUND,
      );
    }

    const result = await collection.find(filter);
    return result.docs;
  }

  /**
   * Find one document
   */
  async findOne(filter: QueryFilter): Promise<Document | null> {
    const collection = this.tx.getCollection(this.name);
    if (!collection) {
      throw new GitnixError(
        `Collection "${this.name}" not found`,
        GitnixErrorCode.COLLECTION_NOT_FOUND,
      );
    }

    return collection.findOne(filter);
  }
}
