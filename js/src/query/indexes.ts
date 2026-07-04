/**
 * Gitnix SDK - Index Manager
 *
 * Manages encrypted indexes for query optimization.
 * Instead of decrypting every record for a query,
 * we maintain field-value → document-ID mappings.
 *
 * Indexes are stored as encrypted blobs alongside collection data.
 */

import type { Document, IndexData, IndexDefinition, QueryFilter } from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';

export class IndexManager {
  private indexes: Map<string, IndexData> = new Map();

  // ─── Index CRUD ────────────────────────────────────────────────────────

  /**
   * Create a new index
   */
  createIndex(definition: IndexDefinition): IndexData {
    const name = definition.name ?? definition.fields.join('_');

    if (this.indexes.has(name)) {
      return this.indexes.get(name)!;
    }

    const index: IndexData = {
      name,
      entries: new Map(),
      fields: definition.fields,
      unique: definition.unique ?? false,
      sparse: definition.sparse ?? false,
    };

    this.indexes.set(name, index);
    return index;
  }

  /**
   * Drop an index
   */
  dropIndex(name: string): boolean {
    return this.indexes.delete(name);
  }

  /**
   * Get all index definitions
   */
  getIndexes(): IndexData[] {
    return Array.from(this.indexes.values());
  }

  // ─── Index Operations ──────────────────────────────────────────────────

  /**
   * Add a document to all relevant indexes
   */
  indexDocument(doc: Document): void {
    for (const index of this.indexes.values()) {
      const key = this.buildIndexKey(doc, index.fields);
      if (key === null) {
        if (index.sparse) continue; // Skip null values for sparse indexes
      }

      const keyStr = key ?? '__null__';

      // Check uniqueness
      if (index.unique) {
        const existing = index.entries.get(keyStr);
        if (existing && existing.size > 0 && !existing.has(doc._id)) {
          throw new GitnixError(
            `Duplicate key for unique index "${index.name}": ${keyStr}`,
            GitnixErrorCode.DUPLICATE_ID,
            { index: index.name, key: keyStr, existingId: Array.from(existing)[0] },
          );
        }
      }

      if (!index.entries.has(keyStr)) {
        index.entries.set(keyStr, new Set());
      }
      index.entries.get(keyStr)!.add(doc._id);
    }
  }

  /**
   * Remove a document from all indexes
   */
  removeDocument(doc: Document): void {
    for (const index of this.indexes.values()) {
      const key = this.buildIndexKey(doc, index.fields);
      const keyStr = key ?? '__null__';

      const set = index.entries.get(keyStr);
      if (set) {
        set.delete(doc._id);
        if (set.size === 0) {
          index.entries.delete(keyStr);
        }
      }
    }
  }

  /**
   * Update a document in indexes (remove old, add new)
   */
  updateDocument(oldDoc: Document, newDoc: Document): void {
    this.removeDocument(oldDoc);
    this.indexDocument(newDoc);
  }

  // ─── Query Optimization ────────────────────────────────────────────────

  /**
   * Try to resolve a query using indexes.
   * Returns document IDs if an index can be used, null otherwise.
   */
  resolveQuery(filter: QueryFilter): Set<string> | null {
    // Try each index to see if it can resolve the query
    for (const index of this.indexes.values()) {
      const result = this.tryResolveWithIndex(filter, index);
      if (result !== null) {
        return result;
      }
    }
    return null; // No index can help, full scan needed
  }

  /**
   * Try to resolve a query using a specific index
   */
  private tryResolveWithIndex(filter: QueryFilter, index: IndexData): Set<string> | null {
    // Only single-field indexes can be used for simple lookups
    if (index.fields.length !== 1) return null;

    const field = index.fields[0]!;
    const condition = filter[field];

    if (condition === undefined) return null;

    // Direct equality: field = value
    if (condition === null || typeof condition !== 'object') {
      const key = String(condition);
      return index.entries.get(key) ?? new Set();
    }

    // $eq operator
    if (typeof condition === 'object' && '$eq' in condition) {
      const key = String((condition as { $eq: unknown }).$eq);
      return index.entries.get(key) ?? new Set();
    }

    // $in operator: union of multiple lookups
    if (typeof condition === 'object' && '$in' in condition) {
      const values = (condition as { $in: unknown[] }).$in;
      const result = new Set<string>();
      for (const val of values) {
        const key = String(val);
        const ids = index.entries.get(key);
        if (ids) {
          for (const id of ids) result.add(id);
        }
      }
      return result;
    }

    return null; // Can't use this index for this query
  }

  /**
   * Get all document IDs tracked by indexes
   */
  getAllDocumentIds(): Set<string> {
    const ids = new Set<string>();
    for (const index of this.indexes.values()) {
      for (const set of index.entries.values()) {
        for (const id of set) ids.add(id);
      }
    }
    return ids;
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  /**
   * Serialize all indexes to a JSON-compatible format
   */
  serialize(): SerializedIndexes {
    const result: SerializedIndexes = {};
    for (const [name, index] of this.indexes) {
      const entries: Record<string, string[]> = {};
      for (const [key, ids] of index.entries) {
        entries[key] = Array.from(ids);
      }
      result[name] = {
        fields: index.fields,
        unique: index.unique,
        sparse: index.sparse,
        entries,
      };
    }
    return result;
  }

  /**
   * Deserialize indexes from stored format
   */
  deserialize(data: SerializedIndexes): void {
    this.indexes.clear();
    for (const [name, serialized] of Object.entries(data)) {
      const entries = new Map<string, Set<string>>();
      for (const [key, ids] of Object.entries(serialized.entries)) {
        entries.set(key, new Set(ids));
      }
      this.indexes.set(name, {
        name,
        fields: serialized.fields,
        unique: serialized.unique,
        sparse: serialized.sparse,
        entries,
      });
    }
  }

  /**
   * Rebuild all indexes from a full document set
   */
  rebuildAll(documents: Document[]): void {
    // Clear existing entries
    for (const index of this.indexes.values()) {
      index.entries.clear();
    }
    // Re-index all documents
    for (const doc of documents) {
      this.indexDocument(doc);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Build a composite index key from document fields
   */
  private buildIndexKey(doc: Document, fields: string[]): string | null {
    const parts: string[] = [];
    for (const field of fields) {
      const value = this.getNestedValue(doc, field);
      if (value === undefined || value === null) return null;
      parts.push(String(value));
    }
    return parts.join('::');
  }

  /**
   * Get nested value using dot notation
   */
  private getNestedValue(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /**
   * Clear all indexes
   */
  clear(): void {
    this.indexes.clear();
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SerializedIndexes {
  [name: string]: {
    fields: string[];
    unique: boolean;
    sparse: boolean;
    entries: Record<string, string[]>;
  };
}
