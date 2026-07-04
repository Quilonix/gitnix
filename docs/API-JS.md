# JavaScript / TypeScript API Reference

Complete reference for the Gitnix JavaScript SDK.

---

## Table of Contents

- [Gitnix (Main Class)](#gitnix)
- [Collection](#collection)
- [Query Operators](#query-operators)
- [Update Operators](#update-operators)
- [Binary Storage](#binary-storage)
- [Transactions](#transactions)
- [Events](#events)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [Type Definitions](#type-definitions)

---

## Gitnix

The main entry point. Creates a connection to your GitHub database.

### Constructor

```typescript
import { Gitnix } from 'gitnix';

const db = new Gitnix(config: GitnixConfig);
```

#### GitnixConfig

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `repo` | `string` | ✅ | — | GitHub repo in `"owner/name"` format |
| `token` | `string` | ✅ | — | GitHub PAT or App token |
| `password` | `string` | ✅ | — | Master encryption password (never stored) |
| `branch` | `string` | ❌ | `"main"` | Branch to use |
| `overflowRepos` | `string[]` | ❌ | `[]` | Additional repos for storage overflow |
| `cache` | `CacheConfig` | ❌ | See below | Cache configuration |
| `rateLimiter` | `RateLimiterConfig` | ❌ | See below | Rate limiter config |
| `encryption` | `EncryptionConfig` | ❌ | See below | Encryption parameters |
| `apiBaseUrl` | `string` | ❌ | `"https://api.github.com"` | For GitHub Enterprise |
| `autoCreate` | `boolean` | ❌ | `false` | Auto-create repo if missing |

### Methods

#### `connect(): Promise<void>`

Connect to the database. Derives encryption keys, validates repo, loads manifest.

```typescript
await db.connect();
```

#### `disconnect(): Promise<void>`

Sync pending changes and cleanup resources.

```typescript
await db.disconnect();
```

#### `collection(name: string, options?: CollectionOptions): Collection`

Get or create a named collection.

```typescript
const users = db.collection('users');
const posts = db.collection('posts', {
  schema: { fields: { title: { type: 'string' } }, required: ['title'] },
  indexes: [{ fields: ['title'], unique: true }],
});
```

#### `sync(): Promise<{ collections: number; written: number; deleted: number }>`

Sync all pending changes to GitHub in batch commits.

```typescript
const result = await db.sync();
// { collections: 2, written: 15, deleted: 3 }
```

#### `transaction<T>(fn, options?): Promise<T>`

Execute operations atomically. See [Transactions](#transactions).

#### `dropCollection(name: string): Promise<void>`

Permanently delete a collection and all its data.

#### `listCollections(): string[]`

Get names of all active collections.

#### `changePassword(oldPassword, newPassword): Promise<void>`

Rotate the master encryption password. Re-wraps all collection keys.

#### `getStatus(): object`

Get database status including cache stats, rate limit state, and storage info.

#### `on(listener: EventListener): () => void`

Subscribe to events. Returns an unsubscribe function.

---

## Collection

Represents a collection of encrypted documents.

### Insert

```typescript
// Single document
const doc = await users.insert({ name: 'Alice', age: 30 });
// Returns: { _id: '...', _created: '...', _version: 1, name: 'Alice', age: 30 }

// Multiple documents
const docs = await users.insertMany([
  { name: 'Bob', age: 25 },
  { name: 'Charlie', age: 35 },
]);
```

### Find

```typescript
// Find all
const result = await users.find();
// { docs: [...], total: undefined, hasMore: false, executionTime: 1.2 }

// With filter
const adults = await users.find({ age: { $gte: 18 } });

// With options
const page = await users.find(
  { status: 'active' },
  {
    sort: { createdAt: -1 },   // -1 = descending
    skip: 20,
    limit: 10,
    fields: ['name', 'email'], // projection
    count: true,               // include total in result
  }
);
// { docs: [...], total: 150, hasMore: true, executionTime: 3.5 }
```

#### `findOne(filter): Promise<Document | null>`

```typescript
const alice = await users.findOne({ name: 'Alice' });
```

#### `findById(id): Promise<Document | null>`

```typescript
const doc = await users.findById('doc_abc123');
```

#### `count(filter?): Promise<number>`

```typescript
const total = await users.count({ status: 'active' });
```

### Update

```typescript
// Update matching documents
const result = await users.update(
  { name: 'Alice' },            // filter
  { $set: { age: 31 } }         // update operators
);
// { modified: 1 }

// Update by ID
const updated = await users.updateById('doc_abc', { $inc: { loginCount: 1 } });

// Replace entire document
const replaced = await users.replace(
  { name: 'Alice' },
  { name: 'Alice', age: 31, verified: true }
);
```

### Delete

```typescript
// Delete matching
const result = await users.delete({ status: 'banned' });
// { deleted: 3 }

// Delete by ID
const deleted = await users.deleteById('doc_abc');
// true | false

// Delete all
await users.deleteAll();
```

### Indexes

```typescript
// Create an index
users.createIndex({ fields: ['email'], unique: true, name: 'email_unique' });

// List indexes
const indexes = users.listIndexes();
// [{ name: 'email_unique', fields: ['email'], unique: true }]

// Drop an index
users.dropIndex('email_unique');
```

### Sync & Status

```typescript
// Manually sync this collection
await users.sync();

// Check if there are unsaved changes
users.isDirty(); // true/false

// Get stats
users.getStats();
// { name: 'users', documentCount: 150, dirtyCount: 3, indexCount: 2, loaded: true }
```

---

## Query Operators

### Comparison

| Operator | Description | Example |
|----------|-------------|---------|
| `$eq` | Equal to | `{ age: { $eq: 30 } }` or `{ age: 30 }` |
| `$ne` | Not equal | `{ status: { $ne: 'banned' } }` |
| `$gt` | Greater than | `{ age: { $gt: 18 } }` |
| `$gte` | Greater or equal | `{ age: { $gte: 18 } }` |
| `$lt` | Less than | `{ price: { $lt: 100 } }` |
| `$lte` | Less or equal | `{ price: { $lte: 100 } }` |
| `$in` | In array | `{ role: { $in: ['admin', 'mod'] } }` |
| `$nin` | Not in array | `{ status: { $nin: ['banned', 'suspended'] } }` |

### Logical

| Operator | Description | Example |
|----------|-------------|---------|
| `$and` | All must match | `{ $and: [{ age: { $gte: 18 } }, { age: { $lte: 65 } }] }` |
| `$or` | Any must match | `{ $or: [{ role: 'admin' }, { role: 'mod' }] }` |
| `$not` | Negate | `{ age: { $not: { $lt: 18 } } }` |

### String

| Operator | Description | Example |
|----------|-------------|---------|
| `$contains` | Substring (case-insensitive) | `{ bio: { $contains: 'developer' } }` |
| `$startsWith` | Starts with | `{ name: { $startsWith: 'Al' } }` |
| `$endsWith` | Ends with | `{ email: { $endsWith: '@gmail.com' } }` |
| `$regex` | Regular expression | `{ phone: { $regex: '^\\+1' } }` |

### Array

| Operator | Description | Example |
|----------|-------------|---------|
| `$size` | Array length | `{ tags: { $size: 3 } }` |
| `$elemMatch` | Element matches | `{ scores: { $elemMatch: { $gt: 90 } } }` |

### Existence

| Operator | Description | Example |
|----------|-------------|---------|
| `$exists` | Field exists | `{ phone: { $exists: true } }` |
| `$type` | Type check | `{ age: { $type: 'number' } }` |

### Query Builder (optional helper)

```typescript
import { query, $gte, $lte, $contains } from 'gitnix';

const filter = query()
  .where('age', $gte(18))
  .where('name', $contains('ali'))
  .build();
```

---

## Update Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `$set` | Set fields | `{ $set: { name: 'Bob', age: 26 } }` |
| `$unset` | Remove fields | `{ $unset: { tempField: true } }` |
| `$inc` | Increment number | `{ $inc: { views: 1, score: -5 } }` |
| `$push` | Push to array | `{ $push: { tags: 'new-tag' } }` |
| `$pull` | Remove from array | `{ $pull: { tags: 'old-tag' } }` |
| `$addToSet` | Push unique | `{ $addToSet: { followers: 'user123' } }` |
| `$rename` | Rename field | `{ $rename: { oldName: 'newName' } }` |
| `$min` | Set if less | `{ $min: { lowestScore: 45 } }` |
| `$max` | Set if greater | `{ $max: { highScore: 99 } }` |

---

## Binary Storage

Access via `db.binary`.

### Upload

```typescript
const imageData = fs.readFileSync('photo.png');

const metadata = await db.binary.upload(imageData, {
  filename: 'photo.png',           // optional
  mimeType: 'image/png',           // auto-detected if omitted
  metadata: { userId: 'abc' },     // custom metadata
  chunkSize: 512 * 1024,           // 512KB chunks (default)
  onProgress: (progress) => {
    console.log(`${progress.percentage}% uploaded`);
  },
});

// Returns: BinaryMetadata
// { id, filename, mimeType, size, chunkCount, hash, uploadedAt, width?, height? }
```

### Download

```typescript
const data = await db.binary.download('file-id', {
  onProgress: (p) => console.log(`${p.percentage}%`),
  range: { start: 0, end: 1023 },  // partial download
});
```

### Other Operations

```typescript
// Get metadata without downloading
const meta = await db.binary.getMetadata('file-id');

// List all files
const files = await db.binary.list();

// Delete
await db.binary.delete('file-id');
```

### Supported MIME Types (auto-detected)

JPEG, PNG, GIF, WebP, BMP, PDF, ZIP, GZIP, MP3, MP4, WAV, OGG, FLAC, AVI, MKV, DOC/DOCX, XLS/XLSX, PPT/PPTX, JSON, XML, HTML, CSS, JS, TXT, and more.

---

## Transactions

Atomic multi-collection operations with optimistic locking.

```typescript
const result = await db.transaction(async (tx) => {
  const posts = tx.collection('posts');
  const comments = tx.collection('comments');

  const post = await posts.insert({ title: 'Hello', likes: 0 });
  await comments.insert({ postId: post._id, body: 'First!' });

  return post;
}, {
  maxRetries: 3,                    // retry on conflict
  timeout: 30000,                   // 30s timeout
  conflictStrategy: 'retry',        // 'retry' | 'abort' | 'merge'
});
```

### Conflict Strategies

| Strategy | Behavior |
|----------|----------|
| `retry` | Re-read HEAD and retry (default) |
| `abort` | Throw immediately on conflict |
| `merge` | Attempt field-level merge, then retry |
| `custom` | Use provided `mergeFn` |

---

## Events

```typescript
const unsubscribe = db.on((event) => {
  switch (event.type) {
    case 'connected':         // { repo }
    case 'disconnected':      // { reason? }
    case 'sync:start':        // { collections }
    case 'sync:complete':     // { duration }
    case 'sync:error':        // { error }
    case 'cache:hit':         // { key }
    case 'cache:miss':        // { key }
    case 'ratelimit:warning': // { remaining, reset }
    case 'ratelimit:exceeded':// { retryAfter }
    case 'storage:overflow':  // { repo, newRepo }
    case 'conflict:detected': // { collection, documentId }
    case 'error':             // { error, context }
  }
});

// Later
unsubscribe();
```

---

## Error Handling

All errors are `GitnixError` instances with a `code` property.

```typescript
import { GitnixError, GitnixErrorCode } from 'gitnix';

try {
  await users.insert(data);
} catch (err) {
  if (err instanceof GitnixError) {
    switch (err.code) {
      case GitnixErrorCode.RATE_LIMITED:
        // Wait and retry
        break;
      case GitnixErrorCode.DUPLICATE_ID:
        // Document already exists
        break;
      case GitnixErrorCode.SCHEMA_VIOLATION:
        // Data doesn't match schema
        console.log(err.details.errors);
        break;
      case GitnixErrorCode.DECRYPTION_FAILED:
        // Wrong password or corrupted data
        break;
    }
  }
}
```

### Error Codes

| Code | When |
|------|------|
| `NETWORK_ERROR` | Can't reach GitHub |
| `RATE_LIMITED` | Hit rate limit |
| `AUTH_FAILED` | Invalid token |
| `REPO_NOT_FOUND` | Repo doesn't exist |
| `ENCRYPTION_FAILED` | Encryption error |
| `DECRYPTION_FAILED` | Wrong key or corrupt data |
| `INVALID_PASSWORD` | Password verification failed |
| `STORAGE_FULL` | All repos at capacity |
| `FILE_TOO_LARGE` | Exceeds 100MB limit |
| `DUPLICATE_ID` | ID already exists |
| `SCHEMA_VIOLATION` | Validation failed |
| `TRANSACTION_CONFLICT` | Concurrent write detected |
| `TRANSACTION_TIMEOUT` | Transaction took too long |
| `NOT_CONNECTED` | Call `connect()` first |

---

## Configuration

### CacheConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxSize` | `number` | `5000` | Max cached items |
| `ttl` | `number` | `300000` | TTL in ms (5 min) |
| `persistent` | `boolean` | `false` | Persist cache to disk |

### RateLimiterConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxRequestsPerHour` | `number` | `5000` | Primary limit |
| `maxConcurrent` | `number` | `10` | Parallel requests |
| `maxWritesPerMinute` | `number` | `20` | Write throttle |
| `retryAttempts` | `number` | `3` | Retries on limit |
| `retryBaseDelay` | `number` | `1000` | Base backoff (ms) |

### EncryptionConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `argon2MemoryCost` | `number` | `65536` | Argon2 memory (KiB) |
| `argon2TimeCost` | `number` | `3` | Argon2 iterations |
| `argon2Parallelism` | `number` | `1` | Argon2 threads |
| `enablePadding` | `boolean` | `true` | Size-hide padding |
| `paddingBlockSize` | `number` | `256` | Block size (bytes) |

---

## Type Definitions

### Document

```typescript
interface Document {
  _id: string;         // Auto-generated UUIDv7
  _created: string;    // ISO timestamp
  _updated: string;    // ISO timestamp
  _version: number;    // Increments on update
  [key: string]: unknown;
}
```

### QueryResult

```typescript
interface QueryResult<T = Document> {
  docs: T[];           // Matching documents
  total?: number;      // Total (if count: true)
  hasMore: boolean;    // More results available
  executionTime: number; // Ms
}
```

### BinaryMetadata

```typescript
interface BinaryMetadata {
  id: string;
  filename: string;
  mimeType: string;
  size: number;         // bytes
  chunkCount: number;
  chunkSize: number;
  hash: string;         // SHA-256
  uploadedAt: string;
  width?: number;       // images only
  height?: number;      // images only
  metadata?: Record<string, unknown>;
}
```
