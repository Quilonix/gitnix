/**
 * Gitnix SDK - Transport Layer
 *
 * Full GitHub Git Data API client using native fetch.
 * Handles: blobs, trees, commits, refs, repo operations.
 * Integrates with rate limiter for all requests.
 */

import type {
  CreateBlobRequest,
  CreateCommitRequest,
  CreateTreeRequest,
  GitHubBlob,
  GitHubCommit,
  GitHubRef,
  GitHubTree,
  TransportRequestOptions,
  TransportResponse,
  UpdateRefRequest,
} from '../types/index.js';
import { GitnixError, GitnixErrorCode } from '../types/index.js';
import { RateLimiter } from './rate-limiter.js';

export interface TransportConfig {
  token: string;
  repo: string;
  branch: string;
  apiBaseUrl: string;
  rateLimiter: RateLimiter;
}

export class Transport {
  private token: string;
  private repo: string;
  private branch: string;
  private apiBaseUrl: string;
  private rateLimiter: RateLimiter;

  constructor(config: TransportConfig) {
    this.token = config.token;
    this.repo = config.repo;
    this.branch = config.branch;
    this.apiBaseUrl = config.apiBaseUrl;
    this.rateLimiter = config.rateLimiter;
  }

  // ─── Low-level HTTP ──────────────────────────────────────────────────────

  /**
   * Make an authenticated request to GitHub API
   */
  async request<T>(options: TransportRequestOptions): Promise<TransportResponse<T>> {
    const repo = options.repo ?? this.repo;
    const url = `${this.apiBaseUrl}/repos/${repo}${options.path}`;
    const isWrite = options.method !== 'GET';

    const execute = async (): Promise<TransportResponse<T>> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      };

      if (options.body) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      // Parse rate limit headers
      const rateLimit = {
        limit: parseInt(response.headers.get('x-ratelimit-limit') ?? '5000', 10),
        remaining: parseInt(response.headers.get('x-ratelimit-remaining') ?? '5000', 10),
        reset: parseInt(response.headers.get('x-ratelimit-reset') ?? '0', 10),
        used: parseInt(response.headers.get('x-ratelimit-used') ?? '0', 10),
      };

      // Update rate limiter state
      const headerMap: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headerMap[key.toLowerCase()] = value;
      });
      this.rateLimiter.updateFromHeaders(headerMap);

      // Handle errors
      if (!response.ok) {
        if (response.status === 429 || (response.status === 403 && rateLimit.remaining === 0)) {
          throw new GitnixError(
            `Rate limited. Resets at ${new Date(rateLimit.reset * 1000).toISOString()}`,
            GitnixErrorCode.RATE_LIMITED,
            { retryAfter: rateLimit.reset - Math.floor(Date.now() / 1000) },
          );
        }

        if (response.status === 401) {
          throw new GitnixError('Authentication failed', GitnixErrorCode.AUTH_FAILED);
        }

        if (response.status === 404) {
          throw new GitnixError(
            `Not found: ${options.path}`,
            GitnixErrorCode.REPO_NOT_FOUND,
            { path: options.path, repo },
          );
        }

        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new GitnixError(
          `GitHub API error (${response.status}): ${errorBody}`,
          GitnixErrorCode.API_ERROR,
          { status: response.status, body: errorBody },
        );
      }

      const data = response.status === 204 ? (null as T) : ((await response.json()) as T);

      return {
        data,
        status: response.status,
        headers: headerMap,
        rateLimit,
      };
    };

    return this.rateLimiter.executeWithRetry(execute, { isWrite });
  }

  // ─── Git Blobs ──────────────────────────────────────────────────────────

  /**
   * Create a blob (stores encrypted data)
   */
  async createBlob(content: string, encoding: 'utf-8' | 'base64' = 'base64', repo?: string): Promise<GitHubBlob> {
    const body: CreateBlobRequest = { content, encoding };
    const response = await this.request<GitHubBlob>({
      method: 'POST',
      path: '/git/blobs',
      body,
      repo,
    });
    return response.data;
  }

  /**
   * Get a blob's content
   */
  async getBlob(sha: string, repo?: string): Promise<{ content: string; size: number; sha: string }> {
    const response = await this.request<{ content: string; encoding: string; size: number; sha: string }>({
      method: 'GET',
      path: `/git/blobs/${sha}`,
      repo,
    });
    return {
      content: response.data.content,
      size: response.data.size,
      sha: response.data.sha,
    };
  }

  // ─── Git Trees ──────────────────────────────────────────────────────────

  /**
   * Get a tree (list all files/entries in a directory)
   */
  async getTree(sha: string, recursive = true, repo?: string): Promise<GitHubTree> {
    const path = recursive ? `/git/trees/${sha}?recursive=1` : `/git/trees/${sha}`;
    const response = await this.request<GitHubTree>({
      method: 'GET',
      path,
      repo,
    });
    return response.data;
  }

  /**
   * Create a new tree (batch file operations)
   */
  async createTree(treeData: CreateTreeRequest, repo?: string): Promise<GitHubTree> {
    const response = await this.request<GitHubTree>({
      method: 'POST',
      path: '/git/trees',
      body: treeData,
      repo,
    });
    return response.data;
  }

  // ─── Git Commits ────────────────────────────────────────────────────────

  /**
   * Get a commit
   */
  async getCommit(sha: string, repo?: string): Promise<GitHubCommit> {
    const response = await this.request<GitHubCommit>({
      method: 'GET',
      path: `/git/commits/${sha}`,
      repo,
    });
    return response.data;
  }

  /**
   * Create a new commit
   */
  async createCommit(data: CreateCommitRequest, repo?: string): Promise<GitHubCommit> {
    const response = await this.request<GitHubCommit>({
      method: 'POST',
      path: '/git/commits',
      body: data,
      repo,
    });
    return response.data;
  }

  // ─── Git Refs ───────────────────────────────────────────────────────────

  /**
   * Get a ref (branch pointer)
   */
  async getRef(branch?: string, repo?: string): Promise<GitHubRef> {
    const branchName = branch ?? this.branch;
    const response = await this.request<GitHubRef>({
      method: 'GET',
      path: `/git/ref/heads/${branchName}`,
      repo,
    });
    return response.data;
  }

  /**
   * Update a ref (move branch pointer)
   */
  async updateRef(sha: string, force = false, branch?: string, repo?: string): Promise<GitHubRef> {
    const branchName = branch ?? this.branch;
    const body: UpdateRefRequest = { sha, force };
    const response = await this.request<GitHubRef>({
      method: 'PATCH',
      path: `/git/refs/heads/${branchName}`,
      body,
      repo,
    });
    return response.data;
  }

  /**
   * Create a ref (new branch)
   */
  async createRef(sha: string, branch: string, repo?: string): Promise<GitHubRef> {
    const response = await this.request<GitHubRef>({
      method: 'POST',
      path: '/git/refs',
      body: { ref: `refs/heads/${branch}`, sha },
      repo,
    });
    return response.data;
  }

  // ─── Repository Operations ──────────────────────────────────────────────

  /**
   * Get repository info (size, default branch, etc.)
   */
  async getRepoInfo(repo?: string): Promise<{
    size: number;
    defaultBranch: string;
    private: boolean;
    full_name: string;
  }> {
    const repoName = repo ?? this.repo;
    const response = await this.request<{
      size: number;
      default_branch: string;
      private: boolean;
      full_name: string;
    }>({
      method: 'GET',
      path: '',
      repo: repoName,
    });
    return {
      size: response.data.size * 1024, // GitHub returns size in KB
      defaultBranch: response.data.default_branch,
      private: response.data.private,
      full_name: response.data.full_name,
    };
  }

  /**
   * Create a new repository (for overflow)
   */
  async createRepo(name: string, isPrivate = true): Promise<{ full_name: string; clone_url: string }> {
    const [owner] = this.repo.split('/');
    const url = `${this.apiBaseUrl}/user/repos`;

    const execute = async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          name,
          private: isPrivate,
          description: `Gitnix overflow storage (managed by ${this.repo})`,
          auto_init: true,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new GitnixError(
          `Failed to create repo: ${error}`,
          GitnixErrorCode.API_ERROR,
          { status: response.status },
        );
      }

      const data = await response.json() as { full_name: string; clone_url: string };
      return data;
    };

    return this.rateLimiter.executeWithRetry(execute, { isWrite: true });
  }

  /**
   * Check if repo exists and is accessible
   */
  async repoExists(repo?: string): Promise<boolean> {
    try {
      await this.getRepoInfo(repo);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Batch Operations ───────────────────────────────────────────────────

  /**
   * Atomic batch write: create multiple blobs, build tree, commit, update ref.
   * This is the core "write N records in 1 commit" operation.
   */
  async batchWrite(
    operations: Array<{
      path: string;
      content: string;
      encoding?: 'utf-8' | 'base64';
      delete?: boolean;
    }>,
    message: string,
    repo?: string,
  ): Promise<{ commitSha: string; treeSha: string }> {
    // 1. Get current HEAD
    const ref = await this.getRef(undefined, repo);
    const headSha = ref.object.sha;
    const commit = await this.getCommit(headSha, repo);
    const baseTreeSha = commit.tree.sha;

    // 2. Create blobs for all new/updated content in parallel
    const blobResults = await Promise.all(
      operations
        .filter((op) => !op.delete)
        .map(async (op) => {
          const blob = await this.createBlob(op.content, op.encoding ?? 'base64', repo);
          return { path: op.path, sha: blob.sha };
        }),
    );

    // 3. Build tree entries
    const treeEntries = [
      ...blobResults.map((b) => ({
        path: b.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: b.sha,
      })),
      ...operations
        .filter((op) => op.delete)
        .map((op) => ({
          path: op.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: null,
        })),
    ];

    // 4. Create tree
    const tree = await this.createTree(
      { base_tree: baseTreeSha, tree: treeEntries },
      repo,
    );

    // 5. Create commit
    const newCommit = await this.createCommit(
      {
        message,
        tree: tree.sha,
        parents: [headSha],
        author: {
          name: 'Gitnix',
          email: 'gitnix@automated.dev',
          date: new Date().toISOString(),
        },
      },
      repo,
    );

    // 6. Update ref (fast-forward)
    await this.updateRef(newCommit.sha, false, undefined, repo);

    return { commitSha: newCommit.sha, treeSha: tree.sha };
  }

  /**
   * Read all file entries from a path in the repo
   */
  async listFiles(path?: string, repo?: string): Promise<Array<{ path: string; sha: string; size: number }>> {
    const ref = await this.getRef(undefined, repo);
    const commit = await this.getCommit(ref.object.sha, repo);
    const tree = await this.getTree(commit.tree.sha, true, repo);

    let entries = tree.tree.filter((e) => e.type === 'blob');
    if (path) {
      entries = entries.filter((e) => e.path.startsWith(path));
    }

    return entries.map((e) => ({
      path: e.path,
      sha: e.sha,
      size: e.size ?? 0,
    }));
  }

  // ─── Utilities ──────────────────────────────────────────────────────────

  /**
   * Get current HEAD SHA
   */
  async getHeadSha(repo?: string): Promise<string> {
    const ref = await this.getRef(undefined, repo);
    return ref.object.sha;
  }

  /**
   * Compare-and-swap: only update if HEAD hasn't moved
   */
  async compareAndSwap(
    expectedSha: string,
    newSha: string,
    repo?: string,
  ): Promise<boolean> {
    try {
      const currentRef = await this.getRef(undefined, repo);
      if (currentRef.object.sha !== expectedSha) {
        return false; // Conflict
      }
      await this.updateRef(newSha, false, undefined, repo);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Switch the target repo (for multi-repo support)
   */
  setRepo(repo: string): void {
    this.repo = repo;
  }

  /**
   * Get current repo
   */
  getRepo(): string {
    return this.repo;
  }

  /**
   * Get current branch
   */
  getBranch(): string {
    return this.branch;
  }
}
