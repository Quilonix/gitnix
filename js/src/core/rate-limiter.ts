/**
 * Gitnix SDK - Rate Limiter
 *
 * Token bucket algorithm with:
 * - Primary rate limit tracking (5000/hr)
 * - Secondary rate limit tracking (900 points/min)
 * - Write rate limiting (80 content-generating/min)
 * - Concurrent request limiting
 * - Exponential backoff retry
 * - Backpressure (queue requests when near limit)
 */

import type { RateLimiterConfig } from '../types/index.js';

interface QueuedRequest {
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  priority: number;
  enqueuedAt: number;
  isWrite: boolean;
}

export interface RateLimitState {
  /** Remaining requests in primary budget */
  remaining: number;
  /** Total primary limit */
  limit: number;
  /** Reset time (unix epoch seconds) */
  reset: number;
  /** Requests used in current window */
  used: number;
  /** Points used in current minute (secondary) */
  pointsUsedThisMinute: number;
  /** Writes this minute */
  writesThisMinute: number;
  /** Active concurrent requests */
  activeConcurrent: number;
}

export class RateLimiter {
  private config: Required<RateLimiterConfig>;
  private state: RateLimitState;
  private queue: QueuedRequest[] = [];
  private processing = false;
  private minuteResetInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimiterConfig = {}) {
    this.config = {
      maxRequestsPerHour: config.maxRequestsPerHour ?? 5000,
      maxConcurrent: config.maxConcurrent ?? 10,
      maxWritesPerMinute: config.maxWritesPerMinute ?? 20,
      retryAttempts: config.retryAttempts ?? 3,
      retryBaseDelay: config.retryBaseDelay ?? 1000,
    };

    this.state = {
      remaining: this.config.maxRequestsPerHour,
      limit: this.config.maxRequestsPerHour,
      reset: Math.floor(Date.now() / 1000) + 3600,
      used: 0,
      pointsUsedThisMinute: 0,
      writesThisMinute: 0,
      activeConcurrent: 0,
    };

    // Reset per-minute counters
    this.minuteResetInterval = setInterval(() => {
      this.state.pointsUsedThisMinute = 0;
      this.state.writesThisMinute = 0;
      this.processQueue();
    }, 60_000);
  }

  /**
   * Update rate limit state from API response headers
   */
  updateFromHeaders(headers: Record<string, string>): void {
    const limit = headers['x-ratelimit-limit'];
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    const used = headers['x-ratelimit-used'];

    if (limit) this.state.limit = parseInt(limit, 10);
    if (remaining) this.state.remaining = parseInt(remaining, 10);
    if (reset) this.state.reset = parseInt(reset, 10);
    if (used) this.state.used = parseInt(used, 10);
  }

  /**
   * Check if we can make a request right now
   */
  canRequest(isWrite: boolean): boolean {
    // Check primary rate limit
    if (this.state.remaining <= 0) {
      const now = Math.floor(Date.now() / 1000);
      if (now < this.state.reset) return false;
      // Reset window has passed, reset state
      this.state.remaining = this.state.limit;
      this.state.used = 0;
    }

    // Check concurrent limit
    if (this.state.activeConcurrent >= this.config.maxConcurrent) {
      return false;
    }

    // Check secondary limits (points)
    const points = isWrite ? 5 : 1;
    if (this.state.pointsUsedThisMinute + points > 900) {
      return false;
    }

    // Check write limit
    if (isWrite && this.state.writesThisMinute >= this.config.maxWritesPerMinute) {
      return false;
    }

    return true;
  }

  /**
   * Execute a request with rate limiting, queuing, and retry
   */
  async execute<T>(
    fn: () => Promise<T>,
    options: { isWrite?: boolean; priority?: number } = {},
  ): Promise<T> {
    const { isWrite = false, priority = 0 } = options;

    if (this.canRequest(isWrite)) {
      return this.executeImmediate(fn, isWrite);
    }

    // Queue the request
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        execute: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        priority,
        enqueuedAt: Date.now(),
        isWrite,
      });

      // Sort by priority (higher first), then by enqueue time
      this.queue.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.enqueuedAt - b.enqueuedAt;
      });

      this.processQueue();
    });
  }

  /**
   * Execute immediately, tracking state
   */
  private async executeImmediate<T>(fn: () => Promise<T>, isWrite: boolean): Promise<T> {
    const points = isWrite ? 5 : 1;
    this.state.activeConcurrent++;
    this.state.pointsUsedThisMinute += points;
    this.state.remaining--;
    this.state.used++;
    if (isWrite) this.state.writesThisMinute++;

    try {
      const result = await fn();
      return result;
    } finally {
      this.state.activeConcurrent--;
      this.processQueue();
    }
  }

  /**
   * Process queued requests
   */
  private processQueue(): void {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (!next) break;

        if (!this.canRequest(next.isWrite)) break;

        this.queue.shift();
        this.executeImmediate(next.execute, next.isWrite)
          .then(next.resolve)
          .catch(next.reject);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute with retry and exponential backoff
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    options: { isWrite?: boolean; priority?: number; maxRetries?: number } = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.execute(fn, options);
      } catch (error) {
        lastError = error as Error;
        const isRateLimit =
          error instanceof Error &&
          (error.message.includes('rate limit') ||
            error.message.includes('429') ||
            error.message.includes('403'));

        if (!isRateLimit || attempt === maxRetries) {
          throw error;
        }

        // Exponential backoff with jitter
        const delay =
          this.config.retryBaseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        await this.sleep(delay);
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }

  /**
   * Get time until rate limit resets (ms)
   */
  getResetDelay(): number {
    const now = Math.floor(Date.now() / 1000);
    const diff = this.state.reset - now;
    return Math.max(0, diff * 1000);
  }

  /**
   * Get current state (read-only snapshot)
   */
  getState(): Readonly<RateLimitState> {
    return { ...this.state };
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.minuteResetInterval) {
      clearInterval(this.minuteResetInterval);
      this.minuteResetInterval = null;
    }
    // Reject all queued requests
    for (const req of this.queue) {
      req.reject(new Error('Rate limiter destroyed'));
    }
    this.queue = [];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
