# Security & Architecture Deep Dive

This document covers Gitnix's security model, cryptographic choices, threat model, and internal architecture in detail.

---

## Cryptographic Design

### Overview

```
User Password
      │
      ▼
┌─────────────────────────────────────────────────────┐
│  Argon2id KDF                                       │
│  (memory=64MB, iterations=3, parallelism=1)         │
│  salt stored in repo (not secret)                   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   Master Key    │  (256-bit, never stored)
              │   (in memory)   │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌─────────────┐ ┌──────────┐ ┌──────────┐
   │ Collection  │ │ Coll.    │ │ Binary   │  Per-collection keys
   │ Key: users  │ │ Key: posts│ │ Key      │  (random 256-bit)
   └──────┬──────┘ └────┬─────┘ └────┬─────┘
          │              │            │
          ▼              ▼            ▼
    ┌───────────┐  ┌──────────┐  ┌──────────┐
    │ Document  │  │ Document │  │ Chunk    │  Per-record encryption
    │ Encrypt   │  │ Encrypt  │  │ Encrypt  │  (unique nonce each time)
    └───────────┘  └──────────┘  └──────────┘
```

### Encryption Algorithm: XSalsa20-Poly1305

| Property | Value |
|----------|-------|
| Cipher | XSalsa20 (Salsa20 with extended nonce) |
| Key size | 256 bits (32 bytes) |
| Nonce size | 192 bits (24 bytes) |
| Auth tag | 128 bits (16 bytes, Poly1305) |
| Mode | AEAD (Authenticated Encryption with Associated Data) |
| Library | tweetnacl (JS) / PyNaCl (Python) |

**Why XSalsa20 over AES-GCM?**

1. **Nonce safety**: 24-byte nonces can be safely random (birthday bound at 2^96). AES-GCM's 12-byte nonce risks collision at ~2^32 messages.
2. **No hardware dependency**: AES-GCM is fast with AES-NI but slow in pure software. XSalsa20 is fast everywhere.
3. **Simplicity**: No padding modes, no block alignment. Reduces implementation bugs.
4. **Audited library**: tweetnacl is one of the most audited crypto libraries in JavaScript.

### Key Derivation: Argon2id

| Parameter | Default | Description |
|-----------|---------|-------------|
| Memory | 64 MB (65536 KiB) | RAM required per hash |
| Iterations | 3 | Time cost |
| Parallelism | 1 | Threads |
| Output | 32 bytes | Key length |
| Salt | 32 bytes (random, stored in repo) | Per-database salt |

**Why Argon2id?**

- Recommended by OWASP for password hashing
- Memory-hard: GPUs/ASICs can't parallelize cheaply
- "id" variant: Resistant to both side-channel and time-memory tradeoff attacks
- Winner of the Password Hashing Competition (2015)

**Fallback**: If Argon2 isn't available (some environments), falls back to PBKDF2-SHA256 with 600,000 iterations, then to iterated SHA-512 (100K rounds).

---

## Encrypted Blob Format

Every encrypted record on disk has this binary format:

```
┌─────────┬──────────────────────┬─────────────────────────────────┐
│ Version │ Nonce                │ Ciphertext + Auth Tag           │
│ 1 byte  │ 24 bytes             │ N + 16 bytes                    │
└─────────┴──────────────────────┴─────────────────────────────────┘
     │            │                         │
     │            │                         └── Encrypted JSON + padding
     │            └── Random, unique per record
     └── Format version (currently: 0x01)
```

### Padding

To prevent size analysis (which could reveal record types), all plaintext is padded before encryption:

```
┌──────────────┬───────────────────┬──────────────────────────────┐
│ Length (4B)  │ Original Data     │ Random Padding               │
│ big-endian   │ (variable)        │ (fills to next block boundary)│
└──────────────┴───────────────────┴──────────────────────────────┘
```

Block size defaults to 256 bytes. A 50-byte record and a 200-byte record both produce 256-byte padded output.

---

## Key Hierarchy & Rotation

### Key Store (stored at `.gitnix/keystore.dat`)

The key store is itself encrypted and contains:

```json
{
  "version": 1,
  "salt": "<base64>",
  "kdfParams": { "memoryCost": 65536, "timeCost": 3, "parallelism": 1 },
  "collections": {
    "users": {
      "encryptedKey": "<base64>",  // Collection key wrapped with master key
      "nonce": "<base64>",
      "createdAt": 1720000000000,
      "version": 1
    }
  },
  "verificationHash": "<base64>"  // Proves correct password without revealing key
}
```

### Password Rotation

When changing passwords:

1. Derive new master key from new password (new salt)
2. Re-wrap every collection key with new master key
3. Write updated keystore
4. **Data is NOT re-encrypted** — only the key-wrapping layer changes
5. This is O(number of collections), not O(number of documents)

### Password Verification

A verification hash is stored (encrypted constant with zero nonce). On login:
- Derive master key → decrypt verification hash → check result matches known constant
- If mismatch → wrong password (no data is decryptable)
- The constant is `"GITNIX_KEY_VERIFICATION_v1"`, encrypted with deterministic nonce

---

## Threat Model

### What Gitnix Protects Against

| Threat | Protection | Confidence |
|--------|-----------|------------|
| **GitHub data breach** | All data is ciphertext. No keys stored on GitHub. | ✅ Strong |
| **GitHub employee access** | Zero-knowledge. Even with full repo access, data is unreadable. | ✅ Strong |
| **Token theft** | Token gives access to ciphertext only. Without password, data is safe. | ✅ Strong |
| **Network eavesdropping** | HTTPS to GitHub + authenticated encryption (can't inject data) | ✅ Strong |
| **Brute-force password** | Argon2id with 64MB memory cost. ~0.5s per attempt on fast hardware. | ✅ Strong |
| **Record size analysis** | Fixed-block padding (configurable, default 256B) | ⚠️ Moderate |
| **Access pattern analysis** | File operations are visible to GitHub (timestamps, frequency) | ⚠️ Limited |
| **Collection count leakage** | Directories exist (but names are hashed). Count is visible. | ⚠️ Moderate |

### What Gitnix Does NOT Protect Against

| Threat | Why | Mitigation |
|--------|-----|-----------|
| **Compromised client** | If attacker has your machine, they have your key | Use hardware keys, short sessions |
| **Quantum computers** | XSalsa20 is not post-quantum | Future: switch to CRYSTALS-Kyber |
| **Malicious SDK** | Backdoored SDK could exfiltrate keys | Verify source, pin versions |
| **Timing attacks** | Network timing could reveal activity patterns | Use consistent polling |
| **GitHub repo deletion** | Attacker with token could delete data | Use branch protection, backups |

---

## Architecture Layers

### 1. Transport Layer

```
┌─────────────────────────────────────────┐
│  Transport                              │
│  ├── fetch/httpx (HTTP client)          │
│  ├── GitHub Git Data API integration    │
│  ├── Batch write (blobs → tree → commit)│
│  └── Compare-and-swap for concurrency   │
└─────────────────────────────────────────┘
```

**Key design**: Uses Git Data API (not Contents API) because:
- Batch N file changes into 1 atomic commit (3-4 API calls total)
- Each write costs 5 rate limit points regardless of batch size
- Tree operations give full repo listing in 1 call

### 2. Rate Limiter

```
┌─────────────────────────────────────────┐
│  Rate Limiter                           │
│  ├── Token bucket (primary: 5000/hr)    │
│  ├── Points tracking (secondary: 900/min)│
│  ├── Semaphore (concurrent: 10 max)     │
│  ├── Priority queue (reads before writes)│
│  └── Exponential backoff with jitter    │
└─────────────────────────────────────────┘
```

### 3. Cache Layer

```
┌─────────────────────────────────────────┐
│  Cache (LRU)                            │
│  ├── SHA-based content addressing       │
│  ├── TTL expiry (default 5 min)         │
│  ├── Hit/miss statistics                │
│  └── Memory-aware eviction              │
└─────────────────────────────────────────┘
```

**Cache invalidation**: SHA-based. If a record's Git SHA hasn't changed, the cache is fresh. This is immune to stale data bugs.

### 4. Storage Manager

```
┌─────────────────────────────────────────┐
│  Storage Manager                        │
│  ├── Multi-repo manifest                │
│  ├── Auto-create overflow repos at 4GB  │
│  ├── Collection → repo routing          │
│  └── Storage usage tracking             │
└─────────────────────────────────────────┘
```

### 5. Encryption Layer

See [Cryptographic Design](#cryptographic-design) above.

### 6. Collection Layer

```
┌─────────────────────────────────────────┐
│  Collection                             │
│  ├── In-memory document cache           │
│  ├── Dirty tracking (what needs sync)   │
│  ├── Schema validation                  │
│  ├── Index management                   │
│  └── Lazy loading from remote           │
└─────────────────────────────────────────┘
```

### 7. Query Engine

```
┌─────────────────────────────────────────┐
│  Query Engine                           │
│  ├── Full MongoDB operator set          │
│  ├── Dot-notation nested field access   │
│  ├── Multi-field sort                   │
│  ├── Projection (field selection)       │
│  └── Index-optimized lookups            │
└─────────────────────────────────────────┘
```

### 8. Transaction Layer

```
┌─────────────────────────────────────────┐
│  Transactions                           │
│  ├── Optimistic locking (SHA compare)   │
│  ├── Read-set tracking                  │
│  ├── Conflict detection at commit       │
│  ├── Configurable retry/abort/merge     │
│  └── Multi-collection atomic commits    │
└─────────────────────────────────────────┘
```

---

## Data Flow: Write Path

```
1. app.insert({name: "Alice"})
2. Generate _id (UUIDv7), add _created, _version
3. Schema validation (if configured)
4. Update in-memory Map
5. Mark document as dirty

--- On sync() ---

6. For each dirty doc:
   a. Serialize to JSON
   b. Pad to block boundary
   c. Generate random 24-byte nonce
   d. Encrypt with collection key (XSalsa20-Poly1305)
   e. Prepend version byte + nonce
   f. Base64 encode
   g. Hash ID → filename

7. Batch all operations:
   a. POST /git/blobs (create encrypted blobs) — parallel
   b. POST /git/trees (build new tree with all changes)
   c. POST /git/commits (create commit)
   d. PATCH /git/refs (update branch)

8. Clear dirty set
9. Update cache with new SHAs
```

## Data Flow: Read Path

```
1. app.find({age: {$gt: 18}})
2. Check if collection is loaded
3. If not loaded:
   a. GET /git/refs (get HEAD)
   b. GET /git/commits (get tree SHA)
   c. GET /git/trees?recursive=1 (list all files)
   d. For each .enc file in collection path:
      - Check cache by SHA
      - If miss: GET /git/blobs/{sha}
      - Base64 decode
      - Decrypt with collection key
      - Remove padding
      - Parse JSON
      - Store in memory + cache

4. Run query engine on in-memory docs
5. Apply sort, skip, limit, projection
6. Return QueryResult
```

---

## GitHub API Usage Optimization

### Write: N documents = 1 commit

| Documents | Without batching | With batching |
|-----------|-----------------|---------------|
| 1 | 5 API calls | 5 API calls |
| 10 | 50 API calls | 14 API calls |
| 100 | 500 API calls | 104 API calls |
| 1000 | 5000 API calls | 1004 API calls |

**Batching formula**: `N_blobs + 1_tree + 1_commit + 1_ref = N + 3`

### Read: Tree caching

| Operation | Cold | Warm (cached) |
|-----------|------|---------------|
| List collection | 3 API calls | 0 (cached tree) |
| Read 1 doc | 1 API call | 0 (cached blob) |
| Read 100 docs | 100 API calls | 0 (all cached) |
| After cache TTL | Refreshes | — |

---

## Comparison with Other Encrypted Storage

| Property | Gitnix | age (file encryption) | Keybase KBFS | Standard Notes |
|----------|--------|----------------------|--------------|----------------|
| Storage backend | GitHub | Local filesystem | Keybase servers | Proprietary |
| Query support | ✅ MongoDB-style | ❌ | ❌ | ❌ |
| Version history | ✅ Git commits | ❌ | ❌ | Limited |
| Multi-device | ✅ Via GitHub | Manual sync | ✅ | ✅ |
| Binary storage | ✅ Chunked | ✅ | ✅ | ❌ |
| Free tier | Unlimited (GitHub) | N/A | Limited | Limited |
| Self-hostable | ✅ Any Git server | N/A | ❌ | ✅ |
| Open source | ✅ | ✅ | Partial | ✅ |

---

## Recommendations

### For Maximum Security

```typescript
const db = new Gitnix({
  repo: 'owner/private-repo',
  token: process.env.TOKEN,
  password: generateStrongPassword(32), // 256 bits of entropy
  encryption: {
    argon2MemoryCost: 262144,    // 256 MB (4x default)
    argon2TimeCost: 5,            // More iterations
    paddingBlockSize: 1024,       // 1KB blocks (more size hiding)
  },
});
```

### For Maximum Performance

```typescript
const db = new Gitnix({
  repo: 'owner/repo',
  token: process.env.TOKEN,
  password: 'password',
  cache: { maxSize: 10000, ttl: 600000 },  // 10K items, 10 min TTL
  rateLimiter: { maxConcurrent: 20 },
  encryption: { enablePadding: false },     // Skip padding for speed
});
```
