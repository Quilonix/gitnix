/**
 * Gitnix SDK - Conflict Resolution
 *
 * Strategies for handling concurrent write conflicts:
 * - Last Write Wins (default)
 * - Field-level merge
 * - Custom merge function
 * - Version vector
 */

import type { Document } from '../types/index.js';

export type ConflictStrategy = 'last-write-wins' | 'field-merge' | 'version-vector' | 'custom';

export interface ConflictInfo {
  /** The local version we tried to write */
  local: Document;
  /** The remote version that was already committed */
  remote: Document;
  /** The common ancestor (if available) */
  ancestor?: Document;
  /** Collection name */
  collection: string;
  /** Document ID */
  documentId: string;
}

export interface ConflictResolution {
  /** Resolved document */
  resolved: Document;
  /** How it was resolved */
  strategy: ConflictStrategy;
  /** Fields that conflicted */
  conflictingFields: string[];
}

export class ConflictResolver {
  /**
   * Resolve a conflict using the specified strategy
   */
  resolve(
    info: ConflictInfo,
    strategy: ConflictStrategy,
    customFn?: (info: ConflictInfo) => Document,
  ): ConflictResolution {
    switch (strategy) {
      case 'last-write-wins':
        return this.lastWriteWins(info);
      case 'field-merge':
        return this.fieldMerge(info);
      case 'version-vector':
        return this.versionVector(info);
      case 'custom':
        if (!customFn) {
          throw new Error('Custom conflict strategy requires a merge function');
        }
        return {
          resolved: customFn(info),
          strategy: 'custom',
          conflictingFields: this.findConflictingFields(info.local, info.remote),
        };
    }
  }

  /**
   * Last Write Wins: prefer the local version (most recent write)
   */
  private lastWriteWins(info: ConflictInfo): ConflictResolution {
    const localTime = new Date(info.local._updated).getTime();
    const remoteTime = new Date(info.remote._updated).getTime();

    const resolved = localTime >= remoteTime ? { ...info.local } : { ...info.remote };
    resolved._version = Math.max(info.local._version, info.remote._version) + 1;
    resolved._updated = new Date().toISOString();

    return {
      resolved,
      strategy: 'last-write-wins',
      conflictingFields: this.findConflictingFields(info.local, info.remote),
    };
  }

  /**
   * Field Merge: merge non-conflicting fields, prefer local for conflicts
   */
  private fieldMerge(info: ConflictInfo): ConflictResolution {
    const conflictingFields: string[] = [];
    const resolved: Document = {
      _id: info.local._id,
      _created: info.local._created,
      _updated: new Date().toISOString(),
      _version: Math.max(info.local._version, info.remote._version) + 1,
    };

    // Get all fields from both versions
    const allFields = new Set([
      ...Object.keys(info.local),
      ...Object.keys(info.remote),
    ]);

    for (const field of allFields) {
      // Skip system fields (handled above)
      if (field.startsWith('_')) continue;

      const localValue = info.local[field];
      const remoteValue = info.remote[field];
      const ancestorValue = info.ancestor?.[field];

      if (this.deepEqual(localValue, remoteValue)) {
        // No conflict
        resolved[field] = localValue;
      } else if (ancestorValue !== undefined) {
        // Three-way merge
        if (this.deepEqual(localValue, ancestorValue)) {
          // Local hasn't changed, use remote
          resolved[field] = remoteValue;
        } else if (this.deepEqual(remoteValue, ancestorValue)) {
          // Remote hasn't changed, use local
          resolved[field] = localValue;
        } else {
          // Both changed — conflict, prefer local
          resolved[field] = localValue;
          conflictingFields.push(field);
        }
      } else {
        // No ancestor — prefer local
        resolved[field] = localValue ?? remoteValue;
        if (localValue !== undefined && remoteValue !== undefined) {
          conflictingFields.push(field);
        }
      }
    }

    return { resolved, strategy: 'field-merge', conflictingFields };
  }

  /**
   * Version Vector: use the highest version for each field
   */
  private versionVector(info: ConflictInfo): ConflictResolution {
    // Higher version wins entirely
    if (info.local._version > info.remote._version) {
      return {
        resolved: { ...info.local, _version: info.local._version + 1 },
        strategy: 'version-vector',
        conflictingFields: this.findConflictingFields(info.local, info.remote),
      };
    }
    if (info.remote._version > info.local._version) {
      return {
        resolved: { ...info.remote, _version: info.remote._version + 1 },
        strategy: 'version-vector',
        conflictingFields: this.findConflictingFields(info.local, info.remote),
      };
    }
    // Same version — fall back to field merge
    return this.fieldMerge(info);
  }

  /**
   * Find fields that differ between two documents
   */
  private findConflictingFields(local: Document, remote: Document): string[] {
    const conflicts: string[] = [];
    const allFields = new Set([...Object.keys(local), ...Object.keys(remote)]);

    for (const field of allFields) {
      if (field.startsWith('_')) continue;
      if (!this.deepEqual(local[field], remote[field])) {
        conflicts.push(field);
      }
    }

    return conflicts;
  }

  /**
   * Deep equality check
   */
  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (a === undefined || b === undefined) return a === b;
    if (typeof a !== typeof b) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, i) => this.deepEqual(item, b[i]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a as object);
      const keysB = Object.keys(b as object);
      if (keysA.length !== keysB.length) return false;
      return keysA.every((key) =>
        this.deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
      );
    }

    return false;
  }
}
