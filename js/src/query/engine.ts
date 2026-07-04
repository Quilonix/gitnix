/**
 * Gitnix SDK - Query Engine
 *
 * MongoDB-style query operators for filtering, sorting, and pagination.
 * All operations run client-side on decrypted data.
 *
 * Supported operators:
 * - Comparison: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin
 * - Logical: $and, $or, $not
 * - String: $contains, $startsWith, $endsWith, $regex
 * - Array: $elemMatch, $size
 * - Existence: $exists, $type
 */

import type {
  Document,
  QueryFilter,
  QueryOperator,
  QueryOptions,
  QueryResult,
  QueryValue,
  UpdateOperator,
} from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';

export class QueryEngine {
  // ─── Query Execution ───────────────────────────────────────────────────

  /**
   * Execute a query against a set of documents
   */
  execute<T extends Document = Document>(
    documents: T[],
    filter: QueryFilter,
    options: QueryOptions = {},
  ): QueryResult<T> {
    const startTime = performance.now();

    // 1. Filter
    let results = this.filter(documents, filter);

    // 2. Sort
    if (options.sort) {
      results = this.sort(results, options.sort);
    }

    // 3. Count (before pagination)
    const total = results.length;

    // 4. Skip
    if (options.skip && options.skip > 0) {
      results = results.slice(options.skip);
    }

    // 5. Limit
    const hasMore = options.limit ? results.length > options.limit : false;
    if (options.limit && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    // 6. Projection
    if (options.fields && options.fields.length > 0) {
      results = this.project(results, options.fields);
    }

    const executionTime = performance.now() - startTime;

    return {
      docs: results,
      total: options.count ? total : undefined,
      hasMore,
      executionTime,
    };
  }

  // ─── Filtering ─────────────────────────────────────────────────────────

  /**
   * Filter documents matching the query
   */
  filter<T extends Document>(documents: T[], filter: QueryFilter): T[] {
    if (Object.keys(filter).length === 0) return [...documents];

    return documents.filter((doc) => this.matchesFilter(doc, filter));
  }

  /**
   * Check if a single document matches a filter
   */
  matchesFilter(doc: Document, filter: QueryFilter): boolean {
    // Handle top-level $and / $or
    if ('$and' in filter) {
      const conditions = filter['$and'] as QueryFilter[];
      return conditions.every((condition) => this.matchesFilter(doc, condition));
    }

    if ('$or' in filter) {
      const conditions = filter['$or'] as QueryFilter[];
      return conditions.some((condition) => this.matchesFilter(doc, condition));
    }

    if ('$not' in filter) {
      const condition = filter['$not'] as QueryFilter;
      return !this.matchesFilter(doc, condition);
    }

    // Match each field condition
    for (const [field, condition] of Object.entries(filter)) {
      if (field.startsWith('$')) continue; // Skip operators at top level

      const value = this.getNestedValue(doc, field);

      if (condition === null || condition === undefined || typeof condition !== 'object') {
        // Direct value comparison ($eq shorthand)
        if (!this.evaluateOperator(value, { $eq: condition as QueryValue })) {
          return false;
        }
      } else if (this.isOperator(condition)) {
        // Operator object
        if (!this.evaluateOperator(value, condition as unknown as QueryOperator)) {
          return false;
        }
      } else {
        // Direct value comparison
        if (!this.evaluateOperator(value, { $eq: condition as unknown as QueryValue })) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Evaluate a query operator against a value
   */
  private evaluateOperator(value: unknown, operator: QueryOperator): boolean {
    for (const [op, operand] of Object.entries(operator)) {
      switch (op) {
        case '$eq':
          if (!this.isEqual(value, operand)) return false;
          break;
        case '$ne':
          if (this.isEqual(value, operand)) return false;
          break;
        case '$gt':
          if (!this.compare(value, operand, '>')) return false;
          break;
        case '$gte':
          if (!this.compare(value, operand, '>=')) return false;
          break;
        case '$lt':
          if (!this.compare(value, operand, '<')) return false;
          break;
        case '$lte':
          if (!this.compare(value, operand, '<=')) return false;
          break;
        case '$in':
          if (!Array.isArray(operand) || !operand.some((v) => this.isEqual(value, v)))
            return false;
          break;
        case '$nin':
          if (Array.isArray(operand) && operand.some((v) => this.isEqual(value, v)))
            return false;
          break;
        case '$exists':
          if (operand && value === undefined) return false;
          if (!operand && value !== undefined) return false;
          break;
        case '$type':
          if (typeof value !== operand) return false;
          break;
        case '$regex': {
          if (typeof value !== 'string') return false;
          const regex = new RegExp(operand as string);
          if (!regex.test(value)) return false;
          break;
        }
        case '$contains':
          if (typeof value !== 'string' || typeof operand !== 'string') return false;
          if (!value.toLowerCase().includes(operand.toLowerCase())) return false;
          break;
        case '$startsWith':
          if (typeof value !== 'string' || typeof operand !== 'string') return false;
          if (!value.startsWith(operand)) return false;
          break;
        case '$endsWith':
          if (typeof value !== 'string' || typeof operand !== 'string') return false;
          if (!value.endsWith(operand)) return false;
          break;
        case '$size':
          if (!Array.isArray(value) || value.length !== operand) return false;
          break;
        case '$elemMatch':
          if (!Array.isArray(value)) return false;
          if (!value.some((item) => this.matchesFilter(item as Document, operand as QueryFilter)))
            return false;
          break;
        case '$not':
          if (this.evaluateOperator(value, operand as QueryOperator)) return false;
          break;
        default:
          throw new GitnixError(
            `Unknown operator: ${op}`,
            GitnixErrorCode.INVALID_OPERATOR,
          );
      }
    }
    return true;
  }

  // ─── Sorting ───────────────────────────────────────────────────────────

  /**
   * Sort documents by multiple fields
   */
  sort<T extends Document>(documents: T[], sortSpec: Record<string, 1 | -1>): T[] {
    return [...documents].sort((a, b) => {
      for (const [field, direction] of Object.entries(sortSpec)) {
        const aVal = this.getNestedValue(a, field);
        const bVal = this.getNestedValue(b, field);

        const comparison = this.compareValues(aVal, bVal);
        if (comparison !== 0) {
          return comparison * direction;
        }
      }
      return 0;
    });
  }

  // ─── Projection ────────────────────────────────────────────────────────

  /**
   * Project only specific fields from documents
   */
  project<T extends Document>(documents: T[], fields: string[]): T[] {
    return documents.map((doc) => {
      const projected: Record<string, unknown> = { _id: doc._id };
      for (const field of fields) {
        const value = this.getNestedValue(doc, field);
        if (value !== undefined) {
          this.setNestedValue(projected, field, value);
        }
      }
      return projected as T;
    });
  }

  // ─── Update Operations ─────────────────────────────────────────────────

  /**
   * Apply update operators to a document
   */
  applyUpdate(doc: Document, update: UpdateOperator): Document {
    const result = { ...doc };

    if (update.$set) {
      for (const [key, value] of Object.entries(update.$set)) {
        this.setNestedValue(result, key, value);
      }
    }

    if (update.$unset) {
      for (const key of Object.keys(update.$unset)) {
        this.deleteNestedValue(result, key);
      }
    }

    if (update.$inc) {
      for (const [key, amount] of Object.entries(update.$inc)) {
        const current = this.getNestedValue(result, key);
        if (typeof current === 'number') {
          this.setNestedValue(result, key, current + amount);
        } else {
          this.setNestedValue(result, key, amount);
        }
      }
    }

    if (update.$push) {
      for (const [key, value] of Object.entries(update.$push)) {
        const current = this.getNestedValue(result, key);
        if (Array.isArray(current)) {
          current.push(value);
        } else {
          this.setNestedValue(result, key, [value]);
        }
      }
    }

    if (update.$pull) {
      for (const [key, value] of Object.entries(update.$pull)) {
        const current = this.getNestedValue(result, key);
        if (Array.isArray(current)) {
          const filtered = current.filter((item) => !this.isEqual(item, value));
          this.setNestedValue(result, key, filtered);
        }
      }
    }

    if (update.$addToSet) {
      for (const [key, value] of Object.entries(update.$addToSet)) {
        const current = this.getNestedValue(result, key);
        if (Array.isArray(current)) {
          if (!current.some((item) => this.isEqual(item, value))) {
            current.push(value);
          }
        } else {
          this.setNestedValue(result, key, [value]);
        }
      }
    }

    if (update.$rename) {
      for (const [oldKey, newKey] of Object.entries(update.$rename)) {
        const value = this.getNestedValue(result, oldKey);
        if (value !== undefined) {
          this.deleteNestedValue(result, oldKey);
          this.setNestedValue(result, newKey, value);
        }
      }
    }

    if (update.$min) {
      for (const [key, value] of Object.entries(update.$min)) {
        const current = this.getNestedValue(result, key);
        if (current === undefined || (typeof current === 'number' && value < current)) {
          this.setNestedValue(result, key, value);
        }
      }
    }

    if (update.$max) {
      for (const [key, value] of Object.entries(update.$max)) {
        const current = this.getNestedValue(result, key);
        if (current === undefined || (typeof current === 'number' && value > current)) {
          this.setNestedValue(result, key, value);
        }
      }
    }

    return result;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Get a nested value from an object using dot notation
   */
  private getNestedValue(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Set a nested value in an object using dot notation
   */
  private setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!(part in current) || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]!] = value;
  }

  /**
   * Delete a nested value using dot notation
   */
  private deleteNestedValue(obj: Record<string, unknown>, path: string): void {
    const parts = path.split('.');
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!(part in current) || typeof current[part] !== 'object') return;
      current = current[part] as Record<string, unknown>;
    }

    delete current[parts[parts.length - 1]!];
  }

  /**
   * Check if a condition object is an operator (has $ keys)
   */
  private isOperator(obj: unknown): boolean {
    if (typeof obj !== 'object' || obj === null) return false;
    return Object.keys(obj).some((key) => key.startsWith('$'));
  }

  /**
   * Deep equality check
   */
  private isEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a === undefined || b === undefined) return false;
    if (typeof a !== typeof b) return false;

    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, i) => this.isEqual(item, b[i]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a as object);
      const keysB = Object.keys(b as object);
      if (keysA.length !== keysB.length) return false;
      return keysA.every((key) =>
        this.isEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
      );
    }

    return false;
  }

  /**
   * Compare two values with an operator
   */
  private compare(
    value: unknown,
    operand: unknown,
    op: '>' | '>=' | '<' | '<=',
  ): boolean {
    if (value === undefined || value === null) return false;
    if (operand === undefined || operand === null) return false;

    const v = this.toComparable(value);
    const o = this.toComparable(operand);

    if (v === null || o === null) return false;

    switch (op) {
      case '>':
        return v > o;
      case '>=':
        return v >= o;
      case '<':
        return v < o;
      case '<=':
        return v <= o;
    }
  }

  /**
   * Convert to a comparable value
   */
  private toComparable(value: unknown): number | string | null {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.getTime();
    return null;
  }

  /**
   * Compare two values for sorting
   */
  private compareValues(a: unknown, b: unknown): number {
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;

    const aComp = this.toComparable(a);
    const bComp = this.toComparable(b);

    if (aComp === null && bComp === null) return 0;
    if (aComp === null) return -1;
    if (bComp === null) return 1;

    if (aComp < bComp) return -1;
    if (aComp > bComp) return 1;
    return 0;
  }
}
