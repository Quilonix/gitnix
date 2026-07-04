# Python API Reference

Complete reference for the Gitnix Python SDK.

---

## Table of Contents

- [Gitnix (Main Class)](#gitnix)
- [Collection](#collection)
- [Query Operators](#query-operators)
- [Update Operators](#update-operators)
- [Binary Storage](#binary-storage)
- [Transactions](#transactions)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [Type Reference](#type-reference)

---

## Gitnix

The main entry point. Supports both explicit connect/disconnect and async context manager.

### Initialization

```python
from gitnix import Gitnix
from gitnix.types import GitnixConfig

db = Gitnix(GitnixConfig(
    repo="owner/my-database",
    token=os.environ["GITHUB_TOKEN"],
    password="my-secret-key",
))
```

#### GitnixConfig

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | `str` | ✅ | — | `"owner/repo"` format |
| `token` | `str` | ✅ | — | GitHub PAT |
| `password` | `str` | ✅ | — | Encryption password |
| `branch` | `str` | ❌ | `"main"` | Branch |
| `overflow_repos` | `list[str]` | ❌ | `[]` | Overflow repos |
| `cache` | `CacheConfig` | ❌ | defaults | Cache settings |
| `rate_limiter` | `RateLimiterConfig` | ❌ | defaults | Rate limit settings |
| `encryption` | `EncryptionConfig` | ❌ | defaults | Crypto params |
| `api_base_url` | `str` | ❌ | `"https://api.github.com"` | Enterprise URL |
| `auto_create` | `bool` | ❌ | `False` | Auto-create repo |

### Context Manager (Recommended)

```python
async with Gitnix(config) as db:
    users = db.collection("users")
    await users.insert({"name": "Alice"})
    # Auto-syncs and disconnects on exit
```

### Explicit Lifecycle

```python
await db.connect()
# ... operations ...
await db.sync()
await db.disconnect()
```

### Methods

#### `connect() -> None`

```python
await db.connect()
```

#### `disconnect() -> None`

```python
await db.disconnect()
```

#### `collection(name, options=None) -> Collection`

```python
users = db.collection("users")
```

#### `sync() -> dict[str, int]`

```python
result = await db.sync()
# {"collections": 2, "written": 10, "deleted": 1}
```

#### `transaction(fn, options=None) -> Any`

```python
async def tx_fn(tx):
    posts = tx.collection("posts")
    await posts.insert({"title": "Hello"})

result = await db.transaction(tx_fn)
```

#### `get_status() -> dict`

```python
status = db.get_status()
# {"connected": True, "repo": "owner/db", "collections": 3, "rate_limit_remaining": 4850}
```

#### `binary -> BinaryStorage`

```python
meta = await db.binary.upload(data, UploadOptions(filename="photo.png"))
```

---

## Collection

### Insert

```python
# Single
doc = await users.insert({"name": "Alice", "age": 30})
# Returns: {"_id": "...", "_created": "...", "_version": 1, "name": "Alice", "age": 30}

# Multiple
docs = await users.insert_many([
    {"name": "Bob", "age": 25},
    {"name": "Charlie", "age": 35},
])
```

### Find

```python
from gitnix.types import QueryOptions

# Find all
result = await users.find()
# QueryResult(docs=[...], total=None, has_more=False, execution_time=0.001)

# With filter
result = await users.find({"age": {"$gte": 18}})

# With options
result = await users.find(
    {"status": "active"},
    QueryOptions(sort={"age": -1}, skip=10, limit=5, count=True)
)
# result.docs, result.total, result.has_more
```

#### `find_one(filter) -> Document | None`

```python
alice = await users.find_one({"name": "Alice"})
```

#### `find_by_id(id) -> Document | None`

```python
doc = await users.find_by_id("doc_abc123")
```

#### `count(filter=None) -> int`

```python
active_count = await users.count({"status": "active"})
```

### Update

```python
# Update matching
result = await users.update(
    {"name": "Alice"},         # filter
    {"$set": {"age": 31}}      # operators
)
# {"modified": 1}

# Update by ID
updated = await users.update_by_id("doc_abc", {"$inc": {"views": 1}})
```

### Delete

```python
# Delete matching
result = await users.delete({"status": "banned"})
# {"deleted": 3}

# Delete by ID
deleted = await users.delete_by_id("doc_abc")
# True / False

# Delete all
await users.delete_all()
```

### Sync & Status

```python
await users.sync()
users.is_dirty()      # True/False
users.get_stats()     # {"name": "users", "document_count": 50, ...}
```

---

## Query Operators

### Comparison

```python
{"age": {"$eq": 30}}       # Equal (or just {"age": 30})
{"age": {"$ne": 30}}       # Not equal
{"age": {"$gt": 18}}       # Greater than
{"age": {"$gte": 18}}      # Greater or equal
{"age": {"$lt": 65}}       # Less than
{"age": {"$lte": 65}}      # Less or equal
{"role": {"$in": ["admin", "mod"]}}     # In list
{"role": {"$nin": ["banned"]}}          # Not in list
```

### Logical

```python
{"$and": [{"age": {"$gte": 18}}, {"age": {"$lte": 65}}]}
{"$or": [{"role": "admin"}, {"role": "moderator"}]}
{"$not": {"status": "active"}}
```

### String

```python
{"bio": {"$contains": "developer"}}     # Case-insensitive substring
{"name": {"$startsWith": "Al"}}
{"email": {"$endsWith": "@gmail.com"}}
{"phone": {"$regex": r"^\+1"}}          # Regular expression
```

### Array & Existence

```python
{"tags": {"$size": 3}}                  # Array has 3 elements
{"tags": {"$elemMatch": {"$eq": "admin"}}}
{"phone": {"$exists": True}}            # Field exists
{"phone": {"$exists": False}}           # Field doesn't exist
```

---

## Update Operators

```python
{"$set": {"name": "Bob", "age": 26}}          # Set fields
{"$unset": {"temp_field": True}}               # Remove fields
{"$inc": {"views": 1, "score": -5}}            # Increment
{"$push": {"tags": "new-tag"}}                 # Append to array
{"$pull": {"tags": "old-tag"}}                 # Remove from array
{"$addToSet": {"followers": "user123"}}        # Push if not present
```

---

## Binary Storage

```python
from gitnix.types import UploadOptions, DownloadOptions

# Upload
with open("photo.png", "rb") as f:
    data = f.read()

meta = await db.binary.upload(data, UploadOptions(
    filename="photo.png",
    mime_type="image/png",              # Auto-detected if omitted
    metadata={"user_id": "abc"},
    chunk_size=524_288,                 # 512KB
    on_progress=lambda pct: print(f"{pct:.0f}%"),
))
# BinaryMetadata(id='...', filename='photo.png', size=2048, ...)

# Download
data = await db.binary.download(meta.id, DownloadOptions(
    on_progress=lambda pct: print(f"{pct:.0f}%"),
))

# Metadata only
meta = await db.binary.get_metadata(file_id)

# Delete
await db.binary.delete(file_id)
```

---

## Transactions

```python
from gitnix.types import TransactionOptions

async def transfer_funds(tx):
    accounts = tx.collection("accounts")
    sender = await accounts.find_one({"_id": "acc_001"})
    receiver = await accounts.find_one({"_id": "acc_002"})

    await accounts.update({"_id": "acc_001"}, {"$inc": {"balance": -100}})
    await accounts.update({"_id": "acc_002"}, {"$inc": {"balance": 100}})

result = await db.transaction(
    transfer_funds,
    TransactionOptions(max_retries=3, timeout=30.0, conflict_strategy="retry")
)
```

### TransactionOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_retries` | `int` | `3` | Retries on conflict |
| `timeout` | `float` | `30.0` | Seconds |
| `conflict_strategy` | `str` | `"retry"` | `retry` / `abort` / `merge` |
| `merge_fn` | `Callable` | `None` | Custom merge function |

---

## Error Handling

```python
from gitnix import GitnixError, GitnixErrorCode

try:
    await users.insert(data)
except GitnixError as e:
    match e.code:
        case GitnixErrorCode.RATE_LIMITED:
            print("Rate limited, retrying...")
        case GitnixErrorCode.DUPLICATE_ID:
            print(f"Already exists: {e.details}")
        case GitnixErrorCode.SCHEMA_VIOLATION:
            print(f"Validation errors: {e.details['errors']}")
        case GitnixErrorCode.DECRYPTION_FAILED:
            print("Wrong password or corrupt data")
        case _:
            raise
```

### Error Codes

Same as JS SDK — see [Error Codes table in JS docs](API-JS.md#error-codes).

---

## Configuration

### CacheConfig

```python
from gitnix.types import CacheConfig

CacheConfig(
    max_size=5000,        # Max items
    ttl=300.0,            # Seconds
    persistent=False,
)
```

### RateLimiterConfig

```python
from gitnix.types import RateLimiterConfig

RateLimiterConfig(
    max_requests_per_hour=5000,
    max_concurrent=10,
    max_writes_per_minute=20,
    retry_attempts=3,
    retry_base_delay=1.0,   # seconds
)
```

### EncryptionConfig

```python
from gitnix.types import EncryptionConfig

EncryptionConfig(
    argon2_memory_cost=65536,    # KiB (64MB)
    argon2_time_cost=3,
    argon2_parallelism=1,
    enable_padding=True,
    padding_block_size=256,
)
```

---

## Type Reference

### Document

```python
Document = dict[str, Any]
# Always contains: _id, _created, _updated, _version
```

### QueryResult

```python
@dataclass
class QueryResult:
    docs: list[Document]
    total: int | None       # Only if count=True
    has_more: bool
    execution_time: float   # seconds
```

### BinaryMetadata

```python
@dataclass
class BinaryMetadata:
    id: str
    filename: str
    mime_type: str
    size: int              # bytes
    chunk_count: int
    chunk_size: int
    hash: str              # SHA-256
    uploaded_at: str       # ISO timestamp
    metadata: dict | None
    repo: str
    width: int | None      # images
    height: int | None     # images
```

---

## Full Example

```python
import asyncio
import os
from gitnix import Gitnix
from gitnix.types import GitnixConfig, QueryOptions, UploadOptions

async def main():
    db = Gitnix(GitnixConfig(
        repo="myuser/my-encrypted-db",
        token=os.environ["GITHUB_TOKEN"],
        password="super-secret-password",
    ))

    async with db:
        # Collections
        users = db.collection("users")
        posts = db.collection("posts")

        # CRUD
        alice = await users.insert({"name": "Alice", "age": 30, "role": "admin"})
        await users.insert_many([
            {"name": "Bob", "age": 25},
            {"name": "Charlie", "age": 35},
        ])

        # Queries
        admins = await users.find({"role": "admin"})
        young = await users.find({"age": {"$lt": 30}}, QueryOptions(sort={"age": 1}))

        # Updates
        await users.update({"name": "Alice"}, {"$set": {"age": 31}})

        # Binary
        with open("avatar.png", "rb") as f:
            await db.binary.upload(f.read(), UploadOptions(filename="alice-avatar.png"))

        # Transaction
        async def create_post(tx):
            p = tx.collection("posts")
            u = tx.collection("users")
            post = await p.insert({"title": "Hello!", "author": alice["_id"]})
            await u.update({"_id": alice["_id"]}, {"$inc": {"post_count": 1}})
            return post

        new_post = await db.transaction(create_post)
        print(f"Created post: {new_post['title']}")

asyncio.run(main())
```
