/**
 * Gitnix SDK - File Chunker
 *
 * Utilities for splitting and reassembling binary data.
 * Supports:
 * - Fixed-size chunking
 * - Content-defined chunking (for deduplication)
 * - Streaming chunk processing
 */

/** Default chunk size: 512 KB */
const DEFAULT_CHUNK_SIZE = 512 * 1024;

/** Minimum chunk size for content-defined chunking */
const MIN_CHUNK_SIZE = 256 * 1024;

/** Maximum chunk size for content-defined chunking */
const MAX_CHUNK_SIZE = 1024 * 1024;

export interface Chunk {
  /** Chunk index */
  index: number;
  /** Chunk data */
  data: Uint8Array;
  /** Offset in original file */
  offset: number;
  /** Size of this chunk */
  size: number;
}

export interface ChunkerOptions {
  /** Target chunk size in bytes */
  chunkSize?: number;
  /** Use content-defined chunking (better dedup) */
  contentDefined?: boolean;
}

export class Chunker {
  private chunkSize: number;
  private contentDefined: boolean;

  constructor(options: ChunkerOptions = {}) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.contentDefined = options.contentDefined ?? false;
  }

  /**
   * Split data into chunks
   */
  chunk(data: Uint8Array): Chunk[] {
    if (this.contentDefined) {
      return this.contentDefinedChunking(data);
    }
    return this.fixedSizeChunking(data);
  }

  /**
   * Reassemble chunks into original data
   */
  reassemble(chunks: Chunk[], totalSize?: number): Uint8Array {
    // Sort by index
    const sorted = [...chunks].sort((a, b) => a.index - b.index);

    // Calculate total size
    const size = totalSize ?? sorted.reduce((sum, c) => sum + c.size, 0);
    const result = new Uint8Array(size);

    let offset = 0;
    for (const chunk of sorted) {
      result.set(chunk.data, offset);
      offset += chunk.data.length;
    }

    return result;
  }

  /**
   * Fixed-size chunking (simple, predictable)
   */
  private fixedSizeChunking(data: Uint8Array): Chunk[] {
    const chunks: Chunk[] = [];
    let index = 0;

    for (let offset = 0; offset < data.length; offset += this.chunkSize) {
      const end = Math.min(offset + this.chunkSize, data.length);
      chunks.push({
        index,
        data: data.slice(offset, end),
        offset,
        size: end - offset,
      });
      index++;
    }

    return chunks;
  }

  /**
   * Content-defined chunking using rolling hash (Buzhash-style).
   * Better for deduplication — if only part of a file changes,
   * only the affected chunks change.
   */
  private contentDefinedChunking(data: Uint8Array): Chunk[] {
    const chunks: Chunk[] = [];
    let index = 0;
    let start = 0;
    let hash = 0;

    // Mask for determining chunk boundaries
    // Average chunk size = 2^bits where bits = number of trailing zeros to match
    const bits = Math.round(Math.log2(this.chunkSize));
    const mask = (1 << bits) - 1;

    for (let i = 0; i < data.length; i++) {
      // Rolling hash (simple but effective)
      hash = ((hash << 1) | (hash >>> 31)) ^ data[i]!;

      const currentSize = i - start + 1;

      // Check if this is a chunk boundary
      const isBoundary =
        (hash & mask) === 0 || // Hash-based boundary
        currentSize >= MAX_CHUNK_SIZE || // Max size reached
        i === data.length - 1; // End of data

      if (isBoundary && currentSize >= MIN_CHUNK_SIZE) {
        chunks.push({
          index,
          data: data.slice(start, i + 1),
          offset: start,
          size: currentSize,
        });
        index++;
        start = i + 1;
        hash = 0;
      }
    }

    // Handle remaining data
    if (start < data.length) {
      chunks.push({
        index,
        data: data.slice(start),
        offset: start,
        size: data.length - start,
      });
    }

    return chunks;
  }

  /**
   * Get chunk metadata without the actual data (for planning)
   */
  getChunkPlan(totalSize: number): Array<{ index: number; offset: number; size: number }> {
    const plan: Array<{ index: number; offset: number; size: number }> = [];
    let index = 0;

    for (let offset = 0; offset < totalSize; offset += this.chunkSize) {
      const size = Math.min(this.chunkSize, totalSize - offset);
      plan.push({ index, offset, size });
      index++;
    }

    return plan;
  }

  /**
   * Calculate number of chunks for a given file size
   */
  getChunkCount(totalSize: number): number {
    return Math.ceil(totalSize / this.chunkSize);
  }

  /**
   * Get configured chunk size
   */
  getChunkSize(): number {
    return this.chunkSize;
  }
}
