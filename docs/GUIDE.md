# Usage Guide & Examples

Practical recipes and real-world patterns for using Gitnix.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Recipe: Notes App](#recipe-notes-app)
- [Recipe: Config/Secrets Store](#recipe-configsecrets-store)
- [Recipe: User Profiles](#recipe-user-profiles)
- [Recipe: IoT Data Logging](#recipe-iot-data-logging)
- [Recipe: File Storage](#recipe-file-storage)
- [Advanced: Multi-Collection Transactions](#advanced-multi-collection-transactions)
- [Advanced: Schema Validation](#advanced-schema-validation)
- [Advanced: Custom Indexes](#advanced-custom-indexes)
- [Advanced: Multi-Repo Overflow](#advanced-multi-repo-overflow)
- [Deployment Patterns](#deployment-patterns)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### Prerequisites

1. A GitHub account
2. A Personal Access Token with `repo` scope
3. Node.js 18+ (JS) or Python 3.10+ (Python)

### Generate a Token

```bash
# Using GitHub CLI
gh auth token

# Or create manually at:
# https://github.com/settings/tokens → "Generate new token (classic)"
# Select scope: repo
```

### First Connection

```javascript
// JavaScript
import { Gitnix } from 'gitnix';

const db = new Gitnix({
  repo: 'your-username/my-database',  // Will be created if autoCreate: true
  token: process.env.GITHUB_TOKEN,
  password: 'choose-a-strong-password',
  autoCreate: true,
});

await db.connect();
console.log('Connected!', db.getStatus());
await db.disconnect();
```

```python
# Python
import os
from gitnix import Gitnix
from gitnix.types import GitnixConfig

async with Gitnix(GitnixConfig(
    repo="your-username/my-database",
    token=os.environ["GITHUB_TOKEN"],
    password="choose-a-strong-password",
)) as db:
    print("Connected!", db.get_status())
```

---

## Recipe: Notes App

A complete encrypted notes application.

### JavaScript

```javascript
const db = new Gitnix({ repo: 'user/notes-db', token, password });
await db.connect();

const notes = db.collection('notes');

// Create a note
const note = await notes.insert({
  title: 'Meeting Notes',
  content: 'Discussed Q3 roadmap...',
  tags: ['work', 'meetings'],
  color: '#fff3cd',
  pinned: false,
});

// Search notes
const workNotes = await notes.find(
  { tags: { $in: ['work'] } },
  { sort: { _updated: -1 }, limit: 20 }
);

// Full-text-like search
const results = await notes.find({
  $or: [
    { title: { $contains: 'roadmap' } },
    { content: { $contains: 'roadmap' } },
  ]
});

// Pin a note
await notes.update({ _id: note._id }, { $set: { pinned: true } });

// Archive old notes
await notes.update(
  { _updated: { $lt: '2026-01-01' } },
  { $set: { archived: true } }
);

await db.sync();
await db.disconnect();
```

### Python

```python
async with db:
    notes = db.collection("notes")

    note = await notes.insert({
        "title": "Meeting Notes",
        "content": "Discussed Q3 roadmap...",
        "tags": ["work", "meetings"],
    })

    # Search
    work_notes = await notes.find(
        {"tags": {"$in": ["work"]}},
        QueryOptions(sort={"_updated": -1}, limit=20)
    )

    # Update
    await notes.update({"_id": note["_id"]}, {"$set": {"pinned": True}})
```

---

## Recipe: Config/Secrets Store

Store sensitive configuration with full audit trail.

```javascript
const db = new Gitnix({ repo: 'org/secure-config', token, password });
await db.connect();

const config = db.collection('config');

// Store secrets
await config.insert({
  _id: 'production',
  database_url: 'postgres://user:pass@host:5432/db',
  api_keys: {
    stripe: 'sk_live_xxxxx',
    sendgrid: 'SG.yyyyy',
  },
  feature_flags: {
    new_checkout: true,
    dark_mode: false,
  },
});

// Read config
const prod = await config.findById('production');
console.log(prod.api_keys.stripe); // Decrypted on your machine only

// Update a flag
await config.update(
  { _id: 'production' },
  { $set: { 'feature_flags.dark_mode': true } }
);

// GitHub sees: .gitnix/collections/a7f3e.../8b2c4d.enc
// Nobody can read the secrets without the password

await db.sync();
```

---

## Recipe: User Profiles

A user management system with validation.

```javascript
const users = db.collection('users', {
  schema: {
    fields: {
      name: { type: 'string', min: 2, max: 100 },
      email: { type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$' },
      age: { type: 'number', min: 0, max: 150 },
      role: { type: 'string', enum: ['admin', 'user', 'moderator'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'email'],
    additionalProperties: false,
  },
  indexes: [
    { fields: ['email'], unique: true },
    { fields: ['role'] },
  ],
});

// This works
await users.insert({ name: 'Alice', email: 'alice@example.com', age: 30, role: 'admin', tags: [] });

// This throws SCHEMA_VIOLATION (missing email)
await users.insert({ name: 'Bob' });

// This throws DUPLICATE_ID (unique index on email)
await users.insert({ name: 'Fake Alice', email: 'alice@example.com', role: 'user', tags: [] });

// Query using indexed field (faster)
const admins = await users.find({ role: 'admin' });
```

---

## Recipe: IoT Data Logging

Push telemetry from devices.

```javascript
const telemetry = db.collection('telemetry');

// Each device pushes readings
await telemetry.insert({
  deviceId: 'sensor-001',
  temperature: 23.5,
  humidity: 65,
  battery: 0.87,
  location: { lat: 37.7749, lng: -122.4194 },
  timestamp: new Date().toISOString(),
});

// Query recent readings from a device
const recent = await telemetry.find(
  { deviceId: 'sensor-001', timestamp: { $gte: '2026-07-01' } },
  { sort: { timestamp: -1 }, limit: 100 }
);

// Find low battery devices
const lowBattery = await telemetry.find({ battery: { $lt: 0.2 } });

// Aggregate-like: get count per device
const allReadings = await telemetry.find({});
const perDevice = {};
for (const doc of allReadings.docs) {
  perDevice[doc.deviceId] = (perDevice[doc.deviceId] || 0) + 1;
}
```

---

## Recipe: File Storage

Upload and manage files with metadata.

```javascript
import fs from 'fs';

// Upload a document
const pdfData = fs.readFileSync('report.pdf');
const pdfMeta = await db.binary.upload(pdfData, {
  filename: 'Q3-Report-2026.pdf',
  metadata: { department: 'finance', year: 2026 },
  onProgress: (p) => console.log(`Uploading: ${p.percentage}%`),
});
console.log(`Uploaded: ${pdfMeta.id} (${pdfMeta.size} bytes, ${pdfMeta.chunkCount} chunks)`);

// Upload an image
const avatar = fs.readFileSync('avatar.png');
const imgMeta = await db.binary.upload(avatar, { filename: 'avatar.png' });
console.log(`Image: ${imgMeta.width}x${imgMeta.height}`);

// List all files
const files = await db.binary.list();
for (const f of files) {
  console.log(`  ${f.filename} (${f.mimeType}, ${f.size} bytes)`);
}

// Download
const data = await db.binary.download(pdfMeta.id);
fs.writeFileSync('downloaded-report.pdf', data);

// Delete
await db.binary.delete(pdfMeta.id);
```

---

## Advanced: Multi-Collection Transactions

Ensure data consistency across collections.

```javascript
// Transfer credits between users atomically
const result = await db.transaction(async (tx) => {
  const accounts = tx.collection('accounts');
  const ledger = tx.collection('ledger');

  const sender = await accounts.findOne({ _id: 'user-001' });
  const receiver = await accounts.findOne({ _id: 'user-002' });

  if (sender.balance < 100) throw new Error('Insufficient funds');

  await accounts.update({ _id: 'user-001' }, { $inc: { balance: -100 } });
  await accounts.update({ _id: 'user-002' }, { $inc: { balance: 100 } });

  await ledger.insert({
    from: 'user-001',
    to: 'user-002',
    amount: 100,
    timestamp: new Date().toISOString(),
  });

  return { transferred: 100 };
}, {
  maxRetries: 5,
  conflictStrategy: 'retry',
});
```

---

## Advanced: Schema Validation

```javascript
const products = db.collection('products', {
  schema: {
    fields: {
      name: { type: 'string', min: 1, max: 200 },
      price: { type: 'number', min: 0 },
      currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
      inStock: { type: 'boolean' },
      tags: { type: 'array', max: 10, items: { type: 'string', max: 50 } },
      dimensions: {
        type: 'object',
        properties: {
          width: { type: 'number', min: 0 },
          height: { type: 'number', min: 0 },
          weight: { type: 'number', min: 0 },
        },
      },
    },
    required: ['name', 'price', 'currency'],
    additionalProperties: false,
  },
});
```

---

## Advanced: Custom Indexes

```javascript
const logs = db.collection('logs');

// Create indexes for common queries
logs.createIndex({ fields: ['level'], name: 'idx_level' });
logs.createIndex({ fields: ['service'], name: 'idx_service' });
logs.createIndex({ fields: ['userId'], name: 'idx_user', sparse: true });

// These queries now use indexes (no full scan):
await logs.find({ level: 'error' });           // Uses idx_level
await logs.find({ service: 'auth-service' });  // Uses idx_service
await logs.find({ userId: { $in: ['u1', 'u2'] } });  // Uses idx_user
```

---

## Advanced: Multi-Repo Overflow

When your data grows beyond GitHub's per-repo limit:

```javascript
const db = new Gitnix({
  repo: 'org/main-db',
  token: process.env.TOKEN,
  password: 'key',
  overflowRepos: ['org/db-overflow-1', 'org/db-overflow-2'],
});

await db.connect();

// SDK automatically routes writes to repos with space
// When all overflow repos are full, it creates a new one
const storage = db.getStatus().storage;
console.log(`Using ${storage.repoCount} repos, ${(storage.totalUsed / 1e9).toFixed(1)}GB used`);
```

---

## Deployment Patterns

### 1. Serverless (Lambda / Vercel)

```javascript
// No persistent connection needed!
export default async function handler(req) {
  const db = new Gitnix({ repo, token, password });
  await db.connect();

  const users = db.collection('users');
  const result = await users.find({ active: true });

  await db.disconnect();
  return Response.json(result.docs);
}
```

### 2. Long-running Server

```javascript
// Connect once, reuse
const db = new Gitnix({ repo, token, password });
await db.connect();

// Periodic sync (don't sync on every write)
setInterval(() => db.sync(), 30000); // Every 30s

app.post('/api/data', async (req, res) => {
  const coll = db.collection('data');
  const doc = await coll.insert(req.body);
  res.json(doc);
  // Will be synced in next interval
});
```

### 3. CLI Tool

```python
import asyncio
from gitnix import Gitnix
from gitnix.types import GitnixConfig

async def main():
    async with Gitnix(GitnixConfig(repo=REPO, token=TOKEN, password=PWD)) as db:
        secrets = db.collection("secrets")
        # One-shot operation
        await secrets.insert({"key": "API_KEY", "value": "sk_live_xxx"})
        print("Secret stored!")

asyncio.run(main())
```

---

## Troubleshooting

### "Rate limited" errors

**Cause**: Too many API calls.
**Fix**: Increase cache TTL, batch writes with `db.sync()` instead of per-write sync, use `maxConcurrent: 5`.

### "Decryption failed"

**Cause**: Wrong password, or data was encrypted with a different password.
**Fix**: Use the same password that was used when the data was created.

### "Repo not found"

**Cause**: Token doesn't have access, or repo doesn't exist.
**Fix**: Check token scopes (needs `repo`). Set `autoCreate: true` to create automatically.

### "Transaction conflict"

**Cause**: Another client wrote to the same repo during your transaction.
**Fix**: Increase `maxRetries` or use `conflictStrategy: 'merge'`.

### Slow first load

**Cause**: Large collection being downloaded and decrypted.
**Fix**: Use indexes to avoid loading everything. Consider splitting into smaller collections.

### "File too large"

**Cause**: Trying to store a file > 100MB.
**Fix**: GitHub has a 100MB file limit. Use chunked binary storage (automatic for `db.binary`).

---

## Best Practices

1. **Batch your writes** — Don't call `sync()` after every insert. Accumulate changes and sync periodically.
2. **Use indexes** — Create indexes on fields you frequently query.
3. **Keep collections reasonable** — < 10,000 documents per collection is ideal.
4. **Use strong passwords** — At least 20 characters with mixed case, numbers, symbols.
5. **Don't store the password in code** — Use environment variables.
6. **Monitor rate limits** — Subscribe to `ratelimit:warning` events.
7. **Test with mock transport** — Use the mock transport for unit tests (no API calls).
8. **Pin dependency versions** — Crypto libraries should always be pinned.
