"""Gitnix SDK - Transaction Layer.

Optimistic locking with conflict detection and retry.
"""

from __future__ import annotations

import time
from typing import Any

from gitnix.errors import GitnixError, GitnixErrorCode
from gitnix.types import Document, QueryFilter, TransactionOptions, UpdateOperator


class Transaction:
    """ACID-like transaction with optimistic concurrency control."""

    def __init__(
        self,
        transport: Any,
        key_manager: Any,
        storage_manager: Any,
        collections: dict[str, Any],
        options: TransactionOptions | None = None,
    ) -> None:
        self._transport = transport
        self._key_manager = key_manager
        self._storage_manager = storage_manager
        self._collections = collections
        self._options = options or TransactionOptions()
        self._base_sha: str = ""
        self._pending_writes: dict[str, dict[str, Any]] = {}
        self._status: str = "none"
        self._started_at: float = 0

    async def begin(self) -> None:
        """Begin transaction."""
        self._base_sha = await self._transport.get_head_sha()
        self._status = "active"
        self._started_at = time.time()
        self._pending_writes = {}

    async def commit(self) -> dict[str, Any]:
        """Commit all pending writes atomically."""
        self._ensure_active()

        if time.time() - self._started_at > self._options.timeout:
            self._status = "aborted"
            raise GitnixError("Transaction timed out", GitnixErrorCode.TRANSACTION_TIMEOUT)

        if not self._pending_writes:
            self._status = "committed"
            return {"commit_sha": self._base_sha, "operations": 0}

        for attempt in range(self._options.max_retries + 1):
            try:
                result = await self._try_commit()
                self._status = "committed"
                return result
            except GitnixError as e:
                if e.code != GitnixErrorCode.TRANSACTION_CONFLICT:
                    raise
                if attempt == self._options.max_retries:
                    self._status = "conflict"
                    raise
                if self._options.conflict_strategy == "abort":
                    self._status = "aborted"
                    raise
                # Retry with updated base
                self._base_sha = await self._transport.get_head_sha()

        raise GitnixError(
            "Transaction failed after max retries",
            GitnixErrorCode.TRANSACTION_CONFLICT,
        )

    def abort(self) -> None:
        """Abort and discard all pending writes."""
        self._status = "aborted"
        self._pending_writes.clear()

    def collection(self, name: str) -> TransactionCollection:
        """Get a collection proxy within this transaction."""
        self._ensure_active()
        return TransactionCollection(name, self)

    def add_write(self, write: dict[str, Any]) -> None:
        """Record a pending write."""
        key = f"{write['collection']}:{write['document_id']}"
        self._pending_writes[key] = write

    def get_collection(self, name: str) -> Any:
        """Get actual collection instance."""
        return self._collections.get(name)

    @property
    def status(self) -> str:
        return self._status

    @property
    def pending_count(self) -> int:
        return len(self._pending_writes)

    async def _try_commit(self) -> dict[str, Any]:
        """Attempt atomic commit."""
        current_head = await self._transport.get_head_sha()
        if current_head != self._base_sha:
            raise GitnixError(
                "Conflict: HEAD has moved",
                GitnixErrorCode.TRANSACTION_CONFLICT,
                {"expected": self._base_sha, "actual": current_head},
            )

        operations: list[dict[str, Any]] = []
        for write in self._pending_writes.values():
            doc_path = self._storage_manager.get_document_path(
                write["collection"], write["document_id"]
            )
            if write["type"] in ("insert", "update"):
                encrypted = self._key_manager.encrypt_for_collection(
                    write["collection"], write["data"]
                )
                operations.append({"path": doc_path, "content": encrypted, "encoding": "base64"})
            elif write["type"] == "delete":
                operations.append({"path": doc_path, "content": "", "delete": True})

        tx_id = f"tx_{int(time.time())}_{id(self) % 10000}"
        result = await self._transport.batch_write(
            operations, f"gitnix: transaction {tx_id} ({len(operations)} ops)"
        )
        return {"commit_sha": result["commit_sha"], "operations": len(operations)}

    def _ensure_active(self) -> None:
        if self._status != "active":
            raise GitnixError(
                "No active transaction", GitnixErrorCode.TRANSACTION_ABORTED
            )


class TransactionCollection:
    """Collection proxy that records operations in a transaction."""

    def __init__(self, name: str, tx: Transaction) -> None:
        self._name = name
        self._tx = tx

    async def insert(self, data: dict[str, Any]) -> Document:
        """Insert within transaction."""
        coll = self._tx.get_collection(self._name)
        if not coll:
            raise GitnixError(
                f"Collection '{self._name}' not found",
                GitnixErrorCode.COLLECTION_NOT_FOUND,
            )
        doc = await coll.insert(data)
        self._tx.add_write({
            "type": "insert",
            "collection": self._name,
            "document_id": doc["_id"],
            "data": doc,
        })
        return doc

    async def update(self, filter_: QueryFilter, update: UpdateOperator) -> dict[str, int]:
        """Update within transaction."""
        coll = self._tx.get_collection(self._name)
        if not coll:
            raise GitnixError(
                f"Collection '{self._name}' not found",
                GitnixErrorCode.COLLECTION_NOT_FOUND,
            )
        result = await coll.update(filter_, update)
        docs = await coll.find(filter_)
        for doc in docs.docs:
            self._tx.add_write({
                "type": "update",
                "collection": self._name,
                "document_id": doc["_id"],
                "data": doc,
            })
        return result

    async def delete(self, filter_: QueryFilter) -> dict[str, int]:
        """Delete within transaction."""
        coll = self._tx.get_collection(self._name)
        if not coll:
            raise GitnixError(
                f"Collection '{self._name}' not found",
                GitnixErrorCode.COLLECTION_NOT_FOUND,
            )
        docs = await coll.find(filter_)
        for doc in docs.docs:
            self._tx.add_write({
                "type": "delete",
                "collection": self._name,
                "document_id": doc["_id"],
            })
        return await coll.delete(filter_)

    async def find(self, filter_: QueryFilter | None = None) -> list[Document]:
        """Find within transaction."""
        coll = self._tx.get_collection(self._name)
        if not coll:
            raise GitnixError(
                f"Collection '{self._name}' not found",
                GitnixErrorCode.COLLECTION_NOT_FOUND,
            )
        result = await coll.find(filter_)
        return result.docs

    async def find_one(self, filter_: QueryFilter) -> Document | None:
        """Find one within transaction."""
        coll = self._tx.get_collection(self._name)
        if not coll:
            raise GitnixError(
                f"Collection '{self._name}' not found",
                GitnixErrorCode.COLLECTION_NOT_FOUND,
            )
        return await coll.find_one(filter_)
