/**
 * Gitnix SDK - Query Operators
 *
 * Helper functions for building type-safe queries.
 * These are convenience builders - not required but nice DX.
 */

import type { QueryFilter, QueryOperator, QueryValue } from '../types/index.js';

// ─── Comparison Operators ────────────────────────────────────────────────────

/** Equal to */
export function $eq(value: QueryValue): QueryOperator {
  return { $eq: value };
}

/** Not equal to */
export function $ne(value: QueryValue): QueryOperator {
  return { $ne: value };
}

/** Greater than */
export function $gt(value: number | string | Date): QueryOperator {
  return { $gt: value };
}

/** Greater than or equal */
export function $gte(value: number | string | Date): QueryOperator {
  return { $gte: value };
}

/** Less than */
export function $lt(value: number | string | Date): QueryOperator {
  return { $lt: value };
}

/** Less than or equal */
export function $lte(value: number | string | Date): QueryOperator {
  return { $lte: value };
}

/** In array */
export function $in(values: QueryValue[]): QueryOperator {
  return { $in: values };
}

/** Not in array */
export function $nin(values: QueryValue[]): QueryOperator {
  return { $nin: values };
}

// ─── Logical Operators ───────────────────────────────────────────────────────

/** AND - all conditions must match */
export function $and(...filters: QueryFilter[]): QueryFilter {
  return { $and: filters } as unknown as QueryFilter;
}

/** OR - at least one condition must match */
export function $or(...filters: QueryFilter[]): QueryFilter {
  return { $or: filters } as unknown as QueryFilter;
}

/** NOT - condition must not match */
export function $not(operator: QueryOperator): QueryOperator {
  return { $not: operator };
}

// ─── String Operators ────────────────────────────────────────────────────────

/** Contains substring (case-insensitive) */
export function $contains(value: string): QueryOperator {
  return { $contains: value };
}

/** Starts with string */
export function $startsWith(value: string): QueryOperator {
  return { $startsWith: value };
}

/** Ends with string */
export function $endsWith(value: string): QueryOperator {
  return { $endsWith: value };
}

/** Matches regex pattern */
export function $regex(pattern: string): QueryOperator {
  return { $regex: pattern };
}

// ─── Array Operators ─────────────────────────────────────────────────────────

/** Array has exact size */
export function $size(length: number): QueryOperator {
  return { $size: length };
}

/** Array element matches filter */
export function $elemMatch(filter: QueryFilter): QueryOperator {
  return { $elemMatch: filter };
}

// ─── Existence Operators ─────────────────────────────────────────────────────

/** Field exists */
export function $exists(exists: boolean = true): QueryOperator {
  return { $exists: exists };
}

/** Field is of type */
export function $type(typeName: string): QueryOperator {
  return { $type: typeName };
}

// ─── Range Helper ────────────────────────────────────────────────────────────

/** Between two values (inclusive) */
export function $between(min: number | string | Date, max: number | string | Date): QueryOperator {
  return { $gte: min, $lte: max } as QueryOperator;
}

// ─── Query Builder ───────────────────────────────────────────────────────────

/**
 * Fluent query builder for complex queries
 */
export class QueryBuilder {
  private conditions: Record<string, unknown> = {};

  where(field: string, operator: QueryOperator | QueryValue): QueryBuilder {
    if (typeof operator === 'object' && operator !== null && !Array.isArray(operator) && !(operator instanceof Date)) {
      this.conditions[field] = operator;
    } else {
      this.conditions[field] = { $eq: operator };
    }
    return this;
  }

  and(...filters: QueryFilter[]): QueryBuilder {
    this.conditions['$and'] = filters;
    return this;
  }

  or(...filters: QueryFilter[]): QueryBuilder {
    this.conditions['$or'] = filters;
    return this;
  }

  build(): QueryFilter {
    return { ...this.conditions } as QueryFilter;
  }
}

/**
 * Start building a query
 */
export function query(): QueryBuilder {
  return new QueryBuilder();
}
