/**
 * Gitnix SDK - Cache Layer
 *
 * LRU (Least Recently Used) cache with:
 * - SHA-based content addressing (no stale reads)
 * - TTL expiry
 * - Memory-aware eviction
 * - Hit/miss tracking
 * - ETag support for conditional requests
 */

import type { CacheConfig, CacheEntry, CacheStats } from '../types/index.js';

export class Cache {
  private store: Map<string, CacheEntry> = new Map();
  private config: Required<CacheConfig>;
  private stats: {
    hits: number;
    misses: number;
    evictions: number;
    totalMemory: number;
  };

  constructor(config: CacheConfig = {}) {
    this.config = {
      maxSize: config.maxSize ?? 5000,
      ttl: config.ttl ?? 300_000, // 5 minutes
      persistent: config.persistent ?? false,
      persistPath: config.persistPath ?? '.gitnix-cache',
    };

    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalMemory: 0,
    };
  }

  // ─── Core Operations ───────────────────────────────────────────────────

  /**
   * Get a value from cache.
   * Returns undefined if not found or expired.
   */
  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.stats.totalMemory -= entry.size;
      this.stats.misses++;
      return undefined;
    }

    // Update access metadata (LRU)
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    this.stats.hits++;

    return entry.value as T;
  }

  /**
   * Get by SHA (content-addressed lookup).
   * Useful when you know the git SHA and want to check if we have the content.
   */
  getBySha<T = unknown>(sha: string): T | undefined {
    // Search for entry with matching SHA
    for (const entry of this.store.values()) {
      if (entry.sha === sha && Date.now() <= entry.expiresAt) {
        entry.lastAccessed = Date.now();
        entry.accessCount++;
        this.stats.hits++;
        return entry.value as T;
      }
    }
    this.stats.misses++;
    return undefined;
  }

  /**
   * Store a value in cache.
   */
  set<T>(key: string, value: T, sha: string, ttl?: number): void {
    // Evict if at capacity
    if (this.store.size >= this.config.maxSize && !this.store.has(key)) {
      this.evictLRU();
    }

    const size = this.estimateSize(value);
    const entry: CacheEntry<T> = {
      value,
      sha,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (ttl ?? this.config.ttl),
      accessCount: 0,
      lastAccessed: Date.now(),
      size,
    };

    // Remove old entry's memory from tracking
    const existing = this.store.get(key);
    if (existing) {
      this.stats.totalMemory -= existing.size;
    }

    this.store.set(key, entry as CacheEntry);
    this.stats.totalMemory += size;
  }

  /**
   * Check if a key exists and is fresh (SHA matches)
   */
  isFresh(key: string, sha: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) return false;
    return entry.sha === sha;
  }

  /**
   * Check if we have a SHA cached anywhere
   */
  hasSha(sha: string): boolean {
    for (const entry of this.store.values()) {
      if (entry.sha === sha && Date.now() <= entry.expiresAt) {
        return true;
      }
    }
    return false;
  }

  /**
   * Invalidate a specific key
   */
  invalidate(key: string): boolean {
    const entry = this.store.get(key);
    if (entry) {
      this.stats.totalMemory -= entry.size;
      this.store.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Invalidate all keys matching a prefix
   */
  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        this.stats.totalMemory -= entry.size;
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.store.clear();
    this.stats.totalMemory = 0;
  }

  // ─── Batch Operations ──────────────────────────────────────────────────

  /**
   * Get multiple values at once
   */
  getMany<T = unknown>(keys: string[]): Map<string, T> {
    const results = new Map<string, T>();
    for (const key of keys) {
      const value = this.get<T>(key);
      if (value !== undefined) {
        results.set(key, value);
      }
    }
    return results;
  }

  /**
   * Set multiple values at once
   */
  setMany<T>(entries: Array<{ key: string; value: T; sha: string }>): void {
    for (const entry of entries) {
      this.set(entry.key, entry.value, entry.sha);
    }
  }

  // ─── Eviction ──────────────────────────────────────────────────────────

  /**
   * Evict the least recently used entry
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.store.get(oldestKey);
      if (entry) {
        this.stats.totalMemory -= entry.size;
      }
      this.store.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  /**
   * Evict expired entries (background cleanup)
   */
  evictExpired(): number {
    const now = Date.now();
    let count = 0;

    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.stats.totalMemory -= entry.size;
        this.store.delete(key);
        count++;
      }
    }

    return count;
  }

  // ─── Stats & Info ──────────────────────────────────────────────────────

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.store.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRatio: total > 0 ? this.stats.hits / total : 0,
      memoryUsage: this.stats.totalMemory,
      evictions: this.stats.evictions,
    };
  }

  /**
   * Get current size
   */
  getSize(): number {
    return this.store.size;
  }

  /**
   * Get all cached keys
   */
  getKeys(): string[] {
    return Array.from(this.store.keys());
  }

  /**
   * Get all SHAs in cache (useful for knowing what we already have)
   */
  getCachedShas(): Set<string> {
    const shas = new Set<string>();
    for (const entry of this.store.values()) {
      if (Date.now() <= entry.expiresAt) {
        shas.add(entry.sha);
      }
    }
    return shas;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────

  /**
   * Estimate the memory size of a value (rough approximation)
   */
  private estimateSize(value: unknown): number {
    if (value === null || value === undefined) return 8;
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;
    if (value instanceof Uint8Array) return value.length;
    if (Array.isArray(value)) {
      return value.reduce((sum, item) => sum + this.estimateSize(item), 16);
    }
    if (typeof value === 'object') {
      return JSON.stringify(value).length * 2;
    }
    return 64;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.clear();
    this.resetStats();
  }
}
