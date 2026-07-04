# Gitnix

**Turn any GitHub repository into a fast, encrypted, zero-knowledge database.**

[![npm](https://img.shields.io/npm/v/gitnix)](https://www.npmjs.com/package/gitnix)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Quilonix/gitnix/blob/main/LICENSE)

Gitnix is a JavaScript/TypeScript SDK that uses GitHub repos as a database backend. All data is **end-to-end encrypted** client-side — GitHub never sees your plaintext data.

## Install

```bash
npm install gitnix
```

## Quick Start

```typescript
import { Gitnix } from 'gitnix';

const db = new Gitnix({
  repo: 'your-username/my-database',
  token: process.env.GITHUB_TOKEN,
  password: 'my-secret-encryption-key',
});

await db.connect();

const users = db.collection('users');

// Insert
await users.insert({ name: 'Alice', age: 30, email: 'alice@example.com' });

// Query (MongoDB-style)
const adults = await users.find({ age: { $gte: 18 } }, { sort: { age: -1 } });

// Update
await users.update({ name: 'Alice' }, { $set: { age: 31 } });

// Delete
await users.delete({ name: 'Alice' });

// Sync encrypted data to GitHub
await db.sync();

await db.disconnect();
```

## Features

- **Zero-Knowledge Encryption** — XSalsa20-Poly1305 + Argon2id key derivation
- **MongoDB-Style Queries** — `$eq`, `$gt`, `$in`, `$or`, `$regex`, `$contains`, and more
- **Sub-millisecond Operations** — Local-first with encrypted disk cache
- **GitHub Sync** — On-demand push/pull to GitHub (encrypted blobs only)
- **Binary/Image Storage** — Chunked upload/download with MIME detection
- **Transactions** — Optimistic locking with conflict detection
- **Schema Validation** — Optional type checking and constraints
- **Rate Limit Aware** — Built-in rate limiter with queue and backpressure
- **TypeScript First** — Full type definitions included

## Performance

| Operation | Avg Latency | Throughput |
|-----------|-------------|-----------|
| Create record | 1.2ms | 813 req/s |
| Read single | 0.98ms | 1,021 req/s |
| List all (50 docs) | 1.0ms | 995 req/s |
| Filtered query | 0.65ms | 1,531 req/s |
| Update record | 1.0ms | 1,000 req/s |
| Delete (+ cascade) | 0.66ms | 1,526 req/s |
| Push to GitHub | ~3.0s | 6 API calls |
| Pull from GitHub | ~1.2s | 3 API calls |

## Security

| Property | Implementation |
|----------|---------------|
| Algorithm | XSalsa20-Poly1305 (256-bit key) |
| Key derivation | Argon2id (memory-hard, GPU-resistant) |
| Per-record nonces | Random 24-byte nonce per encryption |
| Filename obfuscation | SHA-256 hashed names |
| Zero plaintext | GitHub only receives encrypted blobs |

**Security audit: A+** (49/49 tests passed across 11 categories)

## Who Should Use This?

✅ Solo developers, side projects, MVPs, hackathons, privacy-focused apps, students, note-taking apps, config management, small teams (< 10), IoT/edge devices.

❌ Not for: high-traffic production (1000+ concurrent users), real-time apps, complex SQL joins, high-frequency writes (100+/sec), or data > 100GB.

## GitHub Rate Limits

| Pattern | API Calls/hr | Works? |
|---------|-------------|--------|
| Sync every 5 min | 72 | ✅ (1.4% of budget) |
| Sync every 1 min | 360 | ✅ (7%) |
| 100 users (cached reads) | 0 | ✅ |
| Real-time sync (every sec) | 21,600 | ❌ |

**Recommended:** Write locally (sub-ms), sync to GitHub periodically.

## Query Operators

```typescript
// Comparison
{ age: { $gt: 18 } }
{ status: { $in: ['active', 'pending'] } }
{ score: { $gte: 90, $lte: 100 } }

// Logical
{ $or: [{ city: 'NYC' }, { city: 'LA' }] }
{ $and: [{ age: { $gte: 18 } }, { verified: true }] }

// String
{ name: { $contains: 'alice' } }
{ email: { $regex: '^admin@' } }

// Options
await users.find(query, {
  sort: { age: -1 },
  skip: 0,
  limit: 20,
  fields: ['name', 'email'],
});
```

## Also Available

- **Python SDK**: `pip install gitnix` — [PyPI](https://pypi.org/project/gitnix/)
- **Full Example App**: Event registration platform with admin panel, auth, and 45 E2E tests

## Links

- [GitHub Repository](https://github.com/Quilonix/gitnix)
- [JavaScript API Reference](https://github.com/Quilonix/gitnix/blob/main/docs/API-JS.md)
- [Python API Reference](https://github.com/Quilonix/gitnix/blob/main/docs/API-PYTHON.md)
- [Security & Threat Model](https://github.com/Quilonix/gitnix/blob/main/docs/SECURITY.md)
- [Usage Guide & Examples](https://github.com/Quilonix/gitnix/blob/main/docs/GUIDE.md)
- [Architecture Deep Dive](https://github.com/Quilonix/gitnix/blob/main/ARCHITECTURE.md)
- [Example App (Event Registration)](https://github.com/Quilonix/gitnix/tree/main/examples)
- [Python SDK on PyPI](https://pypi.org/project/gitnix/)

## License

MIT — [Quilonix](https://github.com/Quilonix)
