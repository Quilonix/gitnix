/**
 * Gitnix SDK - Complete Type Definitions
 */

// ─── Core Config ─────────────────────────────────────────────────────────────

export interface GitnixConfig {
  /** GitHub repo in format "owner/repo" */
  repo: string;
  /** GitHub personal access token or GitHub App token */
  token: string;
  /** Master password for encryption (never stored) */
  password: string;
  /** Optional: branch to use (default: "main") */
  branch?: string;
  /** Optional: additional repos for overflow storage */
  overflowRepos?: string[];
  /** Cache configuration */
  cache?: CacheConfig;
  /** Rate limiter configuration */
  rateLimiter?: RateLimiterConfig;
  /** Encryption configuration */
  encryption?: EncryptionConfig;
  /** GitHub API base URL (for Enterprise) */
  apiBaseUrl?: string;
  /** Auto-create repo if it doesn't exist */
  autoCreate?: boolean;
}

export interface CacheConfig {
  /** Max number of items in cache (default: 5000) */
  maxSize?: number;
  /** TTL in milliseconds (default: 300000 = 5 min) */
  ttl?: number;
  /** Enable persistent cache to disk */
  persistent?: boolean;
  /** Path for persistent cache */
  persistPath?: string;
}

export interface RateLimiterConfig {
  /** Max requests per hour (default: 5000) */
  maxRequestsPerHour?: number;
  /** Max concurrent requests (default: 10) */
  maxConcurrent?: number;
  /** Max write operations per minute (default: 20) */
  maxWritesPerMinute?: number;
  /** Retry attempts on rate limit (default: 3) */
  retryAttempts?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryBaseDelay?: number;
}

export interface EncryptionConfig {
  /** Argon2 memory cost in KiB (default: 65536 = 64MB) */
  argon2MemoryCost?: number;
  /** Argon2 time cost / iterations (default: 3) */
  argon2TimeCost?: number;
  /** Argon2 parallelism (default: 1) */
  argon2Parallelism?: number;
  /** Enable padding to hide record sizes (default: true) */
  enablePadding?: boolean;
  /** Padding block size in bytes (default: 256) */
  paddingBlockSize?: number;
}

// ─── Transport Types ─────────────────────────────────────────────────────────

export interface GitHubBlob {
  sha: string;
  url: string;
  size: number;
}

export interface GitHubTreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url?: string;
}

export interface GitHubTree {
  sha: string;
  url: string;
  tree: GitHubTreeEntry[];
  truncated: boolean;
}

export interface GitHubCommit {
  sha: string;
  url: string;
  message: string;
  tree: { sha: string; url: string };
  parents: Array<{ sha: string; url: string }>;
  author: { name: string; email: string; date: string };
}

export interface GitHubRef {
  ref: string;
  url: string;
  object: { sha: string; type: string; url: string };
}

export interface CreateBlobRequest {
  content: string;
  encoding: 'utf-8' | 'base64';
}

export interface CreateTreeRequest {
  base_tree?: string;
  tree: Array<{
    path: string;
    mode: '100644' | '100755' | '040000' | '160000' | '120000';
    type: 'blob' | 'tree' | 'commit';
    sha: string | null;
    content?: string;
  }>;
}

export interface CreateCommitRequest {
  message: string;
  tree: string;
  parents: string[];
  author?: { name: string; email: string; date?: string };
}

export interface UpdateRefRequest {
  sha: string;
  force?: boolean;
}

export interface TransportRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  repo?: string;
}

export interface TransportResponse<T = unknown> {
  data: T;
  status: number;
  headers: Record<string, string>;
  rateLimit: {
    limit: number;
    remaining: number;
    reset: number;
    used: number;
  };
}

// ─── Encryption Types ────────────────────────────────────────────────────────

export interface EncryptedBlob {
  /** Version byte for forward compatibility */
  version: number;
  /** 24-byte nonce */
  nonce: Uint8Array;
  /** Encrypted data with auth tag */
  ciphertext: Uint8Array;
}

export interface DerivedKeys {
  /** Master key derived from password */
  masterKey: Uint8Array;
  /** Salt used for derivation */
  salt: Uint8Array;
}

export interface CollectionKey {
  /** Collection identifier */
  collectionId: string;
  /** Encrypted collection key (encrypted with master key) */
  encryptedKey: Uint8Array;
  /** Nonce used for encrypting the key */
  nonce: Uint8Array;
  /** Creation timestamp */
  createdAt: number;
  /** Key version for rotation */
  version: number;
}

export interface KeyStore {
  /** Version of the keystore format */
  version: number;
  /** Argon2 salt */
  salt: Uint8Array;
  /** Argon2 parameters used */
  kdfParams: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  /** Map of collection ID to encrypted key */
  collections: Record<string, CollectionKey>;
  /** Master key verification hash */
  verificationHash: Uint8Array;
}

// ─── Cache Types ─────────────────────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  /** Cached value */
  value: T;
  /** Git SHA of the content */
  sha: string;
  /** When the entry was cached */
  cachedAt: number;
  /** TTL expiry time */
  expiresAt: number;
  /** Access count for LRU */
  accessCount: number;
  /** Last access time */
  lastAccessed: number;
  /** Size in bytes (approximate) */
  size: number;
}

export interface CacheStats {
  /** Total items in cache */
  size: number;
  /** Cache hit count */
  hits: number;
  /** Cache miss count */
  misses: number;
  /** Hit ratio */
  hitRatio: number;
  /** Total memory usage (approximate) */
  memoryUsage: number;
  /** Eviction count */
  evictions: number;
}

// ─── Storage Manager Types ───────────────────────────────────────────────────

export interface RepoInfo {
  /** Full repo name (owner/repo) */
  name: string;
  /** Current size in bytes */
  currentSize: number;
  /** Max size in bytes (GitHub limit ~5GB, we use 4GB threshold) */
  maxSize: number;
  /** Number of collections stored */
  collectionCount: number;
  /** Is this the primary repo? */
  isPrimary: boolean;
  /** Last sync timestamp */
  lastSync: number;
}

export interface StorageAllocation {
  /** Which repo to write to */
  repo: string;
  /** Path within the repo */
  path: string;
  /** Available space in bytes */
  availableSpace: number;
}

export interface MultiRepoManifest {
  /** Version */
  version: number;
  /** Primary repo */
  primary: string;
  /** All repos in the pool */
  repos: RepoInfo[];
  /** Collection → repo mapping */
  collectionMap: Record<string, string>;
  /** Total storage used across all repos */
  totalUsed: number;
  /** Total available storage */
  totalAvailable: number;
  /** Last updated timestamp */
  updatedAt: number;
}

// ─── Collection Types ────────────────────────────────────────────────────────

export interface Document {
  /** Auto-generated document ID (UUIDv7) */
  _id: string;
  /** Creation timestamp */
  _created: string;
  /** Last update timestamp */
  _updated: string;
  /** Document version (incremented on update) */
  _version: number;
  /** User-defined fields */
  [key: string]: unknown;
}

export interface CollectionOptions {
  /** Collection name */
  name: string;
  /** Schema definition (optional) */
  schema?: SchemaDefinition;
  /** Fields to index */
  indexes?: IndexDefinition[];
  /** Max document size in bytes (default: 1MB) */
  maxDocSize?: number;
  /** Enable timestamps (default: true) */
  timestamps?: boolean;
  /** Custom ID generator */
  idGenerator?: () => string;
}

export interface SchemaDefinition {
  /** Fields and their types */
  fields: Record<string, FieldDefinition>;
  /** Required fields */
  required?: string[];
  /** Allow additional fields beyond schema */
  additionalProperties?: boolean;
}

export interface FieldDefinition {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'date' | 'binary';
  /** Optional: default value */
  default?: unknown;
  /** Optional: min value (number) or min length (string/array) */
  min?: number;
  /** Optional: max value (number) or max length (string/array) */
  max?: number;
  /** Optional: regex pattern (string) */
  pattern?: string;
  /** Optional: enum values */
  enum?: unknown[];
  /** Optional: for arrays, item type */
  items?: FieldDefinition;
  /** Optional: for objects, nested schema */
  properties?: Record<string, FieldDefinition>;
}

export interface IndexDefinition {
  /** Fields to index */
  fields: string[];
  /** Unique constraint */
  unique?: boolean;
  /** Index name */
  name?: string;
  /** Sparse index (exclude docs without field) */
  sparse?: boolean;
}

export interface IndexData {
  /** Index name */
  name: string;
  /** Field values → document IDs mapping */
  entries: Map<string, Set<string>>;
  /** Index metadata */
  fields: string[];
  unique: boolean;
  sparse: boolean;
}

// ─── Query Types ─────────────────────────────────────────────────────────────

export type QueryFilter = {
  [key: string]: QueryValue | QueryOperator;
};

export type QueryValue = string | number | boolean | null | Date;

export interface QueryOperator {
  $eq?: QueryValue;
  $ne?: QueryValue;
  $gt?: number | string | Date;
  $gte?: number | string | Date;
  $lt?: number | string | Date;
  $lte?: number | string | Date;
  $in?: QueryValue[];
  $nin?: QueryValue[];
  $exists?: boolean;
  $type?: string;
  $regex?: string;
  $contains?: string;
  $startsWith?: string;
  $endsWith?: string;
  $elemMatch?: QueryFilter;
  $size?: number;
  $not?: QueryOperator;
  $and?: QueryFilter[];
  $or?: QueryFilter[];
}

export interface QueryOptions {
  /** Fields to return (projection) */
  fields?: string[];
  /** Sort specification */
  sort?: Record<string, 1 | -1>;
  /** Number of documents to skip */
  skip?: number;
  /** Max number of documents to return */
  limit?: number;
  /** Include total count in response */
  count?: boolean;
}

export interface QueryResult<T = Document> {
  /** Matching documents */
  docs: T[];
  /** Total count (if requested) */
  total?: number;
  /** Whether there are more results */
  hasMore: boolean;
  /** Query execution time in ms */
  executionTime: number;
}

export interface UpdateOperator {
  $set?: Record<string, unknown>;
  $unset?: Record<string, true>;
  $inc?: Record<string, number>;
  $push?: Record<string, unknown>;
  $pull?: Record<string, unknown>;
  $addToSet?: Record<string, unknown>;
  $rename?: Record<string, string>;
  $min?: Record<string, number>;
  $max?: Record<string, number>;
}

// ─── Binary Storage Types ────────────────────────────────────────────────────

export interface BinaryMetadata {
  /** Unique file ID */
  id: string;
  /** Original filename */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** Total file size in bytes */
  size: number;
  /** Number of chunks */
  chunkCount: number;
  /** Chunk size in bytes */
  chunkSize: number;
  /** SHA-256 hash of original file */
  hash: string;
  /** Upload timestamp */
  uploadedAt: string;
  /** Optional user-defined metadata */
  metadata?: Record<string, unknown>;
  /** Which repo stores this file */
  repo: string;
  /** Width (for images) */
  width?: number;
  /** Height (for images) */
  height?: number;
}

export interface BinaryChunk {
  /** Chunk index */
  index: number;
  /** Chunk data (encrypted) */
  data: Uint8Array;
  /** SHA of this chunk's blob in Git */
  sha: string;
}

export interface UploadOptions {
  /** Custom filename */
  filename?: string;
  /** MIME type (auto-detected if not provided) */
  mimeType?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Chunk size in bytes (default: 512KB) */
  chunkSize?: number;
  /** Progress callback */
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadProgress {
  /** Bytes uploaded so far */
  bytesUploaded: number;
  /** Total bytes */
  totalBytes: number;
  /** Percentage (0-100) */
  percentage: number;
  /** Current chunk being uploaded */
  currentChunk: number;
  /** Total chunks */
  totalChunks: number;
}

export interface DownloadOptions {
  /** Progress callback */
  onProgress?: (progress: DownloadProgress) => void;
  /** Range request (partial download) */
  range?: { start: number; end: number };
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
  currentChunk: number;
  totalChunks: number;
}

// ─── Transaction Types ───────────────────────────────────────────────────────

export interface TransactionOptions {
  /** Max retries on conflict (default: 3) */
  maxRetries?: number;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
  /** Conflict resolution strategy */
  conflictStrategy?: 'retry' | 'abort' | 'merge' | 'custom';
  /** Custom merge function */
  mergeFn?: (local: Document, remote: Document) => Document;
  /** Isolation level */
  isolation?: 'read-committed' | 'serializable';
}

export interface TransactionContext {
  /** Transaction ID */
  id: string;
  /** Start timestamp */
  startedAt: number;
  /** HEAD SHA at transaction start */
  baseSha: string;
  /** Pending writes */
  pendingWrites: Map<string, PendingWrite>;
  /** Read set (for conflict detection) */
  readSet: Map<string, string>;
  /** Transaction status */
  status: 'active' | 'committed' | 'aborted' | 'conflict';
}

export interface PendingWrite {
  type: 'insert' | 'update' | 'delete';
  collection: string;
  documentId: string;
  data?: Record<string, unknown>;
  previousSha?: string;
}

// ─── Event Types ─────────────────────────────────────────────────────────────

export type GitnixEvent =
  | { type: 'connected'; repo: string }
  | { type: 'disconnected'; reason?: string }
  | { type: 'sync:start'; collections: string[] }
  | { type: 'sync:complete'; duration: number }
  | { type: 'sync:error'; error: Error }
  | { type: 'cache:hit'; key: string }
  | { type: 'cache:miss'; key: string }
  | { type: 'cache:evict'; key: string; reason: string }
  | { type: 'ratelimit:warning'; remaining: number; reset: number }
  | { type: 'ratelimit:exceeded'; retryAfter: number }
  | { type: 'storage:overflow'; repo: string; newRepo: string }
  | { type: 'conflict:detected'; collection: string; documentId: string }
  | { type: 'conflict:resolved'; strategy: string }
  | { type: 'error'; error: Error; context?: string };

export type EventListener = (event: GitnixEvent) => void;

// ─── Error Types ─────────────────────────────────────────────────────────────

export class GitnixError extends Error {
  constructor(
    message: string,
    public code: GitnixErrorCode,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GitnixError';
  }
}

export enum GitnixErrorCode {
  // Transport errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  AUTH_FAILED = 'AUTH_FAILED',
  REPO_NOT_FOUND = 'REPO_NOT_FOUND',
  API_ERROR = 'API_ERROR',

  // Encryption errors
  ENCRYPTION_FAILED = 'ENCRYPTION_FAILED',
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  INVALID_PASSWORD = 'INVALID_PASSWORD',
  KEY_NOT_FOUND = 'KEY_NOT_FOUND',
  KDF_FAILED = 'KDF_FAILED',

  // Storage errors
  STORAGE_FULL = 'STORAGE_FULL',
  REPO_OVERFLOW = 'REPO_OVERFLOW',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',

  // Collection errors
  COLLECTION_NOT_FOUND = 'COLLECTION_NOT_FOUND',
  DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
  DUPLICATE_ID = 'DUPLICATE_ID',
  SCHEMA_VIOLATION = 'SCHEMA_VIOLATION',
  VALIDATION_ERROR = 'VALIDATION_ERROR',

  // Query errors
  INVALID_QUERY = 'INVALID_QUERY',
  INVALID_OPERATOR = 'INVALID_OPERATOR',

  // Transaction errors
  TRANSACTION_CONFLICT = 'TRANSACTION_CONFLICT',
  TRANSACTION_TIMEOUT = 'TRANSACTION_TIMEOUT',
  TRANSACTION_ABORTED = 'TRANSACTION_ABORTED',

  // Binary errors
  CHUNK_MISSING = 'CHUNK_MISSING',
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
  INVALID_FILE_TYPE = 'INVALID_FILE_TYPE',

  // General
  NOT_CONNECTED = 'NOT_CONNECTED',
  ALREADY_CONNECTED = 'ALREADY_CONNECTED',
  INVALID_CONFIG = 'INVALID_CONFIG',
}
