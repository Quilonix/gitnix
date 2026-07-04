/**
 * ═══════════════════════════════════════════════════════════════
 * Gitnix Events — Performance Benchmark
 * ═══════════════════════════════════════════════════════════════
 *
 * Measures:
 * - API latency (p50, p95, p99, avg, min, max)
 * - Throughput (requests/sec)
 * - Concurrency handling
 * - Encryption overhead
 * - Auth overhead (bcrypt + JWT)
 * - CRUD operations
 * - Registration flow
 */

const BASE = 'http://localhost:3000';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function request(method, path, body = null, token = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);

  const start = performance.now();
  const res = await fetch(`${BASE}${path}`, opts);
  const latency = performance.now() - start;
  const data = await res.json();

  return { status: res.status, data, latency };
}

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  return {
    min: sorted[0].toFixed(2),
    max: sorted[sorted.length - 1].toFixed(2),
    avg: avg.toFixed(2),
    p50: percentile(sorted, 50).toFixed(2),
    p95: percentile(sorted, 95).toFixed(2),
    p99: percentile(sorted, 99).toFixed(2),
    count: latencies.length,
    throughput: (latencies.length / (latencies.reduce((a, b) => a + b, 0) / 1000)).toFixed(1),
  };
}

function printStats(label, s) {
  console.log(`  ${CYAN}${label}${RESET}`);
  console.log(`    avg: ${GREEN}${s.avg}ms${RESET} | p50: ${s.p50}ms | p95: ${YELLOW}${s.p95}ms${RESET} | p99: ${RED}${s.p99}ms${RESET}`);
  console.log(`    min: ${s.min}ms | max: ${s.max}ms | throughput: ${GREEN}${s.throughput} req/s${RESET} (${s.count} requests)`);
}

function section(title) {
  console.log(`\n${CYAN}━━━ ${title} ━━━${RESET}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARKS
// ═══════════════════════════════════════════════════════════════════════════════

async function run() {
  console.log(`\n${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  ${CYAN}GITNIX EVENTS — PERFORMANCE BENCHMARK${RESET}`);
  console.log(`${CYAN}═══════════════════════════════════════════════════════════${RESET}`);

  const results = {};

  // ─── 1. SIGNUP LATENCY (bcrypt heavy) ──────────────────────────────────
  section('1. SIGNUP LATENCY (includes bcrypt hashing)');
  {
    const latencies = [];
    for (let i = 0; i < 10; i++) {
      const r = await request('POST', '/api/auth/signup', {
        name: `Bench User ${i}`,
        email: `bench${i}@test.com`,
        password: 'benchpass123',
      });
      latencies.push(r.latency);
    }
    results.signup = stats(latencies);
    printStats('POST /api/auth/signup', results.signup);
  }

  // ─── 2. LOGIN LATENCY (bcrypt verify) ─────────────────────────────────
  section('2. LOGIN LATENCY (bcrypt compare)');
  {
    const latencies = [];
    for (let i = 0; i < 20; i++) {
      const r = await request('POST', '/api/auth/login', {
        email: 'bench0@test.com',
        password: 'benchpass123',
      });
      latencies.push(r.latency);
    }
    results.login = stats(latencies);
    printStats('POST /api/auth/login', results.login);
  }

  // Get admin token
  const adminRes = await request('POST', '/api/auth/login', {
    email: 'admin@example.com',
    password: 'admin123',
  });
  const adminToken = adminRes.data.token;

  // Get user token
  const userRes = await request('POST', '/api/auth/login', {
    email: 'bench0@test.com',
    password: 'benchpass123',
  });
  const userToken = userRes.data.token;

  // ─── 3. EVENT CREATION (admin, encrypted write) ───────────────────────
  section('3. EVENT CREATION (encrypted write)');
  {
    const latencies = [];
    const eventIds = [];
    for (let i = 0; i < 50; i++) {
      const r = await request('POST', '/api/admin/events', {
        title: `Benchmark Event ${i}`,
        date: '2026-12-01T10:00',
        location: `Venue ${i}`,
        capacity: 100,
        description: `Performance test event number ${i} with some description text.`,
      }, adminToken);
      latencies.push(r.latency);
      if (r.data.event) eventIds.push(r.data.event._id);
    }
    results.createEvent = stats(latencies);
    printStats('POST /api/admin/events (50 events)', results.createEvent);

    // Store for later tests
    globalThis._eventIds = eventIds;
  }

  // ─── 4. EVENT LISTING (encrypted read, all) ───────────────────────────
  section('4. EVENT LISTING (decrypt all events)');
  {
    const latencies = [];
    for (let i = 0; i < 50; i++) {
      const r = await request('GET', '/api/events');
      latencies.push(r.latency);
    }
    results.listEvents = stats(latencies);
    printStats('GET /api/events (50 calls, ~50 events)', results.listEvents);
  }

  // ─── 5. SINGLE EVENT READ ─────────────────────────────────────────────
  section('5. SINGLE EVENT READ');
  {
    const latencies = [];
    for (let i = 0; i < 50; i++) {
      const id = globalThis._eventIds[i % globalThis._eventIds.length];
      const r = await request('GET', `/api/events/${id}`);
      latencies.push(r.latency);
    }
    results.getEvent = stats(latencies);
    printStats('GET /api/events/:id (50 calls)', results.getEvent);
  }

  // ─── 6. EVENT REGISTRATION ────────────────────────────────────────────
  section('6. EVENT REGISTRATION (write + capacity check)');
  {
    const latencies = [];
    for (let i = 0; i < 30; i++) {
      // Use different users for different events
      const userIdx = i % 10;
      const loginR = await request('POST', '/api/auth/login', {
        email: `bench${userIdx}@test.com`,
        password: 'benchpass123',
      });
      const tok = loginR.data.token;
      const eventId = globalThis._eventIds[i % globalThis._eventIds.length];

      const r = await request('POST', `/api/events/${eventId}/register`, null, tok);
      latencies.push(r.latency);
    }
    results.register = stats(latencies);
    printStats('POST /api/events/:id/register (30 registrations)', results.register);
  }

  // ─── 7. MY REGISTRATIONS (filtered read) ──────────────────────────────
  section('7. MY REGISTRATIONS (filtered encrypted read)');
  {
    const latencies = [];
    for (let i = 0; i < 30; i++) {
      const r = await request('GET', '/api/my/registrations', null, userToken);
      latencies.push(r.latency);
    }
    results.myRegistrations = stats(latencies);
    printStats('GET /api/my/registrations (30 calls)', results.myRegistrations);
  }

  // ─── 8. ADMIN STATS ───────────────────────────────────────────────────
  section('8. ADMIN STATS (aggregate counts)');
  {
    const latencies = [];
    for (let i = 0; i < 30; i++) {
      const r = await request('GET', '/api/admin/stats', null, adminToken);
      latencies.push(r.latency);
    }
    results.adminStats = stats(latencies);
    printStats('GET /api/admin/stats (30 calls)', results.adminStats);
  }

  // ─── 9. CONCURRENT REQUESTS ───────────────────────────────────────────
  section('9. CONCURRENT REQUESTS (10 parallel reads)');
  {
    const latencies = [];
    for (let batch = 0; batch < 5; batch++) {
      const promises = Array.from({ length: 10 }, () =>
        request('GET', '/api/events')
      );
      const start = performance.now();
      const results = await Promise.all(promises);
      const batchTime = performance.now() - start;
      latencies.push(batchTime);
    }
    results.concurrent = stats(latencies);
    printStats('10 parallel GET /api/events × 5 batches', results.concurrent);
  }

  // ─── 10. JWT VERIFICATION OVERHEAD ─────────────────────────────────────
  section('10. JWT VERIFICATION OVERHEAD');
  {
    // Authed vs unauthed read
    const authedLatencies = [];
    const publicLatencies = [];
    for (let i = 0; i < 30; i++) {
      const r1 = await request('GET', '/api/auth/me', null, userToken);
      authedLatencies.push(r1.latency);
      const r2 = await request('GET', '/api/events');
      publicLatencies.push(r2.latency);
    }
    results.jwtVerify = stats(authedLatencies);
    results.publicRead = stats(publicLatencies);
    printStats('GET /api/auth/me (JWT verify, 30 calls)', results.jwtVerify);
    printStats('GET /api/events (no auth, 30 calls)', results.publicRead);
    const overhead = (parseFloat(results.jwtVerify.avg) - parseFloat(results.publicRead.avg)).toFixed(2);
    console.log(`    ${DIM}JWT overhead: ~${overhead}ms per request${RESET}`);
  }

  // ─── 11. EVENT UPDATE LATENCY ──────────────────────────────────────────
  section('11. EVENT UPDATE (encrypted read + write)');
  {
    const latencies = [];
    for (let i = 0; i < 20; i++) {
      const id = globalThis._eventIds[i % globalThis._eventIds.length];
      const r = await request('PUT', `/api/admin/events/${id}`, {
        title: `Updated Event ${i}`,
        capacity: 200,
      }, adminToken);
      latencies.push(r.latency);
    }
    results.updateEvent = stats(latencies);
    printStats('PUT /api/admin/events/:id (20 updates)', results.updateEvent);
  }

  // ─── 12. EVENT DELETE ──────────────────────────────────────────────────
  section('12. EVENT DELETE (encrypted write + cascade)');
  {
    const latencies = [];
    for (let i = 0; i < 10; i++) {
      const id = globalThis._eventIds[globalThis._eventIds.length - 1 - i];
      const r = await request('DELETE', `/api/admin/events/${id}`, null, adminToken);
      latencies.push(r.latency);
    }
    results.deleteEvent = stats(latencies);
    printStats('DELETE /api/admin/events/:id (10 deletes)', results.deleteEvent);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  ${CYAN}SUMMARY${RESET}`);
  console.log(`${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`\n  ${'Endpoint'.padEnd(40)} ${'Avg'.padStart(8)} ${'P95'.padStart(8)} ${'P99'.padStart(8)} ${'Req/s'.padStart(8)}`);
  console.log(`  ${'─'.repeat(40)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);

  const summary = [
    ['POST /auth/signup (bcrypt)', results.signup],
    ['POST /auth/login (bcrypt)', results.login],
    ['POST /admin/events (create)', results.createEvent],
    ['GET /events (list all)', results.listEvents],
    ['GET /events/:id (single)', results.getEvent],
    ['POST /events/:id/register', results.register],
    ['GET /my/registrations', results.myRegistrations],
    ['GET /admin/stats', results.adminStats],
    ['10× concurrent reads (batch)', results.concurrent],
    ['GET /auth/me (JWT verify)', results.jwtVerify],
    ['PUT /admin/events/:id (update)', results.updateEvent],
    ['DELETE /admin/events/:id', results.deleteEvent],
  ];

  for (const [label, s] of summary) {
    console.log(`  ${label.padEnd(40)} ${(s.avg + 'ms').padStart(8)} ${(s.p95 + 'ms').padStart(8)} ${(s.p99 + 'ms').padStart(8)} ${(s.throughput).padStart(8)}`);
  }

  console.log(`\n${CYAN}═══════════════════════════════════════════════════════════${RESET}\n`);
}

run().catch(err => {
  console.error(`${RED}Benchmark error:${RESET}`, err.message);
  process.exit(1);
});
