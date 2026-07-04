/**
 * Gitnix SDK - Storage Manager
 *
 * Multi-repo orchestration:
 * - Tracks storage usage across repos
 * - Automatically creates overflow repos when limit approached
 * - Routes reads/writes to correct repo
 * - Maintains a manifest of collection→repo mappings
 * - Handles repo creation and initialization
 */

import type { MultiRepoManifest, RepoInfo, StorageAllocation } from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';
import type { Transport } from './transport.js';
import type { KeyManager } from '../crypto/keys.js';
import type { Cache } from './cache.js';

/** GitHub repo size limit ~5GB, we trigger overflow at 4GB */
const REPO_SIZE_THRESHOLD = 4 * 1024 * 1024 * 1024; // 4 GB

/** Single file limit */
const FILE_SIZE_LIMIT = 100 * 1024 * 1024; // 100 MB

/** Recommended file size for performance */
const RECOMMENDED_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/** Path where the manifest is stored */
const MANIFEST_PATH = '.gitnix/manifest.enc';

export class StorageManager {
  private transport: Transport;
  private keyManager: KeyManager;
  private cache: Cache;
  private manifest: MultiRepoManifest;
  private overflowRepos: string[];
  private primaryRepo: string;

  constructor(
    transport: Transport,
    keyManager: KeyManager,
    cache: Cache,
    primaryRepo: string,
    overflowRepos: string[] = [],
  ) {
    this.transport = transport;
    this.keyManager = keyManager;
    this.cache = cache;
    this.primaryRepo = primaryRepo;
    this.overflowRepos = overflowRepos;

    this.manifest = {
      version: 1,
      primary: primaryRepo,
      repos: [],
      collectionMap: {},
      totalUsed: 0,
      totalAvailable: 0,
      updatedAt: Date.now(),
    };
  }

  // ─── Initialization ────────────────────────────────────────────────────

  /**
   * Load or create the storage manifest
   */
  async initialize(): Promise<void> {
    try {
      // Try to load existing manifest
      const files = await this.transport.listFiles('.gitnix', this.primaryRepo);
      const manifestFile = files.find((f) => f.path === MANIFEST_PATH);

      if (manifestFile) {
        const blob = await this.transport.getBlob(manifestFile.sha, this.primaryRepo);
        const decrypted = this.keyManager.decryptForCollection<MultiRepoManifest>(
          '__system__',
          blob.content,
        );
        this.manifest = decrypted;
      } else {
        // First time setup - probe repos
        await this.probeRepos();
        await this.saveManifest();
      }
    } catch (error) {
      // If repo doesn't exist or is empty, initialize fresh
      if (error instanceof GitnixError && error.code === GitnixErrorCode.REPO_NOT_FOUND) {
        await this.probeRepos();
      } else {
        throw error;
      }
    }
  }

  /**
   * Probe all repos for size information
   */
  private async probeRepos(): Promise<void> {
    const repos: RepoInfo[] = [];

    // Probe primary repo
    try {
      const info = await this.transport.getRepoInfo(this.primaryRepo);
      repos.push({
        name: this.primaryRepo,
        currentSize: info.size,
        maxSize: REPO_SIZE_THRESHOLD,
        collectionCount: 0,
        isPrimary: true,
        lastSync: Date.now(),
      });
    } catch {
      // Repo might not exist yet
      repos.push({
        name: this.primaryRepo,
        currentSize: 0,
        maxSize: REPO_SIZE_THRESHOLD,
        collectionCount: 0,
        isPrimary: true,
        lastSync: Date.now(),
      });
    }

    // Probe overflow repos
    for (const repo of this.overflowRepos) {
      try {
        const info = await this.transport.getRepoInfo(repo);
        repos.push({
          name: repo,
          currentSize: info.size,
          maxSize: REPO_SIZE_THRESHOLD,
          collectionCount: 0,
          isPrimary: false,
          lastSync: Date.now(),
        });
      } catch {
        // Will be created when needed
      }
    }

    this.manifest = {
      version: 1,
      primary: this.primaryRepo,
      repos,
      collectionMap: {},
      totalUsed: repos.reduce((sum, r) => sum + r.currentSize, 0),
      totalAvailable: repos.reduce((sum, r) => sum + (r.maxSize - r.currentSize), 0),
      updatedAt: Date.now(),
    };
  }

  // ─── Allocation ────────────────────────────────────────────────────────

  /**
   * Get the repo where a collection should be stored.
   * Creates overflow repo if needed.
   */
  async getAllocation(collectionId: string, dataSize: number): Promise<StorageAllocation> {
    // Check if collection already has an assigned repo
    const existingRepo = this.manifest.collectionMap[collectionId];
    if (existingRepo) {
      const repoInfo = this.manifest.repos.find((r) => r.name === existingRepo);
      if (repoInfo && repoInfo.currentSize + dataSize < repoInfo.maxSize) {
        return {
          repo: existingRepo,
          path: this.getCollectionPath(collectionId),
          availableSpace: repoInfo.maxSize - repoInfo.currentSize,
        };
      }
    }

    // Find a repo with enough space
    const target = this.manifest.repos.find(
      (r) => r.currentSize + dataSize < r.maxSize,
    );

    if (target) {
      this.manifest.collectionMap[collectionId] = target.name;
      return {
        repo: target.name,
        path: this.getCollectionPath(collectionId),
        availableSpace: target.maxSize - target.currentSize,
      };
    }

    // No space anywhere - create overflow repo
    const newRepo = await this.createOverflowRepo();
    this.manifest.collectionMap[collectionId] = newRepo;
    return {
      repo: newRepo,
      path: this.getCollectionPath(collectionId),
      availableSpace: REPO_SIZE_THRESHOLD,
    };
  }

  /**
   * Get the repo for reading a collection
   */
  getCollectionRepo(collectionId: string): string {
    return this.manifest.collectionMap[collectionId] ?? this.primaryRepo;
  }

  /**
   * Get the file path for a collection within a repo
   */
  getCollectionPath(collectionId: string): string {
    const hashedName = this.keyManager.hashCollectionName(collectionId);
    return `collections/${hashedName}`;
  }

  /**
   * Get the file path for a document within a collection
   */
  getDocumentPath(collectionId: string, documentId: string): string {
    const collPath = this.getCollectionPath(collectionId);
    const hashedId = this.keyManager.hashDocumentId(collectionId, documentId);
    return `${collPath}/${hashedId}.enc`;
  }

  /**
   * Get the index path for a collection
   */
  getIndexPath(collectionId: string): string {
    const collPath = this.getCollectionPath(collectionId);
    return `${collPath}/_index.enc`;
  }

  // ─── Overflow Management ───────────────────────────────────────────────

  /**
   * Create a new overflow repository
   */
  private async createOverflowRepo(): Promise<string> {
    const [owner] = this.primaryRepo.split('/');
    const timestamp = Date.now().toString(36);
    const repoName = `gitnix-overflow-${timestamp}`;

    try {
      const created = await this.transport.createRepo(repoName, true);
      const fullName = created.full_name;

      // Add to manifest
      this.manifest.repos.push({
        name: fullName,
        currentSize: 0,
        maxSize: REPO_SIZE_THRESHOLD,
        collectionCount: 0,
        isPrimary: false,
        lastSync: Date.now(),
      });

      this.manifest.totalAvailable += REPO_SIZE_THRESHOLD;
      this.manifest.updatedAt = Date.now();

      // Save updated manifest
      await this.saveManifest();

      return fullName;
    } catch (error) {
      throw new GitnixError(
        `Failed to create overflow repo: ${error instanceof Error ? error.message : 'unknown'}`,
        GitnixErrorCode.STORAGE_FULL,
      );
    }
  }

  /**
   * Update storage usage for a repo
   */
  updateUsage(repo: string, bytesAdded: number): void {
    const repoInfo = this.manifest.repos.find((r) => r.name === repo);
    if (repoInfo) {
      repoInfo.currentSize += bytesAdded;
      this.manifest.totalUsed += bytesAdded;
      this.manifest.totalAvailable -= bytesAdded;
      this.manifest.updatedAt = Date.now();
    }
  }

  // ─── Manifest Persistence ──────────────────────────────────────────────

  /**
   * Save the manifest to the primary repo
   */
  async saveManifest(): Promise<void> {
    const encrypted = this.keyManager.encryptForCollection('__system__', this.manifest);

    await this.transport.batchWrite(
      [{ path: MANIFEST_PATH, content: encrypted, encoding: 'base64' }],
      'gitnix: update storage manifest',
      this.primaryRepo,
    );
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /**
   * Get storage info across all repos
   */
  getStorageInfo(): {
    totalUsed: number;
    totalAvailable: number;
    repos: RepoInfo[];
    collectionCount: number;
  } {
    return {
      totalUsed: this.manifest.totalUsed,
      totalAvailable: this.manifest.totalAvailable,
      repos: [...this.manifest.repos],
      collectionCount: Object.keys(this.manifest.collectionMap).length,
    };
  }

  /**
   * Check if a specific file would exceed limits
   */
  validateFileSize(size: number): void {
    if (size > FILE_SIZE_LIMIT) {
      throw new GitnixError(
        `File size ${size} exceeds GitHub limit of ${FILE_SIZE_LIMIT} bytes`,
        GitnixErrorCode.FILE_TOO_LARGE,
        { size, limit: FILE_SIZE_LIMIT },
      );
    }
    if (size > RECOMMENDED_FILE_SIZE) {
      // Just a warning - could log this
    }
  }

  /**
   * Get the manifest (for debugging/inspection)
   */
  getManifest(): Readonly<MultiRepoManifest> {
    return { ...this.manifest };
  }

  /**
   * Check if we're approaching storage limits
   */
  isNearCapacity(threshold = 0.9): boolean {
    if (this.manifest.totalAvailable <= 0) return true;
    const usage =
      this.manifest.totalUsed / (this.manifest.totalUsed + this.manifest.totalAvailable);
    return usage >= threshold;
  }
}
