/**
 * Gitnix SDK - Binary/Image Storage
 *
 * Handles large file uploads by:
 * - Chunking files into encrypted pieces (512KB default)
 * - Uploading chunks as individual blobs
 * - Maintaining a metadata record for reassembly
 * - Supporting streaming downloads
 * - Auto-detecting MIME types
 * - Image metadata extraction (dimensions)
 *
 * Files are stored in: binaries/{hashed-id}/chunk_{N}.enc
 * Metadata stored in: binaries/{hashed-id}/meta.enc
 */

import type {
  BinaryMetadata,
  DownloadOptions,
  DownloadProgress,
  UploadOptions,
  UploadProgress,
} from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';
import type { Transport } from '../core/transport.js';
import type { Cache } from '../core/cache.js';
import type { StorageManager } from '../core/storage-manager.js';
import type { KeyManager } from '../crypto/keys.js';

/** Default chunk size: 512 KB */
const DEFAULT_CHUNK_SIZE = 512 * 1024;

/** Max file size: 95 MB (leaving room for encryption overhead, below GitHub's 100MB) */
const MAX_FILE_SIZE = 95 * 1024 * 1024;

/** Binary collection ID for key management */
const BINARY_COLLECTION = '__binaries__';

/** Common MIME type signatures (magic bytes) */
const MIME_SIGNATURES: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' },
  { bytes: [0x1f, 0x8b], mime: 'application/gzip' },
  { bytes: [0x42, 0x4d], mime: 'image/bmp' },
  { bytes: [0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70], mime: 'video/mp4' },
  { bytes: [0x49, 0x44, 0x33], mime: 'audio/mpeg' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], mime: 'audio/ogg' },
  { bytes: [0x66, 0x4c, 0x61, 0x43], mime: 'audio/flac' },
];

export class BinaryStorage {
  private transport: Transport;
  private cache: Cache;
  private storageManager: StorageManager;
  private keyManager: KeyManager;

  constructor(
    transport: Transport,
    cache: Cache,
    storageManager: StorageManager,
    keyManager: KeyManager,
  ) {
    this.transport = transport;
    this.cache = cache;
    this.storageManager = storageManager;
    this.keyManager = keyManager;
  }

  // ─── Upload ────────────────────────────────────────────────────────────

  /**
   * Upload a binary file (image, document, etc.)
   * Chunks, encrypts, and stores in the repo.
   */
  async upload(data: Uint8Array, options: UploadOptions = {}): Promise<BinaryMetadata> {
    // Validate
    if (data.length === 0) {
      throw new GitnixError('Cannot upload empty file', GitnixErrorCode.UPLOAD_FAILED);
    }
    if (data.length > MAX_FILE_SIZE) {
      throw new GitnixError(
        `File size ${data.length} exceeds limit of ${MAX_FILE_SIZE} bytes`,
        GitnixErrorCode.FILE_TOO_LARGE,
        { size: data.length, limit: MAX_FILE_SIZE },
      );
    }

    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const fileId = this.generateFileId();
    const mimeType = options.mimeType ?? this.detectMimeType(data, options.filename);
    const hash = await this.hashFile(data);

    // Detect image dimensions
    const dimensions = this.isImage(mimeType) ? this.getImageDimensions(data, mimeType) : null;

    // Chunk the file
    const chunks = this.chunkData(data, chunkSize);
    const totalChunks = chunks.length;

    // Get storage allocation
    const allocation = await this.storageManager.getAllocation(BINARY_COLLECTION, data.length * 1.5);
    const basePath = `binaries/${this.keyManager.hashDocumentId(BINARY_COLLECTION, fileId)}`;

    // Upload chunks with progress
    const batchOps: Array<{ path: string; content: string; encoding: 'base64' }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const encrypted = this.keyManager.encryptBytesForCollection(BINARY_COLLECTION, chunk);
      batchOps.push({
        path: `${basePath}/chunk_${i.toString().padStart(5, '0')}.enc`,
        content: encrypted,
        encoding: 'base64',
      });

      // Report progress
      if (options.onProgress) {
        const progress: UploadProgress = {
          bytesUploaded: Math.min((i + 1) * chunkSize, data.length),
          totalBytes: data.length,
          percentage: Math.round(((i + 1) / totalChunks) * 100),
          currentChunk: i + 1,
          totalChunks,
        };
        options.onProgress(progress);
      }
    }

    // Create metadata
    const metadata: BinaryMetadata = {
      id: fileId,
      filename: options.filename ?? `file_${fileId}`,
      mimeType,
      size: data.length,
      chunkCount: totalChunks,
      chunkSize,
      hash,
      uploadedAt: new Date().toISOString(),
      metadata: options.metadata,
      repo: allocation.repo,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
    };

    // Encrypt and add metadata
    const encryptedMeta = this.keyManager.encryptForCollection(BINARY_COLLECTION, metadata);
    batchOps.push({
      path: `${basePath}/meta.enc`,
      content: encryptedMeta,
      encoding: 'base64',
    });

    // Batch write all chunks + metadata in one commit
    await this.transport.batchWrite(
      batchOps,
      `gitnix: upload binary ${metadata.filename} (${this.formatSize(data.length)})`,
      allocation.repo,
    );

    // Update storage
    this.storageManager.updateUsage(allocation.repo, data.length * 1.4); // ~40% encryption overhead

    // Cache metadata
    this.cache.set(`binary:meta:${fileId}`, metadata, hash);

    return metadata;
  }

  // ─── Download ──────────────────────────────────────────────────────────

  /**
   * Download a binary file by ID.
   * Fetches chunks, decrypts, and reassembles.
   */
  async download(fileId: string, options: DownloadOptions = {}): Promise<Uint8Array> {
    // Get metadata
    const metadata = await this.getMetadata(fileId);
    if (!metadata) {
      throw new GitnixError(
        `Binary file not found: ${fileId}`,
        GitnixErrorCode.DOWNLOAD_FAILED,
        { fileId },
      );
    }

    const basePath = `binaries/${this.keyManager.hashDocumentId(BINARY_COLLECTION, fileId)}`;
    const repo = metadata.repo;

    // Fetch all chunk files
    const files = await this.transport.listFiles(basePath, repo);
    const chunkFiles = files
      .filter((f) => f.path.includes('chunk_'))
      .sort((a, b) => a.path.localeCompare(b.path));

    if (chunkFiles.length !== metadata.chunkCount) {
      throw new GitnixError(
        `Expected ${metadata.chunkCount} chunks, found ${chunkFiles.length}`,
        GitnixErrorCode.CHUNK_MISSING,
        { expected: metadata.chunkCount, found: chunkFiles.length },
      );
    }

    // Download and decrypt chunks
    const chunks: Uint8Array[] = [];
    let bytesDownloaded = 0;

    for (let i = 0; i < chunkFiles.length; i++) {
      const file = chunkFiles[i]!;

      // Check cache
      let chunkData: Uint8Array;
      const cached = this.cache.getBySha<Uint8Array>(file.sha);
      if (cached) {
        chunkData = cached;
      } else {
        const blob = await this.transport.getBlob(file.sha, repo);
        chunkData = this.keyManager.decryptBytesForCollection(BINARY_COLLECTION, blob.content);
        this.cache.set(`binary:chunk:${fileId}:${i}`, chunkData, file.sha);
      }

      chunks.push(chunkData);
      bytesDownloaded += chunkData.length;

      // Report progress
      if (options.onProgress) {
        const progress: DownloadProgress = {
          bytesDownloaded,
          totalBytes: metadata.size,
          percentage: Math.round(((i + 1) / chunkFiles.length) * 100),
          currentChunk: i + 1,
          totalChunks: chunkFiles.length,
        };
        options.onProgress(progress);
      }
    }

    // Reassemble
    const result = this.reassembleChunks(chunks, metadata.size);

    // Handle range request
    if (options.range) {
      return result.slice(options.range.start, options.range.end + 1);
    }

    return result;
  }

  // ─── Metadata ──────────────────────────────────────────────────────────

  /**
   * Get file metadata without downloading content
   */
  async getMetadata(fileId: string): Promise<BinaryMetadata | null> {
    // Check cache
    const cached = this.cache.get<BinaryMetadata>(`binary:meta:${fileId}`);
    if (cached) return cached;

    const basePath = `binaries/${this.keyManager.hashDocumentId(BINARY_COLLECTION, fileId)}`;

    try {
      // Try primary repo first, then check manifest
      const repo = this.storageManager.getCollectionRepo(BINARY_COLLECTION);
      const files = await this.transport.listFiles(basePath, repo);
      const metaFile = files.find((f) => f.path.endsWith('meta.enc'));

      if (!metaFile) return null;

      const blob = await this.transport.getBlob(metaFile.sha, repo);
      const metadata = this.keyManager.decryptForCollection<BinaryMetadata>(
        BINARY_COLLECTION,
        blob.content,
      );

      this.cache.set(`binary:meta:${fileId}`, metadata, metaFile.sha);
      return metadata;
    } catch {
      return null;
    }
  }

  /**
   * List all stored files
   */
  async list(): Promise<BinaryMetadata[]> {
    const repo = this.storageManager.getCollectionRepo(BINARY_COLLECTION);
    try {
      const files = await this.transport.listFiles('binaries', repo);
      const metaFiles = files.filter((f) => f.path.endsWith('meta.enc'));

      const results: BinaryMetadata[] = [];
      for (const file of metaFiles) {
        const blob = await this.transport.getBlob(file.sha, repo);
        const metadata = this.keyManager.decryptForCollection<BinaryMetadata>(
          BINARY_COLLECTION,
          blob.content,
        );
        results.push(metadata);
      }

      return results;
    } catch {
      return [];
    }
  }

  // ─── Delete ────────────────────────────────────────────────────────────

  /**
   * Delete a binary file
   */
  async delete(fileId: string): Promise<boolean> {
    const metadata = await this.getMetadata(fileId);
    if (!metadata) return false;

    const basePath = `binaries/${this.keyManager.hashDocumentId(BINARY_COLLECTION, fileId)}`;
    const repo = metadata.repo;

    // Get all files for this binary
    const files = await this.transport.listFiles(basePath, repo);

    // Create delete operations
    const deleteOps = files.map((f) => ({
      path: f.path,
      content: '',
      delete: true as const,
    }));

    if (deleteOps.length > 0) {
      await this.transport.batchWrite(
        deleteOps,
        `gitnix: delete binary ${metadata.filename}`,
        repo,
      );
    }

    // Clear cache
    this.cache.invalidatePrefix(`binary:${fileId}`);
    this.cache.invalidate(`binary:meta:${fileId}`);

    return true;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Split data into chunks
   */
  private chunkData(data: Uint8Array, chunkSize: number): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, data.length);
      chunks.push(data.slice(offset, end));
    }
    return chunks;
  }

  /**
   * Reassemble chunks into a single buffer
   */
  private reassembleChunks(chunks: Uint8Array[], totalSize: number): Uint8Array {
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Detect MIME type from magic bytes and filename
   */
  private detectMimeType(data: Uint8Array, filename?: string): string {
    // Try magic bytes first
    for (const sig of MIME_SIGNATURES) {
      if (data.length >= sig.bytes.length) {
        const matches = sig.bytes.every((byte, i) => data[i] === byte);
        if (matches) return sig.mime;
      }
    }

    // Fall back to extension
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const extMap: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
        pdf: 'application/pdf',
        zip: 'application/zip',
        gz: 'application/gzip',
        tar: 'application/x-tar',
        json: 'application/json',
        xml: 'application/xml',
        txt: 'text/plain',
        html: 'text/html',
        css: 'text/css',
        js: 'application/javascript',
        ts: 'application/typescript',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        flac: 'audio/flac',
        avi: 'video/x-msvideo',
        mkv: 'video/x-matroska',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      };
      if (ext && ext in extMap) return extMap[ext]!;
    }

    return 'application/octet-stream';
  }

  /**
   * Check if a MIME type is an image
   */
  private isImage(mimeType: string): boolean {
    return mimeType.startsWith('image/');
  }

  /**
   * Get image dimensions from binary data (basic parser for PNG/JPEG)
   */
  private getImageDimensions(
    data: Uint8Array,
    mimeType: string,
  ): { width: number; height: number } | null {
    try {
      if (mimeType === 'image/png') {
        // PNG: width at offset 16, height at offset 20 (4 bytes each, big-endian)
        if (data.length < 24) return null;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        return {
          width: view.getUint32(16, false),
          height: view.getUint32(20, false),
        };
      }

      if (mimeType === 'image/jpeg') {
        // JPEG: search for SOF marker
        let offset = 2;
        while (offset < data.length - 8) {
          if (data[offset] === 0xff) {
            const marker = data[offset + 1]!;
            // SOF0-SOF3 markers
            if (marker >= 0xc0 && marker <= 0xc3) {
              const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
              return {
                height: view.getUint16(offset + 5, false),
                width: view.getUint16(offset + 7, false),
              };
            }
            // Skip to next marker
            const segLength = (data[offset + 2]! << 8) | data[offset + 3]!;
            offset += 2 + segLength;
          } else {
            offset++;
          }
        }
      }

      if (mimeType === 'image/gif') {
        // GIF: width at offset 6, height at offset 8 (2 bytes each, little-endian)
        if (data.length < 10) return null;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        return {
          width: view.getUint16(6, true),
          height: view.getUint16(8, true),
        };
      }
    } catch {
      // If parsing fails, just return null
    }

    return null;
  }

  /**
   * Hash file data using SHA-256 (Web Crypto)
   */
  private async hashFile(data: Uint8Array): Promise<string> {
    if (typeof globalThis.crypto?.subtle !== 'undefined') {
      const hash = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    // Fallback: simple hash
    let h = 0;
    for (let i = 0; i < data.length; i++) {
      h = ((h << 5) - h + data[i]!) | 0;
    }
    return Math.abs(h).toString(16).padStart(16, '0');
  }

  /**
   * Generate a unique file ID
   */
  private generateFileId(): string {
    const timestamp = Date.now().toString(36);
    const random = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(36))
      .join('');
    return `${timestamp}-${random}`;
  }

  /**
   * Format bytes to human-readable
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}
