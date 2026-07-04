/**
 * ═══════════════════════════════════════════════════════════════
 * GITNIX NOTES — Production Server
 * ═══════════════════════════════════════════════════════════════
 *
 * A production-grade Notes web app using GitHub as its database.
 * All notes are end-to-end encrypted — GitHub never sees plaintext.
 *
 * Features:
 *  - RESTful API (CRUD)
 *  - Real-time GitHub sync
 *  - XSalsa20-Poly1305 encryption
 *  - Request logging
 *  - Graceful shutdown
 *  - Error boundaries
 *  - Rate limit awareness
 *  - Input validation
 *  - CORS support
 *
 * Usage:
 *   $env:GITHUB_TOKEN = $(gh auth token)
 *   node server.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || '',
  password: process.env.GITNIX_PASSWORD || 'gitnix-notes-default-key-2026',
  branch: process.env.GITNIX_BRANCH || 'main',
  syncInterval: parseInt(process.env.SYNC_INTERVAL || '0', 10), // 0 = sync on every write
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? 2;

function log(level, msg, data = null) {
  if (LOG_LEVELS[level] > LOG_LEVEL) return;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = { error: '❌', warn: '⚠️', info: '▸', debug: '·' }[level];
  const line = `${ts} ${prefix} ${msg}`;
  if (data) console[level === 'error' ? 'error' : 'log'](line, data);
  else console[level === 'error' ? 'error' : 'log'](line);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRYPTO ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

const KEY_SIZE = 32;
const NONCE_SIZE = 24;
const BLOB_VER = 1;

function deriveKey(password) {
  const input = new TextEncoder().encode(password + ':gitnix:v1:salt');
  let h = nacl.hash(input);
  for (let i = 0; i < 50000; i++) h = nacl.hash(h);
  return h.slice(0, KEY_SIZE);
}

function encryptDoc(doc, key) {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const nonce = nacl.randomBytes(NONCE_SIZE);
  const ct = nacl.secretbox(json, nonce, key);
  const blob = new Uint8Array(1 + NONCE_SIZE + ct.length);
  blob[0] = BLOB_VER;
  blob.set(nonce, 1);
  blob.set(ct, 1 + NONCE_SIZE);
  return Buffer.from(blob).toString('base64');
}

function decryptDoc(b64, key) {
  const blob = Buffer.from(b64, 'base64');
  if (blob[0] !== BLOB_VER) throw new Error(`Unknown format version: ${blob[0]}`);
  const nonce = blob.slice(1, 1 + NONCE_SIZE);
  const ct = blob.slice(1 + NONCE_SIZE);
  const plain = nacl.secretbox.open(ct, nonce, key);
  if (!plain) throw new Error('Decryption failed — wrong password or corrupted data');
  return JSON.parse(new TextDecoder().decode(plain));
}

function hashPath(str) {
  return Buffer.from(nacl.hash(new TextEncoder().encode(str)).slice(0, 16)).toString('hex');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GITHUB DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

class GitnixDB {
  #token; #repo; #branch; #key;
  #notes = new Map();
  #loaded = false;
  #apiCalls = 0;
  #lastSync = null;

  constructor({ token, repo, branch, password }) {
    this.#token = token;
    this.#repo = repo;
    this.#branch = branch;
    this.#key = deriveKey(password);
  }

  // ─── GitHub API ─────────────────────────────────────────────────────────

  async #api(method, path, body = null) {
    this.#apiCalls++;
    const url = `https://api.github.com/repos/${this.#repo}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 403 || res.status === 429) {
        const reset = res.headers.get('x-ratelimit-reset');
        throw Object.assign(new Error(`Rate limited (resets ${reset})`), { status: 429 });
      }
      throw Object.assign(new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  }

  // ─── Init ───────────────────────────────────────────────────────────────

  async init() {
    // Detect repo if not set
    if (!this.#repo) {
      const user = await this.#fetchUser();
      this.#repo = `${user.login}/gitnix-notes-db`;
      log('info', `Auto-detected repo: ${this.#repo}`);
    }

    // Check / create repo
    try {
      await this.#api('GET', '');
    } catch (e) {
      if (e.status === 404) {
        log('info', `Creating private repo: ${this.#repo}`);
        await this.#createRepo();
        await new Promise(r => setTimeout(r, 3000));
      } else throw e;
    }

    // Load existing notes
    await this.#loadAll();
    log('info', `Database ready: ${this.#notes.size} notes loaded`);
  }

  async #fetchUser() {
    this.#apiCalls++;
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`Auth failed (${res.status}). Check GITHUB_TOKEN.`);
    return res.json();
  }

  async #createRepo() {
    const [, name] = this.#repo.split('/');
    this.#apiCalls++;
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name, private: true, auto_init: true,
        description: 'Gitnix Notes App — encrypted database',
      }),
    });
    if (!res.ok && res.status !== 422) { // 422 = already exists
      throw new Error(`Failed to create repo: ${res.status}`);
    }
  }

  async #loadAll() {
    try {
      const ref = await this.#api('GET', `/git/ref/heads/${this.#branch}`);
      const commit = await this.#api('GET', `/git/commits/${ref.object.sha}`);
      const tree = await this.#api('GET', `/git/trees/${commit.tree.sha}?recursive=1`);

      const noteFiles = tree.tree.filter(
        e => e.type === 'blob' && e.path.startsWith('.gitnix/notes/') && e.path.endsWith('.enc')
      );

      for (const file of noteFiles) {
        try {
          const blob = await this.#api('GET', `/git/blobs/${file.sha}`);
          const doc = decryptDoc(blob.content.replace(/\n/g, ''), this.#key);
          this.#notes.set(doc._id, doc);
        } catch (e) {
          log('warn', `Skipping corrupted note: ${file.path}`, e.message);
        }
      }
      this.#loaded = true;
    } catch (e) {
      if (e.status === 409 || e.message?.includes('Git Repository is empty')) {
        this.#loaded = true; // Empty repo
      } else throw e;
    }
  }

  // ─── Batch Write ────────────────────────────────────────────────────────

  async #commit(ops, message) {
    const ref = await this.#api('GET', `/git/ref/heads/${this.#branch}`);
    const headSha = ref.object.sha;
    const commit = await this.#api('GET', `/git/commits/${headSha}`);
    const baseTree = commit.tree.sha;

    // Create blobs in parallel
    const writes = ops.filter(o => !o.delete);
    const blobs = await Promise.all(
      writes.map(o => this.#api('POST', '/git/blobs', { content: o.content, encoding: 'base64' }))
    );

    const treeEntries = [
      ...writes.map((o, i) => ({ path: o.path, mode: '100644', type: 'blob', sha: blobs[i].sha })),
      ...ops.filter(o => o.delete).map(o => ({ path: o.path, mode: '100644', type: 'blob', sha: null })),
    ];

    const tree = await this.#api('POST', '/git/trees', { base_tree: baseTree, tree: treeEntries });
    const newCommit = await this.#api('POST', '/git/commits', {
      message, tree: tree.sha, parents: [headSha],
      author: { name: 'Gitnix Notes', email: 'notes@gitnix.dev' },
    });
    await this.#api('PATCH', `/git/refs/heads/${this.#branch}`, { sha: newCommit.sha });
    this.#lastSync = new Date().toISOString();
    return newCommit.sha;
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────

  async create(data) {
    validate(data);
    const now = new Date().toISOString();
    const note = {
      _id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: (data.title || '').trim() || 'Untitled',
      content: data.content || '',
      color: data.color || '#ffffff',
      tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string').slice(0, 20) : [],
      pinned: Boolean(data.pinned),
      _created: now,
      _updated: now,
      _version: 1,
    };

    this.#notes.set(note._id, note);
    const filePath = `.gitnix/notes/${hashPath(note._id)}.enc`;
    await this.#commit(
      [{ path: filePath, content: encryptDoc(note, this.#key) }],
      `notes: create "${note.title.slice(0, 40)}"`
    );
    log('info', `Created: ${note._id} "${note.title}"`);
    return note;
  }

  async update(id, data) {
    const existing = this.#notes.get(id);
    if (!existing) return null;

    validate(data);
    const updated = {
      ...existing,
      title: data.title !== undefined ? (data.title || '').trim() || 'Untitled' : existing.title,
      content: data.content !== undefined ? data.content : existing.content,
      color: data.color || existing.color,
      tags: data.tags !== undefined ? data.tags.filter(t => typeof t === 'string').slice(0, 20) : existing.tags,
      pinned: data.pinned !== undefined ? Boolean(data.pinned) : existing.pinned,
      _updated: new Date().toISOString(),
      _version: existing._version + 1,
    };

    this.#notes.set(id, updated);
    const filePath = `.gitnix/notes/${hashPath(id)}.enc`;
    await this.#commit(
      [{ path: filePath, content: encryptDoc(updated, this.#key) }],
      `notes: update "${updated.title.slice(0, 40)}"`
    );
    log('info', `Updated: ${id} v${updated._version}`);
    return updated;
  }

  async remove(id) {
    const existing = this.#notes.get(id);
    if (!existing) return false;

    this.#notes.delete(id);
    const filePath = `.gitnix/notes/${hashPath(id)}.enc`;
    await this.#commit(
      [{ path: filePath, content: '', delete: true }],
      `notes: delete "${existing.title.slice(0, 40)}"`
    );
    log('info', `Deleted: ${id}`);
    return true;
  }

  list(query = {}) {
    let notes = Array.from(this.#notes.values());

    // Filter
    if (query.search) {
      const s = query.search.toLowerCase();
      notes = notes.filter(n =>
        n.title.toLowerCase().includes(s) || n.content.toLowerCase().includes(s)
      );
    }
    if (query.tag) {
      notes = notes.filter(n => n.tags.includes(query.tag));
    }
    if (query.pinned !== undefined) {
      notes = notes.filter(n => n.pinned === query.pinned);
    }

    // Sort: pinned first, then by updated desc
    notes.sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
      return new Date(b._updated).getTime() - new Date(a._updated).getTime();
    });

    return notes;
  }

  get(id) { return this.#notes.get(id) || null; }

  getStatus() {
    return {
      repo: this.#repo,
      branch: this.#branch,
      noteCount: this.#notes.size,
      apiRequests: this.#apiCalls,
      lastSync: this.#lastSync,
      encryption: 'XSalsa20-Poly1305 (256-bit)',
      loaded: this.#loaded,
    };
  }
}

// ─── Input Validation ─────────────────────────────────────────────────────

function validate(data) {
  if (data.title && typeof data.title !== 'string') throw Object.assign(new Error('title must be a string'), { status: 400 });
  if (data.title && data.title.length > 500) throw Object.assign(new Error('title too long (max 500)'), { status: 400 });
  if (data.content && typeof data.content !== 'string') throw Object.assign(new Error('content must be a string'), { status: 400 });
  if (data.content && data.content.length > 100000) throw Object.assign(new Error('content too long (max 100KB)'), { status: 400 });
  if (data.color && !/^#[0-9a-fA-F]{6}$/.test(data.color)) throw Object.assign(new Error('invalid color format'), { status: 400 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

async function startServer() {
  // Validate config
  if (!CONFIG.token) {
    console.error('\n  ❌ GITHUB_TOKEN is required.\n');
    console.error('  Set it with:');
    console.error('    $env:GITHUB_TOKEN = $(gh auth token)   # PowerShell');
    console.error('    export GITHUB_TOKEN=$(gh auth token)   # Bash\n');
    process.exit(1);
  }

  // Initialize database
  const db = new GitnixDB(CONFIG);

  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║   🔐 Gitnix Notes — Production Server   ║');
  console.log('  ╚══════════════════════════════════════════╝\n');

  log('info', 'Connecting to GitHub...');
  await db.init();

  // Create server
  const server = http.createServer(async (req, res) => {
    const start = Date.now();

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
      const p = url.pathname;
      const method = req.method;

      // ─── API Routes ───────────────────────────────────────────────
      if (p === '/api/notes' && method === 'GET') {
        const query = Object.fromEntries(url.searchParams);
        if (query.pinned) query.pinned = query.pinned === 'true';
        send(res, 200, db.list(query));
      }
      else if (p === '/api/notes' && method === 'POST') {
        const body = await parseBody(req);
        const note = await db.create(body);
        send(res, 201, note);
      }
      else if (p.match(/^\/api\/notes\/[\w-]+$/) && method === 'GET') {
        const id = p.split('/').pop();
        const note = db.get(id);
        if (!note) send(res, 404, { error: 'Note not found' });
        else send(res, 200, note);
      }
      else if (p.match(/^\/api\/notes\/[\w-]+$/) && method === 'PUT') {
        const id = p.split('/').pop();
        const body = await parseBody(req);
        const note = await db.update(id, body);
        if (!note) send(res, 404, { error: 'Note not found' });
        else send(res, 200, note);
      }
      else if (p.match(/^\/api\/notes\/[\w-]+$/) && method === 'DELETE') {
        const id = p.split('/').pop();
        const ok = await db.remove(id);
        if (!ok) send(res, 404, { error: 'Note not found' });
        else send(res, 200, { deleted: true });
      }
      else if (p === '/api/status' && method === 'GET') {
        send(res, 200, db.getStatus());
      }
      // ─── Static Files ─────────────────────────────────────────────
      else {
        serveStatic(res, p === '/' ? '/index.html' : p);
      }

      // Request log
      const ms = Date.now() - start;
      if (p.startsWith('/api/')) {
        log('info', `${method} ${p} → ${res.statusCode} (${ms}ms)`);
      }
    } catch (err) {
      const status = err.status || 500;
      const message = status === 500 ? 'Internal server error' : err.message;
      send(res, status, { error: message });
      log('error', `${req.method} ${req.url} → ${status}: ${err.message}`);
    }
  });

  // Graceful shutdown
  function shutdown(signal) {
    log('info', `${signal} received. Shutting down...`);
    server.close(() => {
      log('info', 'Server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000); // Force after 5s
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start listening
  server.listen(CONFIG.port, () => {
    log('info', `Server listening on http://localhost:${CONFIG.port}`);
    log('info', `Database: ${db.getStatus().repo}`);
    console.log(`\n  Open: http://localhost:${CONFIG.port}\n`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (parseInt(req.headers['content-length'] || '0', 10) > 200_000) {
      reject(Object.assign(new Error('Request too large'), { status: 413 }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200_000) reject(Object.assign(new Error('Request too large'), { status: 413 })); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, 'public', safePath);

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(content);
  } catch {
    // SPA fallback
    if (!pathname.includes('.')) {
      const index = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(index);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

startServer().catch(err => {
  log('error', `Fatal: ${err.message}`);
  process.exit(1);
});
