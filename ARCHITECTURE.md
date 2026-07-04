# Gitnix SDK — Architecture Plan

## Vision
A dual-language SDK (JavaScript + Python) that turns any GitHub repository into a **fast, encrypted, zero-knowledge database**. Data is end-to-end encrypted client-side — GitHub never sees plaintext.

---

## Competitive Landscape

| Project | Language | Encryption | Last Updated | Status |
|---------|----------|------------|--------------|--------|
| GitRows | JS only | ❌ None | 4 years ago | Abandoned (4 downloads/week) |
| Appy.GitDb | C# | ❌ None | Old | Niche |
| gitrowspack-api | Python | ❌ None | 2022 | Minimal |
| **Gitnix** | **JS + Python** | **✅ E2E (libsodium)** | **Active** | **New** |

**Key differentiators over GitRows:**
1. End-to-end encryption (zero-knowledge)
2. Python support (first ever for GitHub-as-DB)
3. Local caching layer for speed
4. Batch operations via Git Data API (not Contents API)
5. Conflict resolution & transactions
6. Active maintenance

---

## GitHub API Strategy

### Why Git Data API (not Contents API)?

| Feature | Contents API | Git Data API |
|---------|-------------|--------------|
| Atomic multi-file writes | ❌ One file at a time | ✅ Create tree → commit |
| Rate limit cost per write | 5 points per file | 5 points for entire batch |
| Read performance | 1 req per file | 1 req for tree (list all) |
| Max file size | 100 MB | 100 MB (blobs) |
| Version history | Implicit | Full control |

### API Endpoints Used

```
# Read operations (1 point each)
GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1   → list all "records"
GET /repos/{owner}/{repo}/git/blobs/{sha}               → read a record
GET /repos/{owner}/{repo}/git/refs/heads/{branch}       → get current HEAD

# Write operations (5 points each)
POST /repos/{owner}/{repo}/git/blobs                    → create encrypted blob
POST /repos/{owner}/{repo}/git/trees                    → batch tree update
POST /repos/{owner}/{repo}/git/commits                  → atomic commit
PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}     → push commit
```

### Rate Limit Budget (Authenticated)

| Limit | Value | Strategy |
|-------|-------|----------|
| Primary | 5,000 req/hr | Local cache eliminates redundant reads |
| Secondary | 900 points/min | Batch writes into single commits |
| Concurrent | 100 max | Connection pooling |
| Content-generating | 80/min | Write queue with backpressure |
| GitHub App | Up to 12,500 req/hr | Recommended for production |

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│                    User Application                       │
├─────────────────────────────────────────────────────────┤
│              Gitnix SDK (JS / Python)                    │
│  ┌───────────┬──────────┬───────────┬─────────────────┐ │
│  │  Query    │  CRUD    │  Schema   │   Collection    │ │
│  │  Engine   │  Ops     │  Mgmt     │   Manager       │ │
│  └─────┬─────┴────┬─────┴─────┬─────┴────────┬────────┘ │
│  ┌─────┴──────────┴───────────┴──────────────┴────────┐ │
│  │              Transaction Layer                       │ │
│  │   (optimistic locking, conflict detection, retry)   │ │
│  └─────────────────────┬──────────────────────────────┘ │
│  ┌─────────────────────┴──────────────────────────────┐ │
│  │              Encryption Layer                        │ │
│  │   (libsodium secretbox, key derivation, per-field)  │ │
│  └─────────────────────┬──────────────────────────────┘ │
│  ┌─────────────────────┴──────────────────────────────┐ │
│  │              Cache Layer                             │ │
│  │   (in-memory LRU, ETag/SHA tracking, TTL)           │ │
│  └─────────────────────┬──────────────────────────────┘ │
│  ┌─────────────────────┴──────────────────────────────┐ │
│  │              Transport Layer                         │ │
│  │   (GitHub Git Data API, rate limiter, retry)        │ │
│  └─────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│              GitHub Repository (Storage)                  │
│   encrypted blobs / trees / commits                      │
└─────────────────────────────────────────────────────────┘
```

---

## Security Architecture (Z+ Level)

### Encryption Strategy

```
┌──────────────────────────────────────────────────┐
│  Master Password (user-provided, never stored)    │
│         │                                         │
│         ▼                                         │
│  Argon2id KDF (salt stored in repo metadata)     │
│         │                                         │
│         ▼                                         │
│  Master Key (256-bit)                             │
│         │                                         │
│    ┌────┴────┐                                    │
│    ▼         ▼                                    │
│  Collection  Collection    (per-collection keys)  │
│  Key A       Key B                                │
│    │          │                                   │
│    ▼          ▼                                   │
│  Record      Record        (XChaCha20-Poly1305)   │
│  Encryption  Encryption                           │
└──────────────────────────────────────────────────┘
```

### Security Properties

| Property | Implementation |
|----------|---------------|
| **Zero-knowledge** | GitHub/server never sees plaintext; all encryption is client-side |
| **Authenticated encryption** | XChaCha20-Poly1305 (via libsodium secretbox) — tamper-proof |
| **Key derivation** | Argon2id with configurable memory/time cost |
| **Per-record nonces** | Unique 24-byte random nonce per encryption operation |
| **Key rotation** | Re-encrypt all collection keys with new master key |
| **Forward secrecy** | Optional per-session ephemeral keys |
| **Metadata protection** | File names are hashed (SHA-256 of collection + record ID) |
| **No plaintext leakage** | Even file sizes are padded to fixed blocks |

### Libraries

| Language | Library | Why |
|----------|---------|-----|
| JavaScript | `tweetnacl` + `tweetnacl-util` | Audited, zero-dependency, 4KB |
| Python | `PyNaCl` (libsodium binding) | Official binding, widely audited |
| Both | Argon2id via `argon2-browser` / `argon2-cffi` | Memory-hard KDF, OWASP recommended |

---

## Speed Strategy

### 1. Aggressive Local Caching

```javascript
// Cache hierarchy
L1: In-memory LRU cache (instant, per-session)
L2: SHA-based content addressing (if SHA matches, skip fetch)
L3: GitHub conditional requests (If-None-Match / ETag → 304 = 0 points)
```

### 2. Batch Operations

```
// Instead of N API calls for N records:
1. Build all blobs locally
2. Create tree with all changes in ONE call
3. Create commit in ONE call
4. Update ref in ONE call
// Total: 3-4 API calls regardless of batch size
```

### 3. Lazy Loading & Projections

```
Tree fetch → get all record SHAs (1 API call)
Only fetch blobs that aren't cached (N calls, minimized by cache)
Support field-level projections → decrypt only needed fields
```

### 4. Optimistic Concurrency

```
Read HEAD SHA → perform operations → compare-and-swap on push
If conflict: re-read, merge, retry (configurable strategy)
Eliminates locks entirely
```

### 5. Performance Targets

| Operation | Target | Strategy |
|-----------|--------|----------|
| Read (cached) | < 1ms | In-memory LRU |
| Read (uncached) | < 200ms | Single blob fetch + decrypt |
| Write (single) | < 500ms | Blob + tree + commit + ref update |
| Write (batch 100) | < 800ms | Same as single (batched tree) |
| List collection | < 150ms | Tree fetch (cached SHAs) |
| Full sync | < 2s | Recursive tree + parallel blob fetch |

---

## Data Model

### Repository Structure (on GitHub)

```
repo-root/
├── .gitnix/
│   ├── meta.enc              # Encrypted metadata (schema, settings)
│   └── salt                  # Argon2 salt (not secret)
├── collections/
│   ├── {hashed-collection-name-A}/
│   │   ├── {hashed-id-1}.enc   # Encrypted record
│   │   ├── {hashed-id-2}.enc   # Encrypted record
│   │   └── _index.enc          # Encrypted index (for queries)
│   └── {hashed-collection-name-B}/
│       └── ...
└── README.md                 # Optional: "This repo is managed by Gitnix"
```

### Record Format (decrypted)

```json
{
  "_id": "auto-generated-uuid",
  "_created": "2026-07-03T15:00:00Z",
  "_updated": "2026-07-03T15:00:00Z",
  "_version": 3,
  ...user_fields
}
```

### Encrypted Blob Format

```
[1 byte: version] [24 bytes: nonce] [N bytes: ciphertext] [16 bytes: auth tag]
```

---

## SDK API Design

### JavaScript (Node.js + Browser)

```javascript
import { Gitnix } from 'gitnix';

// Initialize
const db = new Gitnix({
  repo: 'owner/my-database',
  token: process.env.GITHUB_TOKEN,
  password: 'my-master-password',  // Never stored
  cache: { maxSize: 1000, ttl: 60_000 }
});

// Connect (fetches tree, derives keys)
await db.connect();

// Collections
const users = db.collection('users');

// CRUD
await users.insert({ name: 'Alice', email: 'alice@example.com' });
await users.insertMany([{ name: 'Bob' }, { name: 'Charlie' }]);

const user = await users.findOne({ name: 'Alice' });
const allUsers = await users.find({ age: { $gte: 18 } });

await users.update({ name: 'Alice' }, { $set: { age: 30 } });
await users.delete({ name: 'Bob' });

// Transactions
await db.transaction(async (tx) => {
  const posts = tx.collection('posts');
  const comments = tx.collection('comments');
  await posts.insert({ title: 'Hello' });
  await comments.insert({ postId: '...', body: 'World' });
});

// Disconnect
await db.disconnect();
```

### Python

```python
from gitnix import Gitnix

# Initialize
db = Gitnix(
    repo="owner/my-database",
    token=os.environ["GITHUB_TOKEN"],
    password="my-master-password",
    cache={"max_size": 1000, "ttl": 60}
)

# Connect
await db.connect()

# Collections
users = db.collection("users")

# CRUD
await users.insert({"name": "Alice", "email": "alice@example.com"})
user = await users.find_one({"name": "Alice"})
all_users = await users.find({"age": {"$gte": 18}})
await users.update({"name": "Alice"}, {"$set": {"age": 30}})
await users.delete({"name": "Bob"})

# Context manager
async with db.transaction() as tx:
    posts = tx.collection("posts")
    await posts.insert({"title": "Hello"})

await db.disconnect()
```

---

## Query Engine

### Supported Operators (MongoDB-style)

```
Comparison: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin
Logical:    $and, $or, $not
String:     $contains, $startsWith, $endsWith, $regex
Array:      $elemMatch, $size
Projection: { fields: ['name', 'email'] }  → decrypt only selected fields
Sort:       { sort: { name: 1, age: -1 } }
Pagination: { skip: 0, limit: 20 }
```

### Index Strategy

Each collection has an encrypted `_index.enc` file containing:
- Field value → record ID mappings (for indexed fields)
- Updated on every write
- Kept in sync via transaction layer

This allows query resolution without decrypting every record.

---

## Dual-Language Strategy

### Shared Specification

```
gitnix-spec/
├── protocol.md          # Wire format, blob format, encryption spec
├── query-operators.md   # Exact operator behavior
├── test-vectors/        # Shared encryption test vectors
│   ├── encrypt-decrypt.json
│   ├── key-derivation.json
│   └── query-results.json
└── conformance-tests/   # Language-agnostic test suite (JSON-defined)
```

### Package Structure

```
gitnix/
├── spec/                # Shared specification & test vectors
├── js/                  # JavaScript SDK
│   ├── src/
│   │   ├── core/       # Transport, cache, rate-limiter
│   │   ├── crypto/     # Encryption layer
│   │   ├── query/      # Query engine
│   │   └── index.ts    # Public API
│   ├── package.json
│   └── tsconfig.json
├── python/              # Python SDK
│   ├── gitnix/
│   │   ├── core/       # Transport, cache, rate-limiter
│   │   ├── crypto/     # Encryption layer
│   │   ├── query/      # Query engine
│   │   └── __init__.py # Public API
│   ├── pyproject.toml
│   └── tests/
└── README.md
```

---

## Implementation Phases

### Phase 1: Core (Weeks 1-2)
- [ ] Transport layer (GitHub Git Data API client)
- [ ] Rate limiter with backpressure
- [ ] Encryption layer (secretbox + Argon2id KDF)
- [ ] Basic CRUD (insert, findOne, find, update, delete)
- [ ] In-memory cache with SHA tracking

### Phase 2: Query & Performance (Weeks 3-4)
- [ ] Query engine with all operators
- [ ] Encrypted indexes
- [ ] Batch operations
- [ ] Optimistic concurrency / conflict resolution
- [ ] ETag-based conditional requests

### Phase 3: Advanced Features (Weeks 5-6)
- [ ] Transactions (multi-collection atomic writes)
- [ ] Key rotation
- [ ] Schema validation
- [ ] Migration tools
- [ ] Field-level encryption (mix encrypted + plaintext)

### Phase 4: Python SDK (Weeks 7-8)
- [ ] Port core from JS to Python (using shared spec)
- [ ] Conformance test suite (both pass same vectors)
- [ ] Python-specific ergonomics (context managers, type hints)
- [ ] asyncio-native with sync wrapper

### Phase 5: Production Hardening (Weeks 9-10)
- [ ] Comprehensive error handling & retry logic
- [ ] Logging & observability
- [ ] Documentation & examples
- [ ] npm + PyPI publishing
- [ ] CI/CD with cross-language conformance tests

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| JS runtime | TypeScript (ESM + CJS) | Type safety, tree-shaking, universal |
| Python version | 3.10+ (async/await) | Modern async, type hints |
| Encryption | XChaCha20-Poly1305 | Faster than AES on non-hardware, 24-byte nonce = safe random |
| KDF | Argon2id | Memory-hard, resists GPU/ASIC attacks |
| Serialization | MessagePack (encrypted) | Smaller than JSON, binary-safe |
| Query syntax | MongoDB-style | Familiar, well-documented, expressive |
| ID generation | UUIDv7 | Time-sortable, globally unique |
| File naming | SHA-256(collection + id) | Zero metadata leakage |
| Cache | LRU with SHA-addressed content | Deduplication, no stale reads |

---

## Security Threat Model

| Threat | Mitigation |
|--------|-----------|
| GitHub breach / insider access | All data is encrypted; GitHub sees only ciphertext |
| Token theft | Token has no access to encryption key; data remains encrypted |
| Brute-force master password | Argon2id with high memory cost (256MB, 3 iterations) |
| Replay attacks | Per-record nonces, version tracking |
| Traffic analysis (file sizes) | Fixed-size padding (configurable blocks) |
| Metadata leakage (filenames) | Hashed file/folder names |
| Man-in-the-middle | HTTPS to GitHub API + authenticated encryption |
| Concurrent write corruption | Optimistic locking via SHA comparison |

---

## Limitations & Honest Trade-offs

| Limitation | Impact | Mitigation |
|-----------|--------|-----------|
| 5,000 req/hr rate limit | ~83 uncached reads/min max | Aggressive caching, batch writes |
| No real-time / subscriptions | No live queries | Polling with configurable interval |
| 100MB file size limit | Records should be < 1MB each | Enforce max record size |
| No server-side queries | All filtering is client-side | Encrypted indexes reduce full scans |
| Write latency (API round-trips) | ~300-500ms per write | Batch API, write-behind cache |
| Not suitable for high-concurrency | Optimistic locking may conflict | Best for < 10 concurrent writers |

---

## Target Use Cases

1. **Personal projects** — Free, encrypted storage with version history
2. **Prototypes / MVPs** — No database setup, just a GitHub repo
3. **Config management** — Encrypted secrets/configs with audit trail
4. **Small team collaboration** — Shared encrypted data with Git history
5. **Offline-first apps** — Local cache + sync when online
6. **Edge/serverless** — No DB connection needed, just API calls

---

## Next Steps

Ready to start coding? The recommended order is:
1. Set up the monorepo structure (JS + Python + shared spec)
2. Implement the transport layer (Git Data API client)
3. Build the encryption layer with test vectors
4. CRUD operations on top
5. Add caching and rate limiting
6. Query engine
7. Python port using shared conformance tests
