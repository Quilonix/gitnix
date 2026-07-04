/**
 * Gitnix SDK - Schema Validation
 *
 * Validates documents against a schema definition.
 * Supports types, required fields, min/max, patterns, enums.
 */

import type { Document, FieldDefinition, SchemaDefinition } from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';

export class SchemaValidator {
  private schema: SchemaDefinition;

  constructor(schema: SchemaDefinition) {
    this.schema = schema;
  }

  /**
   * Validate a document against the schema.
   * Throws GitnixError if validation fails.
   */
  validate(doc: Document): void {
    const errors: string[] = [];

    // Check required fields
    if (this.schema.required) {
      for (const field of this.schema.required) {
        if (!(field in doc) || doc[field] === undefined || doc[field] === null) {
          errors.push(`Required field "${field}" is missing`);
        }
      }
    }

    // Check field types and constraints
    for (const [field, definition] of Object.entries(this.schema.fields)) {
      const value = doc[field];

      // Skip system fields
      if (field.startsWith('_')) continue;

      // Skip undefined if not required
      if (value === undefined || value === null) continue;

      const fieldErrors = this.validateField(field, value, definition);
      errors.push(...fieldErrors);
    }

    // Check additional properties
    if (this.schema.additionalProperties === false) {
      const allowedFields = new Set([
        ...Object.keys(this.schema.fields),
        '_id',
        '_created',
        '_updated',
        '_version',
      ]);

      for (const key of Object.keys(doc)) {
        if (!allowedFields.has(key)) {
          errors.push(`Additional property "${key}" is not allowed`);
        }
      }
    }

    if (errors.length > 0) {
      throw new GitnixError(
        `Schema validation failed: ${errors.join('; ')}`,
        GitnixErrorCode.SCHEMA_VIOLATION,
        { errors },
      );
    }
  }

  /**
   * Validate a single field value against its definition
   */
  private validateField(
    fieldName: string,
    value: unknown,
    definition: FieldDefinition,
  ): string[] {
    const errors: string[] = [];

    // Type check
    if (!this.matchesType(value, definition.type)) {
      errors.push(`Field "${fieldName}" expected type "${definition.type}", got "${typeof value}"`);
      return errors; // Skip further checks if type is wrong
    }

    // String constraints
    if (definition.type === 'string' && typeof value === 'string') {
      if (definition.min !== undefined && value.length < definition.min) {
        errors.push(`Field "${fieldName}" length ${value.length} is less than min ${definition.min}`);
      }
      if (definition.max !== undefined && value.length > definition.max) {
        errors.push(`Field "${fieldName}" length ${value.length} exceeds max ${definition.max}`);
      }
      if (definition.pattern) {
        const regex = new RegExp(definition.pattern);
        if (!regex.test(value)) {
          errors.push(`Field "${fieldName}" does not match pattern "${definition.pattern}"`);
        }
      }
    }

    // Number constraints
    if (definition.type === 'number' && typeof value === 'number') {
      if (definition.min !== undefined && value < definition.min) {
        errors.push(`Field "${fieldName}" value ${value} is less than min ${definition.min}`);
      }
      if (definition.max !== undefined && value > definition.max) {
        errors.push(`Field "${fieldName}" value ${value} exceeds max ${definition.max}`);
      }
    }

    // Array constraints
    if (definition.type === 'array' && Array.isArray(value)) {
      if (definition.min !== undefined && value.length < definition.min) {
        errors.push(`Field "${fieldName}" array length ${value.length} is less than min ${definition.min}`);
      }
      if (definition.max !== undefined && value.length > definition.max) {
        errors.push(`Field "${fieldName}" array length ${value.length} exceeds max ${definition.max}`);
      }
      // Validate items
      if (definition.items) {
        for (let i = 0; i < value.length; i++) {
          const itemErrors = this.validateField(`${fieldName}[${i}]`, value[i], definition.items);
          errors.push(...itemErrors);
        }
      }
    }

    // Object constraints
    if (definition.type === 'object' && typeof value === 'object' && definition.properties) {
      for (const [prop, propDef] of Object.entries(definition.properties)) {
        const propValue = (value as Record<string, unknown>)[prop];
        if (propValue !== undefined && propValue !== null) {
          const propErrors = this.validateField(`${fieldName}.${prop}`, propValue, propDef);
          errors.push(...propErrors);
        }
      }
    }

    // Enum check
    if (definition.enum && !definition.enum.includes(value)) {
      errors.push(`Field "${fieldName}" value must be one of: ${definition.enum.join(', ')}`);
    }

    return errors;
  }

  /**
   * Check if a value matches the expected type
   */
  private matchesType(value: unknown, type: string): boolean {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && !Array.isArray(value) && value !== null;
      case 'date':
        return value instanceof Date || (typeof value === 'string' && !isNaN(Date.parse(value)));
      case 'binary':
        return value instanceof Uint8Array || value instanceof ArrayBuffer;
      default:
        return true;
    }
  }

  /**
   * Get the schema definition
   */
  getSchema(): SchemaDefinition {
    return { ...this.schema };
  }

  /**
   * Apply default values to a document
   */
  applyDefaults(doc: Record<string, unknown>): Record<string, unknown> {
    const result = { ...doc };
    for (const [field, definition] of Object.entries(this.schema.fields)) {
      if (!(field in result) && definition.default !== undefined) {
        result[field] = typeof definition.default === 'function'
          ? (definition.default as () => unknown)()
          : definition.default;
      }
    }
    return result;
  }
}
