/**
 * Gitnix SDK - Collection Manager
 *
 * Full CRUD operations on encrypted document collections.
 * Each collection is a directory of encrypted blobs in the repo.
 *
 * Features:
 * - Insert / InsertMany (batch)
 * - Find / FindOne (with query engine)
 * - Update / UpdateMany
 * - Delete / DeleteMany
 * - Count
 * - Schema validation
 * - Auto-indexing
 * - UUIDv7 document IDs
 */

import type {
  CollectionOptions,
  Document,
  IndexDefinition,
  QueryFilter,
  QueryOptions,
  QueryResult,
  UpdateOperator,
} from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';
import type { Transport } from '../core/transport.js';
import type { Cache } from '../core/cache.js';
import type { StorageManager } from '../core/storage-manager.js';
import type { KeyManager } from '../crypto/keys.js';
import { QueryEngine } from '../query/engine.js';
import { IndexManager } from '../query/indexes.js';
import { SchemaValidator } from './schema.js';

export class Collection {
  readonly name: string;
  private transport: Transport;
  private cache: Cache;
  private storageManager: StorageManager;
  private keyManager: KeyManager;
  private queryEngine: QueryEngine;
  private indexManager: IndexManager;
  private schemaValidator: SchemaValidator | null;
  private options: CollectionOptions;

  /** In-memory document store (decrypted, cached) */
  private documents: Map<string, Document> = new Map();
  /** Track which documents are dirty (need sync) */
  private dirty: Set<string> = new Set();
  /** Whether we've loaded from remote */
  private loaded = false;

  constructor(
    options: CollectionOptions,
    transport: Transport,
    cache: Cache,
    storageManager: StorageManager,
    keyManager: KeyManager,
  ) {
    this.name = options.name;
    this.options = options;
    this.transport = transport;
    this.cache = cache;
    this.storageManager = storageManager;
    this.keyManager = keyManager;
    this.queryEngine = new QueryEngine();
    this.indexManager = new IndexManager();

    // Set up schema validator if schema provided
    this.schemaValidator = options.schema ? new SchemaValidator(options.schema) : null;

    // Create indexes
    if (options.indexes) {
      for (const indexDef of options.indexes) {
        this.indexManager.createIndex(indexDef);
      }
    }
  }

  // ─── Load/Sync ─────────────────────────────────────────────────────────

  /**
   * Load all documents from the remote repo
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    const collectionId = this.name;
    const repo = this.storageManager.getCollectionRepo(collectionId);
    const collPath = this.storageManager.getCollectionPath(collectionId);

    try {
      // Get all files in this collection's directory
      const files = await this.transport.listFiles(collPath, repo);

      // Load documents in parallel (skip index files)
      const docFiles = files.filter((f) => f.path.endsWith('.enc') && !f.path.includes('_index'));

      await Promise.all(
        docFiles.map(async (file) => {
          // Check cache first
          const cached = this.cache.getBySha<Document>(file.sha);
          if (cached) {
            this.documents.set(cached._id, cached);
            return;
          }

          // Fetch and decrypt
          const blob = await this.transport.getBlob(file.sha, repo);
          const doc = this.keyManager.decryptForCollection<Document>(collectionId, blob.content);
          this.documents.set(doc._id, doc);
          this.cache.set(`${collectionId}:${doc._id}`, doc, file.sha);
        }),
      );

      // Load indexes
      const indexFile = files.find((f) => f.path.includes('_index'));
      if (indexFile) {
        const blob = await this.transport.getBlob(indexFile.sha, repo);
        const indexData = this.keyManager.decryptForCollection(collectionId, blob.content);
        this.indexManager.deserialize(indexData as any);
      } else {
        // Rebuild indexes from documents
        this.indexManager.rebuildAll(Array.from(this.documents.values()));
      }

      this.loaded = true;
    } catch (error) {
      if (error instanceof GitnixError && error.code === GitnixErrorCode.REPO_NOT_FOUND) {
        // Collection doesn't exist yet — that's fine
        this.loaded = true;
      } else {
        throw error;
      }
    }
  }

  /**
   * Sync all dirty documents to the remote repo
   */
  async sync(): Promise<{ written: number; deleted: number }> {
    if (this.dirty.size === 0) return { written: 0, deleted: 0 };

    const collectionId = this.name;
    const allocation = await this.storageManager.getAllocation(
      collectionId,
      this.estimateCollectionSize(),
    );

    const operations: Array<{
      path: string;
      content: string;
      encoding?: 'utf-8' | 'base64';
      delete?: boolean;
    }> = [];

    let written = 0;
    let deleted = 0;

    for (const docId of this.dirty) {
      const doc = this.documents.get(docId);
      const docPath = this.storageManager.getDocumentPath(collectionId, docId);

      if (doc) {
        // Encrypt and prepare for write
        const encrypted = this.keyManager.encryptForCollection(collectionId, doc);
        operations.push({ path: docPath, content: encrypted, encoding: 'base64' });
        written++;
      } else {
        // Document was deleted
        operations.push({ path: docPath, content: '', delete: true });
        deleted++;
      }
    }

    // Also save updated indexes
    const indexPath = this.storageManager.getIndexPath(collectionId);
    const indexData = this.indexManager.serialize();
    const encryptedIndex = this.keyManager.encryptForCollection(collectionId, indexData);
    operations.push({ path: indexPath, content: encryptedIndex, encoding: 'base64' });

    // Batch write all operations as a single commit
    if (operations.length > 0) {
      await this.transport.batchWrite(
        operations,
        `gitnix: sync ${this.name} (${written} written, ${deleted} deleted)`,
        allocation.repo,
      );
    }

    // Update storage usage
    const totalSize = operations.reduce((sum, op) => sum + (op.content?.length ?? 0), 0);
    this.storageManager.updateUsage(allocation.repo, totalSize);

    this.dirty.clear();
    return { written, deleted };
  }

  // ─── Insert ────────────────────────────────────────────────────────────

  /**
   * Insert a single document
   */
  async insert(data: Record<string, unknown>): Promise<Document> {
    await this.ensureLoaded();

    const doc = this.createDocument(data);

    // Validate schema
    if (this.schemaValidator) {
      this.schemaValidator.validate(doc);
    }

    // Check for duplicate ID
    if (this.documents.has(doc._id)) {
      throw new GitnixError(
        `Document with ID ${doc._id} already exists`,
        GitnixErrorCode.DUPLICATE_ID,
        { id: doc._id },
      );
    }

    // Index the document
    this.indexManager.indexDocument(doc);

    // Store in memory
    this.documents.set(doc._id, doc);
    this.dirty.add(doc._id);

    return doc;
  }

  /**
   * Insert multiple documents in batch
   */
  async insertMany(items: Record<string, unknown>[]): Promise<Document[]> {
    await this.ensureLoaded();

    const docs: Document[] = [];

    for (const data of items) {
      const doc = this.createDocument(data);

      if (this.schemaValidator) {
        this.schemaValidator.validate(doc);
      }

      if (this.documents.has(doc._id)) {
        throw new GitnixError(
          `Document with ID ${doc._id} already exists`,
          GitnixErrorCode.DUPLICATE_ID,
          { id: doc._id },
        );
      }

      this.indexManager.indexDocument(doc);
      this.documents.set(doc._id, doc);
      this.dirty.add(doc._id);
      docs.push(doc);
    }

    return docs;
  }

  // ─── Find ──────────────────────────────────────────────────────────────

  /**
   * Find documents matching a query
   */
  async find(filter: QueryFilter = {}, options: QueryOptions = {}): Promise<QueryResult> {
    await this.ensureLoaded();

    const allDocs = Array.from(this.documents.values());

    // Try index optimization
    const indexedIds = this.indexManager.resolveQuery(filter);
    let docsToSearch: Document[];

    if (indexedIds !== null) {
      // Use index - only check indexed documents
      docsToSearch = [];
      for (const id of indexedIds) {
        const doc = this.documents.get(id);
        if (doc) docsToSearch.push(doc);
      }
    } else {
      docsToSearch = allDocs;
    }

    return this.queryEngine.execute(docsToSearch, filter, options);
  }

  /**
   * Find a single document
   */
  async findOne(filter: QueryFilter): Promise<Document | null> {
    const result = await this.find(filter, { limit: 1 });
    return result.docs[0] ?? null;
  }

  /**
   * Find a document by ID
   */
  async findById(id: string): Promise<Document | null> {
    await this.ensureLoaded();
    return this.documents.get(id) ?? null;
  }

  /**
   * Count documents matching a filter
   */
  async count(filter: QueryFilter = {}): Promise<number> {
    const result = await this.find(filter, { count: true });
    return result.total ?? 0;
  }

  // ─── Update ────────────────────────────────────────────────────────────

  /**
   * Update documents matching a filter
   */
  async update(filter: QueryFilter, update: UpdateOperator): Promise<{ modified: number }> {
    await this.ensureLoaded();

    const result = await this.find(filter);
    let modified = 0;

    for (const doc of result.docs) {
      const updated = this.queryEngine.applyUpdate(doc, update);
      updated._updated = new Date().toISOString();
      updated._version = (doc._version ?? 0) + 1;

      // Validate schema
      if (this.schemaValidator) {
        this.schemaValidator.validate(updated);
      }

      // Update index
      this.indexManager.updateDocument(doc, updated);

      // Store
      this.documents.set(doc._id, updated);
      this.dirty.add(doc._id);
      modified++;
    }

    return { modified };
  }

  /**
   * Update a single document by ID
   */
  async updateById(id: string, update: UpdateOperator): Promise<Document | null> {
    await this.ensureLoaded();

    const doc = this.documents.get(id);
    if (!doc) return null;

    const updated = this.queryEngine.applyUpdate(doc, update);
    updated._updated = new Date().toISOString();
    updated._version = (doc._version ?? 0) + 1;

    if (this.schemaValidator) {
      this.schemaValidator.validate(updated);
    }

    this.indexManager.updateDocument(doc, updated);
    this.documents.set(id, updated);
    this.dirty.add(id);

    return updated;
  }

  /**
   * Replace a document entirely
   */
  async replace(filter: QueryFilter, data: Record<string, unknown>): Promise<Document | null> {
    await this.ensureLoaded();

    const existing = await this.findOne(filter);
    if (!existing) return null;

    const replaced: Document = {
      ...data,
      _id: existing._id,
      _created: existing._created,
      _updated: new Date().toISOString(),
      _version: (existing._version ?? 0) + 1,
    };

    if (this.schemaValidator) {
      this.schemaValidator.validate(replaced);
    }

    this.indexManager.updateDocument(existing, replaced);
    this.documents.set(existing._id, replaced);
    this.dirty.add(existing._id);

    return replaced;
  }

  // ─── Delete ────────────────────────────────────────────────────────────

  /**
   * Delete documents matching a filter
   */
  async delete(filter: QueryFilter): Promise<{ deleted: number }> {
    await this.ensureLoaded();

    const result = await this.find(filter);
    let deleted = 0;

    for (const doc of result.docs) {
      this.indexManager.removeDocument(doc);
      this.documents.delete(doc._id);
      this.dirty.add(doc._id); // Mark as dirty so sync knows to delete
      deleted++;
    }

    return { deleted };
  }

  /**
   * Delete a document by ID
   */
  async deleteById(id: string): Promise<boolean> {
    await this.ensureLoaded();

    const doc = this.documents.get(id);
    if (!doc) return false;

    this.indexManager.removeDocument(doc);
    this.documents.delete(id);
    this.dirty.add(id);

    return true;
  }

  /**
   * Delete all documents in the collection
   */
  async deleteAll(): Promise<{ deleted: number }> {
    await this.ensureLoaded();
    const count = this.documents.size;

    for (const doc of this.documents.values()) {
      this.indexManager.removeDocument(doc);
      this.dirty.add(doc._id);
    }
    this.documents.clear();

    return { deleted: count };
  }

  // ─── Index Management ──────────────────────────────────────────────────

  /**
   * Create an index on this collection
   */
  createIndex(definition: IndexDefinition): void {
    this.indexManager.createIndex(definition);
    // Rebuild from existing documents
    this.indexManager.rebuildAll(Array.from(this.documents.values()));
  }

  /**
   * Drop an index
   */
  dropIndex(name: string): boolean {
    return this.indexManager.dropIndex(name);
  }

  /**
   * List all indexes
   */
  listIndexes(): Array<{ name: string; fields: string[]; unique: boolean }> {
    return this.indexManager.getIndexes().map((idx) => ({
      name: idx.name,
      fields: idx.fields,
      unique: idx.unique,
    }));
  }

  // ─── Utilities ─────────────────────────────────────────────────────────

  /**
   * Get collection stats
   */
  getStats(): {
    name: string;
    documentCount: number;
    dirtyCount: number;
    indexCount: number;
    loaded: boolean;
  } {
    return {
      name: this.name,
      documentCount: this.documents.size,
      dirtyCount: this.dirty.size,
      indexCount: this.indexManager.getIndexes().length,
      loaded: this.loaded,
    };
  }

  /**
   * Check if collection has unsaved changes
   */
  isDirty(): boolean {
    return this.dirty.size > 0;
  }

  /**
   * Drop the entire collection (removes all data)
   */
  async drop(): Promise<void> {
    await this.deleteAll();
    await this.sync();
    this.indexManager.clear();
    this.loaded = false;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Create a new document with system fields
   */
  private createDocument(data: Record<string, unknown>): Document {
    const now = new Date().toISOString();
    const id = (data._id as string) ?? this.generateId();

    return {
      ...data,
      _id: id,
      _created: now,
      _updated: now,
      _version: 1,
    };
  }

  /**
   * Generate a UUIDv7-like ID (time-sortable)
   */
  private generateId(): string {
    if (this.options.idGenerator) {
      return this.options.idGenerator();
    }

    // UUIDv7: timestamp-based, sortable
    const timestamp = Date.now();
    const hex = timestamp.toString(16).padStart(12, '0');
    const random = Array.from(crypto.getRandomValues(new Uint8Array(10)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${random.slice(0, 3)}-${random.slice(3, 7)}-${random.slice(7, 19)}`;
  }

  /**
   * Ensure the collection is loaded
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  /**
   * Estimate collection size in bytes
   */
  private estimateCollectionSize(): number {
    let size = 0;
    for (const doc of this.documents.values()) {
      size += JSON.stringify(doc).length * 2; // Rough estimate with encryption overhead
    }
    return size;
  }
}
