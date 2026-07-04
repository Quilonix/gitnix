/**
 * ═══════════════════════════════════════════════════════════════
 * Gitnix Events — Database Layer
 * ═══════════════════════════════════════════════════════════════
 *
 * Encrypted local database using tweetnacl (XSalsa20-Poly1305).
 * Stores data as encrypted JSON files on disk, syncs to GitHub.
 * Collections: users, events, registrations
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '.data');

// ═══════════════════════════════════════════════════════════════════════════════
// ENCRYPTION
// ═══════════════════════════════════════════════════════════════════════════════

class Encryption {
  #key;

  constructor(password) {
    // Derive a 32-byte key from password using SHA-256-like stretching
    const passBytes = naclUtil.decodeUTF8(password);
    this.#key = nacl.hash(passBytes).slice(0, 32);
  }

  encrypt(data) {
    const json = JSON.stringify(data);
    const messageBytes = naclUtil.decodeUTF8(json);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const encrypted = nacl.secretbox(messageBytes, nonce, this.#key);

    // Format: base64(nonce + ciphertext)
    const full = new Uint8Array(nonce.length + encrypted.length);
    full.set(nonce);
    full.set(encrypted, nonce.length);
    return naclUtil.encodeBase64(full);
  }

  decrypt(encryptedBase64) {
    const full = naclUtil.decodeBase64(encryptedBase64);
    const nonce = full.slice(0, nacl.secretbox.nonceLength);
    const ciphertext = full.slice(nacl.secretbox.nonceLength);
    const decrypted = nacl.secretbox.open(ciphertext, nonce, this.#key);

    if (!decrypted) {
      throw new Error('Decryption failed — wrong password or corrupted data');
    }
    return JSON.parse(naclUtil.encodeUTF8(decrypted));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

class Collection {
  #name;
  #encryption;
  #github;
  #filePath;
  #docs = [];
  #loaded = false;

  constructor(name, encryption, github) {
    this.#name = name;
    this.#encryption = encryption;
    this.#github = github;
    this.#filePath = path.join(DATA_DIR, `${name}.enc`);
  }

  #load() {
    if (this.#loaded) return;
    try {
      if (fs.existsSync(this.#filePath)) {
        const raw = fs.readFileSync(this.#filePath, 'utf-8');
        this.#docs = this.#encryption.decrypt(raw);
      }
    } catch {
      this.#docs = [];
    }
    this.#loaded = true;
  }

  #save() {
    const encrypted = this.#encryption.encrypt(this.#docs);
    fs.writeFileSync(this.#filePath, encrypted, 'utf-8');
  }

  // Insert a document, returns the doc with _id and timestamps
  insert(doc) {
    this.#load();
    const record = {
      _id: uuidv4(),
      ...doc,
      _createdAt: new Date().toISOString(),
      _updatedAt: new Date().toISOString(),
    };
    this.#docs.push(record);
    this.#save();
    return record;
  }

  // Find all documents matching a query (simple key-value matching)
  find(query = {}) {
    this.#load();
    return this.#docs.filter(doc => this.#matches(doc, query));
  }

  // Find one document
  findOne(query = {}) {
    this.#load();
    return this.#docs.find(doc => this.#matches(doc, query)) || null;
  }

  // Find by ID
  findById(id) {
    this.#load();
    return this.#docs.find(doc => doc._id === id) || null;
  }

  // Update documents matching query
  update(query, updates) {
    this.#load();
    let count = 0;
    this.#docs = this.#docs.map(doc => {
      if (this.#matches(doc, query)) {
        count++;
        return { ...doc, ...updates, _id: doc._id, _createdAt: doc._createdAt, _updatedAt: new Date().toISOString() };
      }
      return doc;
    });
    if (count > 0) this.#save();
    return count;
  }

  // Update by ID
  updateById(id, updates) {
    return this.update({ _id: id }, updates);
  }

  // Delete documents matching query
  delete(query) {
    this.#load();
    const before = this.#docs.length;
    this.#docs = this.#docs.filter(doc => !this.#matches(doc, query));
    const count = before - this.#docs.length;
    if (count > 0) this.#save();
    return count;
  }

  // Delete by ID
  deleteById(id) {
    return this.delete({ _id: id });
  }

  // Count documents
  count(query = {}) {
    this.#load();
    if (Object.keys(query).length === 0) return this.#docs.length;
    return this.#docs.filter(doc => this.#matches(doc, query)).length;
  }

  // Sync encrypted data to GitHub
  async syncToGitHub() {
    this.#load();
    if (this.#docs.length === 0) return { pushed: false, reason: 'empty' };

    const encrypted = this.#encryption.encrypt(this.#docs);
    const start = performance.now();
    await this.#github.pushFile(`${this.#name}.enc`, encrypted);
    const latency = performance.now() - start;
    return { pushed: true, docs: this.#docs.length, latency: Math.round(latency) };
  }

  // Pull encrypted data from GitHub (overwrite local)
  async pullFromGitHub() {
    const start = performance.now();
    const content = await this.#github.pullFile(`${this.#name}.enc`);
    const latency = performance.now() - start;

    if (!content) return { pulled: false, reason: 'not found on GitHub', latency: Math.round(latency) };

    this.#docs = this.#encryption.decrypt(content);
    this.#loaded = true;
    this.#save(); // Save locally too
    return { pulled: true, docs: this.#docs.length, latency: Math.round(latency) };
  }

  // Simple query matcher (supports direct equality and basic operators)
  #matches(doc, query) {
    for (const [key, value] of Object.entries(query)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Operator queries: { age: { $gt: 18 } }
        for (const [op, operand] of Object.entries(value)) {
          switch (op) {
            case '$gt': if (!(doc[key] > operand)) return false; break;
            case '$gte': if (!(doc[key] >= operand)) return false; break;
            case '$lt': if (!(doc[key] < operand)) return false; break;
            case '$lte': if (!(doc[key] <= operand)) return false; break;
            case '$ne': if (doc[key] === operand) return false; break;
            case '$in': if (!operand.includes(doc[key])) return false; break;
            case '$contains': if (!String(doc[key]).includes(operand)) return false; break;
            default: break;
          }
        }
      } else {
        if (doc[key] !== value) return false;
      }
    }
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

class Database {
  #encryption;
  #collections = new Map();
  #github;

  constructor(password, githubToken, githubRepo) {
    if (!password) throw new Error('DB_PASSWORD is required');

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    this.#encryption = new Encryption(password);
    this.#github = new GitHubSync(githubToken, githubRepo);
  }

  get githubEnabled() { return this.#github.enabled; }

  collection(name) {
    if (!this.#collections.has(name)) {
      this.#collections.set(name, new Collection(name, this.#encryption, this.#github));
    }
    return this.#collections.get(name);
  }

  // Sync all collections to GitHub
  async sync() {
    if (!this.#github.enabled) return { synced: false, reason: 'GitHub not configured' };

    await this.#github.ensureRepo();
    const results = [];

    for (const [name, col] of this.#collections) {
      const result = await col.syncToGitHub();
      results.push({ collection: name, ...result });
    }

    return { synced: true, collections: results };
  }

  // Pull all collections from GitHub (overwrite local)
  async pull() {
    if (!this.#github.enabled) return { pulled: false, reason: 'GitHub not configured' };

    const results = [];
    for (const [name, col] of this.#collections) {
      const result = await col.pullFromGitHub();
      results.push({ collection: name, ...result });
    }

    return { pulled: true, collections: results };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GITHUB SYNC
// ═══════════════════════════════════════════════════════════════════════════════

class GitHubSync {
  #token;
  #repo;
  #branch = 'main';
  #enabled = false;

  constructor(token, repo) {
    this.#token = token;
    this.#repo = repo;
    this.#enabled = !!(token && repo && !token.includes('not-needed'));
  }

  get enabled() { return this.#enabled; }

  async #api(method, endpoint, body = null) {
    const url = `https://api.github.com/repos/${this.#repo}${endpoint}`;
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${this.#token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`GitHub API ${res.status}: ${err}`);
    }
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  }

  // Push a single encrypted file to the repo
  async pushFile(filename, content) {
    if (!this.#enabled) return;

    const path = `.gitnix/${filename}`;
    const encoded = Buffer.from(content).toString('base64');

    // Check if file exists (to get SHA for update)
    const existing = await this.#api('GET', `/contents/${path}?ref=${this.#branch}`);

    const body = {
      message: `sync: ${filename}`,
      content: encoded,
      branch: this.#branch,
    };

    if (existing.status === 200) {
      body.sha = existing.data.sha;
    }

    await this.#api('PUT', `/contents/${path}`, body);
  }

  // Pull a single encrypted file from the repo
  async pullFile(filename) {
    if (!this.#enabled) return null;

    const path = `.gitnix/${filename}`;
    const res = await this.#api('GET', `/contents/${path}?ref=${this.#branch}`);

    if (res.status === 404) return null;
    return Buffer.from(res.data.content, 'base64').toString('utf-8');
  }

  // Ensure the repo has at least one commit (needed for new empty repos)
  async ensureRepo() {
    if (!this.#enabled) return;

    try {
      const res = await this.#api('GET', `/contents/.gitnix?ref=${this.#branch}`);
      if (res.status === 404) {
        // Create initial README to init the repo
        await this.#api('PUT', '/contents/README.md', {
          message: 'init: Gitnix encrypted database',
          content: Buffer.from('# Gitnix Database\n\nEncrypted data store. Nothing to see here.\n').toString('base64'),
          branch: this.#branch,
        });
      }
    } catch (err) {
      // If branch doesn't exist, the repo is truly empty — create it
      if (err.message.includes('409') || err.message.includes('empty')) {
        await this.#api('PUT', '/contents/README.md', {
          message: 'init: Gitnix encrypted database',
          content: Buffer.from('# Gitnix Database\n\nEncrypted data store.\n').toString('base64'),
        });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

let db = null;

export function initDatabase(password, githubToken, githubRepo) {
  db = new Database(password, githubToken, githubRepo);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export default { initDatabase, getDb };
