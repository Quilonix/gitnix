"""
Gitnix - Use GitHub repos as an encrypted, high-performance database.

Usage:
    from gitnix import Gitnix

    db = Gitnix(
        repo="owner/my-database",
        token=os.environ["GITHUB_TOKEN"],
        password="my-master-password",
    )

    await db.connect()
    users = db.collection("users")
    await users.insert({"name": "Alice", "age": 30})
    alice = await users.find_one({"name": "Alice"})
    await db.sync()
    await db.disconnect()
"""

from gitnix.client import Gitnix
from gitnix.collection import Collection
from gitnix.query import QueryEngine
from gitnix.binary import BinaryStorage
from gitnix.transaction import Transaction
from gitnix.errors import GitnixError, GitnixErrorCode
from gitnix.types import (
    GitnixConfig,
    Document,
    CollectionOptions,
    QueryFilter,
    QueryOptions,
    QueryResult,
    UpdateOperator,
    BinaryMetadata,
    UploadOptions,
    TransactionOptions,
)

__version__ = "1.0.0"
__all__ = [
    "Gitnix",
    "Collection",
    "QueryEngine",
    "BinaryStorage",
    "Transaction",
    "GitnixError",
    "GitnixErrorCode",
    "GitnixConfig",
    "Document",
    "CollectionOptions",
    "QueryFilter",
    "QueryOptions",
    "QueryResult",
    "UpdateOperator",
    "BinaryMetadata",
    "UploadOptions",
    "TransactionOptions",
]
