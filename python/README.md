# Gitnix Python SDK

Use GitHub repos as an encrypted, high-performance database.

## Installation

```bash
pip install gitnix
```

## Usage

```python
import os
from gitnix import Gitnix
from gitnix.types import GitnixConfig

async def main():
    db = Gitnix(GitnixConfig(
        repo="owner/my-database",
        token=os.environ["GITHUB_TOKEN"],
        password="my-master-password",
    ))

    async with db:
        users = db.collection("users")
        await users.insert({"name": "Alice", "age": 30})
        alice = await users.find_one({"name": "Alice"})
        print(alice)
```

## Features

- Zero-knowledge encryption (GitHub never sees plaintext)
- MongoDB-style queries ($eq, $gt, $in, $or, etc.)
- Binary/image storage with chunking
- Multi-repo overflow when storage limits hit
- Transactions with optimistic locking
- asyncio-native with full type hints
