"""Gitnix SDK - Collection Manager.

Full CRUD operations on encrypted document collections.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from gitnix.errors import GitnixError, GitnixErrorCode
from gitnix.query import QueryEngine
from gitnix.types import (
    CollectionOptions,
    Document,
    QueryFilter,
    QueryOptions,
    QueryResult,
    UpdateOperator,
)


class Collection:
    """A collection of encrypted documents stored in a GitHub repo."""

    def __init__(
        self,
        name: str,
        transport: Any,
        cache: Any,
        storage_manager: Any,
        key_manager: Any,
        options: CollectionOptions | None = None,
    ) -> None:
        self.name = name
        self._transport = transport
        self._cache = cache
        self._storage_manager = storage_manager
        self._key_manager = key_manager
        self._query_engine = QueryEngine()
        self._documents: dict[str, Document] = {}
        self._dirty: set[str] = set()
        self._loaded = False
        self._options = options

    # ─── Load/Sync ───────────────────────────────────────────────────────

    async def load(self) -> None:
        """Load all documents from remote."""
        if self._loaded:
            return

        repo = self._storage_manager.get_collection_repo(self.name)
        coll_path = self._storage_manager.get_collection_path(self.name)

        try:
            files = await self._transport.list_files(coll_path, repo)
            doc_files = [f for f in files if f["path"].endswith(".enc") and "_index" not in f["path"]]

            for file in doc_files:
                blob = await self._transport.get_blob(file["sha"], repo)
                doc = self._key_manager.decrypt_for_collection(self.name, blob["content"])
                self._documents[doc["_id"]] = doc

            self._loaded = True
        except GitnixError as e:
            if e.code == GitnixErrorCode.REPO_NOT_FOUND:
                self._loaded = True
            else:
                raise

    async def sync(self) -> dict[str, int]:
        """Sync dirty documents to remote."""
        if not self._dirty:
            return {"written": 0, "deleted": 0}

        allocation = await self._storage_manager.get_allocation(self.name, self._estimate_size())
        operations: list[dict[str, Any]] = []
        written = 0
        deleted = 0

        for doc_id in self._dirty:
            doc = self._documents.get(doc_id)
            doc_path = self._storage_manager.get_document_path(self.name, doc_id)

            if doc:
                encrypted = self._key_manager.encrypt_for_collection(self.name, doc)
                operations.append({"path": doc_path, "content": encrypted, "encoding": "base64"})
                written += 1
            else:
                operations.append({"path": doc_path, "content": "", "delete": True})
                deleted += 1

        if operations:
            await self._transport.batch_write(
                operations,
                f"gitnix: sync {self.name} ({written} written, {deleted} deleted)",
                allocation.repo,
            )

        self._dirty.clear()
        return {"written": written, "deleted": deleted}

    async def _ensure_loaded(self) -> None:
        if not self._loaded:
            await self.load()

    # ─── Insert ──────────────────────────────────────────────────────────

    async def insert(self, data: dict[str, Any]) -> Document:
        """Insert a single document."""
        await self._ensure_loaded()
        doc = self._create_document(data)

        if doc["_id"] in self._documents:
            raise GitnixError(
                f"Document with ID {doc['_id']} already exists",
                GitnixErrorCode.DUPLICATE_ID,
            )

        self._documents[doc["_id"]] = doc
        self._dirty.add(doc["_id"])
        return doc

    async def insert_many(self, items: list[dict[str, Any]]) -> list[Document]:
        """Insert multiple documents."""
        await self._ensure_loaded()
        docs = []
        for data in items:
            doc = await self.insert(data)
            docs.append(doc)
        return docs

    # ─── Find ────────────────────────────────────────────────────────────

    async def find(
        self, filter_: QueryFilter | None = None, options: QueryOptions | None = None
    ) -> QueryResult:
        """Find documents matching a query."""
        await self._ensure_loaded()
        all_docs = list(self._documents.values())
        return self._query_engine.execute(all_docs, filter_ or {}, options)

    async def find_one(self, filter_: QueryFilter) -> Document | None:
        """Find a single document."""
        result = await self.find(filter_, QueryOptions(limit=1))
        return result.docs[0] if result.docs else None

    async def find_by_id(self, id_: str) -> Document | None:
        """Find by ID."""
        await self._ensure_loaded()
        return self._documents.get(id_)

    async def count(self, filter_: QueryFilter | None = None) -> int:
        """Count matching documents."""
        result = await self.find(filter_, QueryOptions(count=True))
        return result.total or 0

    # ─── Update ──────────────────────────────────────────────────────────

    async def update(self, filter_: QueryFilter, update: UpdateOperator) -> dict[str, int]:
        """Update matching documents."""
        await self._ensure_loaded()
        result = await self.find(filter_)
        modified = 0

        for doc in result.docs:
            updated = self._query_engine.apply_update(doc, update)
            updated["_updated"] = self._now()
            updated["_version"] = doc.get("_version", 0) + 1
            self._documents[doc["_id"]] = updated
            self._dirty.add(doc["_id"])
            modified += 1

        return {"modified": modified}

    async def update_by_id(self, id_: str, update: UpdateOperator) -> Document | None:
        """Update a single document by ID."""
        await self._ensure_loaded()
        doc = self._documents.get(id_)
        if not doc:
            return None

        updated = self._query_engine.apply_update(doc, update)
        updated["_updated"] = self._now()
        updated["_version"] = doc.get("_version", 0) + 1
        self._documents[id_] = updated
        self._dirty.add(id_)
        return updated

    # ─── Delete ──────────────────────────────────────────────────────────

    async def delete(self, filter_: QueryFilter) -> dict[str, int]:
        """Delete matching documents."""
        await self._ensure_loaded()
        result = await self.find(filter_)
        deleted = 0

        for doc in result.docs:
            del self._documents[doc["_id"]]
            self._dirty.add(doc["_id"])
            deleted += 1

        return {"deleted": deleted}

    async def delete_by_id(self, id_: str) -> bool:
        """Delete by ID."""
        await self._ensure_loaded()
        if id_ not in self._documents:
            return False
        del self._documents[id_]
        self._dirty.add(id_)
        return True

    async def delete_all(self) -> dict[str, int]:
        """Delete all documents."""
        await self._ensure_loaded()
        count = len(self._documents)
        for doc_id in list(self._documents.keys()):
            self._dirty.add(doc_id)
        self._documents.clear()
        return {"deleted": count}

    # ─── Utilities ───────────────────────────────────────────────────────

    def is_dirty(self) -> bool:
        return len(self._dirty) > 0

    def get_stats(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "document_count": len(self._documents),
            "dirty_count": len(self._dirty),
            "loaded": self._loaded,
        }

    # ─── Internal ────────────────────────────────────────────────────────

    def _create_document(self, data: dict[str, Any]) -> Document:
        now = self._now()
        doc_id = data.pop("_id", None) or self._generate_id()
        return {
            "_id": doc_id,
            "_created": now,
            "_updated": now,
            "_version": 1,
            **data,
        }

    def _generate_id(self) -> str:
        return str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())

    def _now(self) -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()

    def _estimate_size(self) -> int:
        import json
        return sum(len(json.dumps(doc)) for doc in self._documents.values()) * 2
