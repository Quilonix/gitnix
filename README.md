# Gitnix

**Turn any GitHub repository into a fast, encrypted, zero-knowledge database.**

Gitnix is a dual-language SDK (JavaScript/TypeScript + Python) that uses GitHub repos as a database backend. All data is end-to-end encrypted client-side — GitHub never sees your plaintext data.

[![npm](https://img.shields.io/npm/v/gitnix)](https://www.npmjs.com/package/gitnix)
[![PyPI](https://img.shields.io/pypi/v/gitnix)](https://pypi.org/project/gitnix/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Who Should Use Gitnix?

### ✅ Perfect For

| User | Why |
|------|-----|
| **Solo developers** | Free encrypted database — no infrastructure to manage |
| **Side projects & MVPs** | Zero setup, just a GitHub repo and you're running |
| **Privacy-focused apps** | Zero-knowledge encryption — not even GitHub can read your data |
| **Students & learners** | Free tier forever, learn database concepts with real encryption |
| **Note-taking / journal apps** | Private encrypted notes stored on your own GitHub |
| **Config & secrets management** | Store sensitive configs with full audit trail |
| **Small teams (< 10 people)** | Shared encrypted data with Git history |
| **IoT / edge devices** | Push encrypted telemetry to GitHub without a server |
| **Hackathons** | Ship a working backend in minutes, not hours |

### ❌ Not Ideal For

| Scenario | Why | Use Instead |
|----------|-----|-------------|
| High-traffic production apps (1000+ concurrent users) | GitHub API rate limits (5,000 req/hr) | PostgreSQL, MongoDB |
| Real-time applications | No WebSocket/live queries | Firebase, Supabase |
| Apps needing complex SQL joins | Document-based, not relational | PostgreSQL |
| High-frequency writes (100+/sec sustained) | GitHub secondary rate limits | Redis, DynamoDB |
| Apps with > 100GB data | GitHub repo size limits | S3 + database |

---

## Performance Benchmarks

Tested on the included event registration app (11 encrypted collections, ~50 documents):

### Local Operations (encrypted disk cache)

| Operation | Avg Latency | P95 | Throughput |
|-----------|-------------|-----|-----------|
| **Create record** | 1.2ms | 1.9ms | **813 req/s** |
| **Read single record** | 0.98ms | 1.9ms | **1,021 req/s** |
| **List all (50 docs, decrypt)** | 1.0ms | 2.6ms | **995 req/s** |
| **Filtered query** | 0.65ms | 0.87ms | **1,531 req/s** |
| **Update record** | 1.0ms | 1.4ms | **1,000 req/s** |
| **Delete (+ cascade)** | 0.66ms | 0.81ms | **1,526 req/s** |
| **10× concurrent reads** | 3.6ms batch | 5.6ms | 2,794 reads/s |

### GitHub Sync (remote encrypted storage)

| Operation | Avg Latency | Notes |
|-----------|-------------|-------|
| **Push** (3 collections) | ~3.0s | 6 API calls, encrypted upload |
| **Pull** (3 collections) | ~1.2s | 3 API calls, encrypted download |
| **API budget** | 5,000/hr | Supports ~833 syncs/hour |

### Authentication (intentionally slow — security)

| Operation | Avg Latency | Why |
|-----------|-------------|-----|
| **Signup** (bcrypt 12 rounds) | 406ms | Brute-force resistant |
| **Login** (bcrypt compare) | 373ms | GPU-resistant hashing |
| **JWT verification** | ~0ms overhead | Stateless, no DB lookup |

---

## Security Audit Results

Automated security audit with 51 tests across 11 categories:

| Category | Tests | Result |
|----------|-------|--------|
| Authentication Bypass | 5 | ✅ All blocked |
| Privilege Escalation | 8 | ✅ All blocked (403) |
| Input Injection (XSS, SQLi, NoSQL, traversal) | 10 | ✅ All sanitized/rejected |
| Rate Limiting | 2 | ✅ Triggers after 18 attempts |
| Security Headers (OWASP) | 6 | ✅ All present |
| JWT Security (none-alg, tamper, expired) | 5 | ✅ All attacks blocked |
| Session Management | 3 | ✅ + 1 known limitation |
| Encryption at Rest | 3 | ✅ All data encrypted |
| Information Disclosure | 4 | ✅ No leaks |
| CORS Policy | 1 | ✅ Restricted |
| Business Logic | 3 | ✅ All validated |

**Score: A+** (49 passed, 0 failed, 2 minor warnings)

### Encryption Details

| Property | Implementation |
|----------|---------------|
| Algorithm | XSalsa20-Poly1305 (256-bit key, 192-bit nonce) |
| Key derivation | Argon2id (memory-hard, GPU-resistant) |
| Per-record nonces | Random 24-byte nonce per encryption |
| Filename obfuscation | SHA-256 hashed collection/document names |
| Size padding | Records padded to prevent size analysis |
| Key hierarchy | Master key → per-collection keys |
| Zero plaintext | GitHub never receives unencrypted data |
| Password hashing | bcrypt (12 rounds) for user auth |

---

## Features

- **Zero-Knowledge Encryption** — XSalsa20-Poly1305, Argon2id key derivation
- **MongoDB-Style Queries** — `$eq`, `$gt`, `$in`, `$or`, `$regex`, `$contains`, and more
- **Binary/Image Storage** — Chunked upload/download with MIME detection
- **Multi-Repo Overflow** — Automatically creates new repos when storage limit approaches
- **Transactions** — Optimistic locking with conflict detection and retry
- **Dual Language** — Feature-parallel JavaScript and Python SDKs
- **Schema Validation** — Optional type checking, required fields, constraints
- **Indexes** — Encrypted indexes for query optimization
- **Full Version History** — Every operation is a Git commit
- **Rate Limit Aware** — Built-in rate limiter, queue, backpressure, and retry
- **GitHub Sync** — Local-first with on-demand push/pull to GitHub

---

## Quick Start

### JavaScript / TypeScript

```bash
npm install gitnix
```

```typescript
import { Gitnix } from 'gitnix';

const db = new Gitnix({
  repo: 'your-username/my-database',
  token: process.env.GITHUB_TOKEN,
  password: 'my-secret-encryption-key',
});

await db.connect();

// Create a collection
const users = db.collection('users');

// Insert
await users.insert({ name: 'Alice', age: 30, email: 'alice@example.com' });

// Query
const adults = await users.find({ age: { $gte: 18 } }, { sort: { age: -1 } });

// Update
await users.update({ name: 'Alice' }, { $set: { age: 31 } });

// Delete
await users.delete({ name: 'Alice' });

// Sync to GitHub (batches all changes into one commit)
await db.sync();

// Store files
const imageData = fs.readFileSync('photo.png');
await db.binary.upload(imageData, { filename: 'photo.png' });

await db.disconnect();
```

### Python

```bash
pip install gitnix
```

```python
import os
from gitnix import Gitnix
from gitnix.types import GitnixConfig

db = Gitnix(GitnixConfig(
    repo="your-username/my-database",
    token=os.environ["GITHUB_TOKEN"],
    password="my-secret-encryption-key",
))

async with db:
    users = db.collection("users")

    # Insert
    await users.insert({"name": "Alice", "age": 30})

    # Query
    adults = await users.find({"age": {"$gte": 18}})

    # Update
    await users.update({"name": "Alice"}, {"$set": {"age": 31}})

    # Delete
    await users.delete({"name": "Alice"})

    # Sync
    await db.sync()
```

---

## GitHub API Rate Limits

| Limit | Value | How Gitnix Handles It |
|-------|-------|----------------------|
| REST API | 5,000 req/hr | Local-first caching, batch operations |
| Secondary | ~900 points/min | Write queue with backpressure |
| File size | 100 MB | Chunked binary storage |
| Concurrent | 100 max | Semaphore-based connection pooling |
| Content-generating | 80/min | Rate-limited write queue |

### Budget Examples

| Usage Pattern | API Calls/hr | Feasible? |
|---------------|-------------|-----------|
| Sync every 5 min (3 collections) | 72 | ✅ Uses 1.4% |
| Sync every 1 min | 360 | ✅ Uses 7% |
| 100 users reading (cached) | 0 | ✅ Local cache |
| 100 users writing + sync each | 600 | ✅ Uses 12% |
| Continuous sync every 10s | 2,160 | ⚠️ Uses 43% |
| Real-time sync (every second) | 21,600 | ❌ Exceeds limit |

**Recommended pattern:** Write locally (sub-ms), sync to GitHub periodically or on-demand.

---

## Comparison

| Feature | Gitnix | Firebase | Supabase | SQLite | GitRows |
|---------|--------|----------|----------|--------|---------|
| **Encryption** | ✅ E2E Zero-knowledge | ❌ At-rest only | ❌ At-rest only | ❌ None | ❌ None |
| **Cost** | Free (GitHub) | Paid at scale | Paid at scale | Free | Free |
| **Languages** | JS + Python | Many | Many | Many | JS only |
| **Version History** | ✅ Full Git history | ❌ | ❌ | ❌ | Partial |
| **Self-hosted** | ✅ Any Git host | ❌ | ✅ | ✅ | GitHub only |
| **Binary Storage** | ✅ Chunked + encrypted | ✅ | ✅ | ❌ | ❌ |
| **Queries** | MongoDB-style | Firebase queries | SQL | SQL | Basic |
| **Offline capable** | ✅ Local-first | ✅ | ❌ | ✅ | ❌ |
| **Setup time** | 30 seconds | 5 min | 10 min | 30 sec | 30 sec |
| **Max throughput** | ~1,000 writes/s (local) | 100k+/s | 100k+/s | 50k+/s | Low |
| **Active** | ✅ 2026 | ✅ | ✅ | ✅ | ❌ Abandoned |

---

## Real-World Example: Event Registration App

The `examples/` directory contains a full production-grade event registration platform built with Gitnix:

- Multi-user authentication (bcrypt + JWT)
- Admin panel with event CRUD
- User registration with capacity enforcement
- Encrypted database (all data encrypted at rest)
- GitHub sync (push/pull encrypted data)
- 45 Playwright E2E tests (100% pass)
- 51-point security audit (A+ score)

```bash
cd examples
npm install
npm run dev
# Open http://localhost:3000
# Admin: admin@example.com / admin123
```

---

## Project Structure

```
gitnix/
├── js/                  # JavaScript/TypeScript SDK
│   ├── src/
│   │   ├── core/        # Transport, cache, rate-limiter, storage manager
│   │   ├── crypto/      # Encryption, KDF, key management
│   │   ├── collections/ # Collection CRUD, schema validation
│   │   ├── query/       # Query engine, operators, indexes
│   │   ├── binary/      # Binary/image storage, chunking
│   │   ├── transactions/# Transaction layer, conflict resolution
│   │   ├── types/       # TypeScript type definitions
│   │   └── index.ts     # Public API entry point
│   ├── package.json
│   └── tsconfig.json
├── python/              # Python SDK
│   ├── gitnix/
│   │   ├── client.py    # Main Gitnix class
│   │   ├── collection.py
│   │   ├── query.py
│   │   ├── encryption.py
│   │   ├── transport.py
│   │   ├── rate_limiter.py
│   │   ├── binary.py
│   │   ├── transaction.py
│   │   ├── types.py
│   │   └── errors.py
│   └── pyproject.toml
├── examples/            # Event Registration App (full demo)
│   ├── server.mjs       # Express server
│   ├── db.mjs           # Encrypted DB layer + GitHub sync
│   ├── auth.mjs         # JWT + bcrypt auth
│   ├── e2e-test.mjs     # Playwright E2E tests (45 tests)
│   ├── benchmark.mjs    # Performance benchmark
│   ├── security-audit.mjs # Security audit (51 tests)
│   └── public/          # Frontend SPA
├── docs/                # Documentation
│   ├── API-JS.md
│   ├── API-PYTHON.md
│   ├── SECURITY.md
│   └── GUIDE.md
└── ARCHITECTURE.md      # Technical architecture
```

---

## How It Works

```
Your App  ──►  Gitnix SDK  ──►  Local Encrypted Cache  ──►  GitHub Repository
                   │                                              │
         ┌─────────┼─────────┐                          (on-demand sync)
         │         │         │                                    │
    Encrypt    Cache     Rate Limit                      Encrypted Blobs
    (client)   (LRU)    (token bucket)                   on GitHub
         │         │         │
         └─────────┼─────────┘
                   │
         Sub-millisecond reads/writes
```

1. **You write data** → SDK encrypts it client-side with your password
2. **Stored locally** → Encrypted file on disk (sub-ms latency)
3. **You sync** → Encrypted blob pushed to GitHub via API
4. **You read** → Fetched from local cache, decrypted with your key
5. **GitHub sees nothing** → Only encrypted binary blobs

---

## Documentation

- [JavaScript API Reference](docs/API-JS.md)
- [Python API Reference](docs/API-PYTHON.md)
- [Security & Threat Model](docs/SECURITY.md)
- [Usage Guide & Examples](docs/GUIDE.md)
- [Architecture Deep Dive](ARCHITECTURE.md)

---

## Installation

### JavaScript / TypeScript
```bash
npm install gitnix
```

### Python
```bash
pip install gitnix
```

---

## Development

### JavaScript SDK

```bash
cd js
npm install
npm run typecheck    # TypeScript validation
npm run build        # Build ESM + CJS + DTS
npm run test         # Run tests
```

### Python SDK

```bash
cd python
pip install -e ".[dev]"
pytest tests/ -v     # Run tests
mypy gitnix/         # Type checking
ruff check gitnix/   # Linting
```

### Example App

```bash
cd examples
npm install
npm run dev          # Start with auto-reload
node benchmark.mjs   # Run performance benchmark
node security-audit.mjs  # Run security audit
node e2e-test.mjs    # Run Playwright E2E tests
```

---

## Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|-----------|
| 5,000 req/hr API limit | ~833 syncs/hr max | Local-first + batch sync |
| No real-time subscriptions | No live queries | Polling or on-demand sync |
| 100MB file size limit | Large files need chunking | Built-in chunked storage |
| Client-side queries | All filtering is local | Encrypted indexes reduce scans |
| Write latency ~500ms (to GitHub) | Not for high-frequency remote writes | Local writes are sub-ms |
| Best for < 10 concurrent writers | Optimistic locking may conflict | Configurable retry strategy |
| Stateless JWT | Token valid until expiry after logout | Use short expiry + refresh tokens |

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests in both JS and Python
5. Submit a pull request

---

## License

MIT

---

*Built with 🔐 by the Gitnix team. Your data, your keys, your control.*
