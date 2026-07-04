"""Gitnix SDK - Main Client.

Primary interface for using GitHub repos as an encrypted database.
"""

from __future__ import annotations

from typing import Any, Callable

from gitnix.binary import BinaryStorage
from gitnix.collection import Collection
from gitnix.encryption import Encryption
from gitnix.errors import GitnixError, GitnixErrorCode
from gitnix.rate_limiter import RateLimiter
from gitnix.transaction import Transaction
from gitnix.transport import Transport
from gitnix.types import (
    CollectionOptions,
    GitnixConfig,
    TransactionOptions,
)


class KeyManager:
    """Simplified key manager for Python SDK."""

    def __init__(self, encryption: Encryption, password: str) -> None:
        self._encryption = encryption
        self._collection_keys: dict[str, bytes] = {}
        self._master_key: bytes | None = None
        self._password = password

    async def initialize(self, existing_keystore: str | None = None) -> None:
        """Derive master key from password."""
        import argon2

        raw_hash = argon2.low_level.hash_secret_raw(
            self._password.encode("utf-8"),
            b"gitnix-default-salt-v1" + b"\x00" * 10,  # 32-byte salt
            time_cost=3,
            memory_cost=65536,
            parallelism=1,
            hash_len=32,
            type=argon2.Type.ID,
        )
        self._master_key = raw_hash

    def get_collection_key(self, collection_id: str) -> bytes:
        """Get or create a key for a collection."""
        if collection_id not in self._collection_keys:
            # Derive collection key deterministically from master key + collection name
            import hashlib
            derived = hashlib.sha256(self._master_key + collection_id.encode()).digest()  # type: ignore
            self._collection_keys[collection_id] = derived
        return self._collection_keys[collection_id]

    def encrypt_for_collection(self, collection_id: str, data: Any) -> str:
        """Encrypt data for a collection."""
        key = self.get_collection_key(collection_id)
        return self._encryption.encrypt_json_to_base64(data, key)

    def decrypt_for_collection(self, collection_id: str, b64_data: str) -> Any:
        """Decrypt data from a collection."""
        key = self.get_collection_key(collection_id)
        return self._encryption.decrypt_json_from_base64(b64_data, key)

    def encrypt_bytes_for_collection(self, collection_id: str, data: bytes) -> str:
        """Encrypt raw bytes."""
        key = self.get_collection_key(collection_id)
        return self._encryption.encrypt_to_base64(data, key)

    def decrypt_bytes_for_collection(self, collection_id: str, b64_data: str) -> bytes:
        """Decrypt raw bytes."""
        key = self.get_collection_key(collection_id)
        return self._encryption.decrypt_from_base64(b64_data, key)

    def hash_collection_name(self, name: str) -> str:
        return self._encryption.hash_string(f"collection:{name}")

    def hash_document_id(self, collection_name: str, doc_id: str) -> str:
        return self._encryption.hash_string(f"doc:{collection_name}:{doc_id}")

    def destroy(self) -> None:
        self._master_key = None
        self._collection_keys.clear()


class StorageManager:
    """Simplified storage manager for Python SDK."""

    def __init__(self, transport: Transport, key_manager: KeyManager, primary_repo: str) -> None:
        self._transport = transport
        self._key_manager = key_manager
        self._primary_repo = primary_repo
        self._collection_map: dict[str, str] = {}

    async def initialize(self) -> None:
        """Initialize storage manager."""
        pass  # Will load manifest in production

    async def get_allocation(self, collection_id: str, size: int) -> Any:
        """Get storage allocation."""
        from gitnix.types import StorageAllocation
        repo = self._collection_map.get(collection_id, self._primary_repo)
        self._collection_map[collection_id] = repo
        return StorageAllocation(
            repo=repo,
            path=self.get_collection_path(collection_id),
            available_space=4 * 1024 * 1024 * 1024,
        )

    def get_collection_repo(self, collection_id: str) -> str:
        return self._collection_map.get(collection_id, self._primary_repo)

    def get_collection_path(self, collection_id: str) -> str:
        hashed = self._key_manager.hash_collection_name(collection_id)
        return f"collections/{hashed}"

    def get_document_path(self, collection_id: str, doc_id: str) -> str:
        coll_path = self.get_collection_path(collection_id)
        hashed_id = self._key_manager.hash_document_id(collection_id, doc_id)
        return f"{coll_path}/{hashed_id}.enc"


class Gitnix:
    """Main SDK client - use GitHub repos as an encrypted database.

    Usage:
        db = Gitnix(GitnixConfig(
            repo="owner/my-database",
            token=os.environ["GITHUB_TOKEN"],
            password="my-master-password",
        ))
        await db.connect()
        users = db.collection("users")
        await users.insert({"name": "Alice"})
        await db.sync()
        await db.disconnect()
    """

    def __init__(self, config: GitnixConfig) -> None:
        self._config = config
        self._validate_config()
        self._transport: Transport | None = None
        self._rate_limiter: RateLimiter | None = None
        self._key_manager: KeyManager | None = None
        self._storage_manager: StorageManager | None = None
        self._binary_storage: BinaryStorage | None = None
        self._collections: dict[str, Collection] = {}
        self._connected = False

    async def connect(self) -> None:
        """Connect to the GitHub repo database."""
        if self._connected:
            raise GitnixError("Already connected", GitnixErrorCode.ALREADY_CONNECTED)

        # Initialize layers
        self._rate_limiter = RateLimiter(self._config.rate_limiter)
        self._rate_limiter.start()

        self._transport = Transport(
            token=self._config.token,
            repo=self._config.repo,
            branch=self._config.branch,
            api_base_url=self._config.api_base_url,
            rate_limiter=self._rate_limiter,
        )

        # Check repo exists
        exists = await self._transport.repo_exists()
        if not exists:
            raise GitnixError(
                f"Repository {self._config.repo} not found",
                GitnixErrorCode.REPO_NOT_FOUND,
            )

        # Initialize encryption
        encryption = Encryption(self._config.encryption)
        self._key_manager = KeyManager(encryption, self._config.password)
        await self._key_manager.initialize()

        # Initialize storage
        self._storage_manager = StorageManager(
            self._transport, self._key_manager, self._config.repo
        )
        await self._storage_manager.initialize()

        # Initialize binary storage
        self._binary_storage = BinaryStorage(
            self._transport, None, self._storage_manager, self._key_manager
        )

        self._connected = True

    async def disconnect(self) -> None:
        """Disconnect and cleanup."""
        if not self._connected:
            return

        await self.sync()
        if self._transport:
            await self._transport.close()
        if self._rate_limiter:
            self._rate_limiter.stop()
        if self._key_manager:
            self._key_manager.destroy()

        self._collections.clear()
        self._connected = False

    def collection(self, name: str, options: CollectionOptions | None = None) -> Collection:
        """Get or create a collection."""
        self._ensure_connected()

        if name not in self._collections:
            self._collections[name] = Collection(
                name=name,
                transport=self._transport,
                cache=None,
                storage_manager=self._storage_manager,
                key_manager=self._key_manager,
                options=options,
            )
        return self._collections[name]

    @property
    def binary(self) -> BinaryStorage:
        """Get binary storage interface."""
        self._ensure_connected()
        return self._binary_storage  # type: ignore

    async def transaction(
        self,
        fn: Callable[[Transaction], Any],
        options: TransactionOptions | None = None,
    ) -> Any:
        """Execute operations in a transaction."""
        self._ensure_connected()

        tx = Transaction(
            self._transport,
            self._key_manager,
            self._storage_manager,
            self._collections,
            options,
        )
        await tx.begin()

        try:
            result = await fn(tx)
            await tx.commit()
            return result
        except Exception:
            tx.abort()
            raise

    async def sync(self) -> dict[str, int]:
        """Sync all dirty collections."""
        self._ensure_connected()

        total_written = 0
        total_deleted = 0
        synced = 0

        for coll in self._collections.values():
            if coll.is_dirty():
                result = await coll.sync()
                total_written += result["written"]
                total_deleted += result["deleted"]
                synced += 1

        return {"collections": synced, "written": total_written, "deleted": total_deleted}

    def get_status(self) -> dict[str, Any]:
        """Get database status."""
        return {
            "connected": self._connected,
            "repo": self._config.repo,
            "collections": len(self._collections),
            "rate_limit_remaining": self._rate_limiter.remaining if self._rate_limiter else 0,
        }

    # ─── Context Manager ─────────────────────────────────────────────────

    async def __aenter__(self) -> "Gitnix":
        await self.connect()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.disconnect()

    # ─── Internal ────────────────────────────────────────────────────────

    def _validate_config(self) -> None:
        if "/" not in self._config.repo:
            raise GitnixError(
                'Invalid repo format. Must be "owner/repo".',
                GitnixErrorCode.INVALID_CONFIG,
            )
        if not self._config.token:
            raise GitnixError("GitHub token is required", GitnixErrorCode.INVALID_CONFIG)
        if not self._config.password:
            raise GitnixError("Encryption password is required", GitnixErrorCode.INVALID_CONFIG)

    def _ensure_connected(self) -> None:
        if not self._connected:
            raise GitnixError("Not connected. Call connect() first.", GitnixErrorCode.NOT_CONNECTED)
