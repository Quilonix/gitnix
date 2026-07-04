"""Gitnix SDK - Transport Layer.

GitHub Git Data API client using httpx for async HTTP.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from gitnix.errors import GitnixError, GitnixErrorCode
from gitnix.rate_limiter import RateLimiter


class Transport:
    """Full GitHub Git Data API client."""

    def __init__(
        self,
        token: str,
        repo: str,
        branch: str,
        api_base_url: str,
        rate_limiter: RateLimiter,
    ) -> None:
        self._token = token
        self._repo = repo
        self._branch = branch
        self._api_base_url = api_base_url
        self._rate_limiter = rate_limiter
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=30.0,
        )

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    # ─── Low-level HTTP ──────────────────────────────────────────────────

    async def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        repo: str | None = None,
    ) -> dict[str, Any]:
        """Make an authenticated request to GitHub API."""
        target_repo = repo or self._repo
        url = f"{self._api_base_url}/repos/{target_repo}{path}"
        is_write = method != "GET"

        async def execute() -> dict[str, Any]:
            kwargs: dict[str, Any] = {"method": method, "url": url}
            if body is not None:
                kwargs["json"] = body

            response = await self._client.request(**kwargs)

            # Update rate limiter from headers
            self._rate_limiter.update_from_headers(dict(response.headers))

            # Handle errors
            if response.status_code == 429 or (
                response.status_code == 403
                and int(response.headers.get("x-ratelimit-remaining", "1")) == 0
            ):
                raise GitnixError(
                    "Rate limited",
                    GitnixErrorCode.RATE_LIMITED,
                    {"retry_after": response.headers.get("retry-after")},
                )

            if response.status_code == 401:
                raise GitnixError("Authentication failed", GitnixErrorCode.AUTH_FAILED)

            if response.status_code == 404:
                raise GitnixError(
                    f"Not found: {path}",
                    GitnixErrorCode.REPO_NOT_FOUND,
                    {"path": path, "repo": target_repo},
                )

            if not response.is_success:
                raise GitnixError(
                    f"GitHub API error ({response.status_code}): {response.text}",
                    GitnixErrorCode.API_ERROR,
                    {"status": response.status_code},
                )

            if response.status_code == 204:
                return {}
            return response.json()  # type: ignore[no-any-return]

        return await self._rate_limiter.execute(execute, is_write=is_write)

    # ─── Git Blobs ───────────────────────────────────────────────────────

    async def create_blob(
        self, content: str, encoding: str = "base64", repo: str | None = None
    ) -> dict[str, Any]:
        """Create a blob (stores encrypted data)."""
        return await self.request(
            "POST", "/git/blobs", {"content": content, "encoding": encoding}, repo
        )

    async def get_blob(self, sha: str, repo: str | None = None) -> dict[str, Any]:
        """Get a blob's content."""
        return await self.request("GET", f"/git/blobs/{sha}", repo=repo)

    # ─── Git Trees ───────────────────────────────────────────────────────

    async def get_tree(
        self, sha: str, recursive: bool = True, repo: str | None = None
    ) -> dict[str, Any]:
        """Get a tree (list all files)."""
        path = f"/git/trees/{sha}?recursive=1" if recursive else f"/git/trees/{sha}"
        return await self.request("GET", path, repo=repo)

    async def create_tree(
        self, tree_data: dict[str, Any], repo: str | None = None
    ) -> dict[str, Any]:
        """Create a new tree."""
        return await self.request("POST", "/git/trees", tree_data, repo)

    # ─── Git Commits ─────────────────────────────────────────────────────

    async def get_commit(self, sha: str, repo: str | None = None) -> dict[str, Any]:
        """Get a commit."""
        return await self.request("GET", f"/git/commits/{sha}", repo=repo)

    async def create_commit(
        self, data: dict[str, Any], repo: str | None = None
    ) -> dict[str, Any]:
        """Create a new commit."""
        return await self.request("POST", "/git/commits", data, repo)

    # ─── Git Refs ────────────────────────────────────────────────────────

    async def get_ref(
        self, branch: str | None = None, repo: str | None = None
    ) -> dict[str, Any]:
        """Get a ref (branch pointer)."""
        branch_name = branch or self._branch
        return await self.request("GET", f"/git/ref/heads/{branch_name}", repo=repo)

    async def update_ref(
        self, sha: str, force: bool = False, branch: str | None = None, repo: str | None = None
    ) -> dict[str, Any]:
        """Update a ref."""
        branch_name = branch or self._branch
        return await self.request(
            "PATCH", f"/git/refs/heads/{branch_name}", {"sha": sha, "force": force}, repo
        )

    # ─── Repository Operations ───────────────────────────────────────────

    async def get_repo_info(self, repo: str | None = None) -> dict[str, Any]:
        """Get repository info."""
        return await self.request("GET", "", repo=repo)

    async def repo_exists(self, repo: str | None = None) -> bool:
        """Check if repo exists."""
        try:
            await self.get_repo_info(repo)
            return True
        except GitnixError:
            return False

    # ─── Batch Operations ────────────────────────────────────────────────

    async def batch_write(
        self,
        operations: list[dict[str, Any]],
        message: str,
        repo: str | None = None,
    ) -> dict[str, str]:
        """Atomic batch write: blobs → tree → commit → update ref."""
        # 1. Get current HEAD
        ref = await self.get_ref(repo=repo)
        head_sha = ref["object"]["sha"]
        commit = await self.get_commit(head_sha, repo)
        base_tree_sha = commit["tree"]["sha"]

        # 2. Create blobs in parallel
        write_ops = [op for op in operations if not op.get("delete")]
        blob_tasks = [
            self.create_blob(op["content"], op.get("encoding", "base64"), repo)
            for op in write_ops
        ]
        blob_results = await asyncio.gather(*blob_tasks)

        # 3. Build tree entries
        tree_entries = []
        for op, blob in zip(write_ops, blob_results):
            tree_entries.append({
                "path": op["path"],
                "mode": "100644",
                "type": "blob",
                "sha": blob["sha"],
            })

        for op in operations:
            if op.get("delete"):
                tree_entries.append({
                    "path": op["path"],
                    "mode": "100644",
                    "type": "blob",
                    "sha": None,
                })

        # 4. Create tree
        tree = await self.create_tree({"base_tree": base_tree_sha, "tree": tree_entries}, repo)

        # 5. Create commit
        new_commit = await self.create_commit(
            {
                "message": message,
                "tree": tree["sha"],
                "parents": [head_sha],
                "author": {"name": "Gitnix", "email": "gitnix@automated.dev"},
            },
            repo,
        )

        # 6. Update ref
        await self.update_ref(new_commit["sha"], repo=repo)

        return {"commit_sha": new_commit["sha"], "tree_sha": tree["sha"]}

    async def list_files(
        self, path: str | None = None, repo: str | None = None
    ) -> list[dict[str, Any]]:
        """List all files at a path."""
        ref = await self.get_ref(repo=repo)
        commit = await self.get_commit(ref["object"]["sha"], repo)
        tree = await self.get_tree(commit["tree"]["sha"], recursive=True, repo=repo)

        entries = [e for e in tree["tree"] if e["type"] == "blob"]
        if path:
            entries = [e for e in entries if e["path"].startswith(path)]

        return entries

    async def get_head_sha(self, repo: str | None = None) -> str:
        """Get current HEAD SHA."""
        ref = await self.get_ref(repo=repo)
        return ref["object"]["sha"]  # type: ignore[no-any-return]

    @property
    def repo(self) -> str:
        return self._repo

    @repo.setter
    def repo(self, value: str) -> None:
        self._repo = value
