/**
 * ═══════════════════════════════════════════════════════════════
 * Gitnix Events — Security Audit
 * ═══════════════════════════════════════════════════════════════
 *
 * Tests:
 * 1. Authentication bypass attempts
 * 2. Authorization / privilege escalation
 * 3. Input injection (XSS, NoSQL, path traversal)
 * 4. Rate limiting verification
 * 5. Security headers (OWASP)
 * 6. JWT security (algo confusion, expired tokens, tampered)
 * 7. Session management
 * 8. Encryption verification (data at rest)
 * 9. Information disclosure
 * 10. CORS policy
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ${GREEN}✓ PASS${RESET} ${msg}`); passed++; }
function fail(msg) { console.log(`  ${RED}✗ FAIL${RESET} ${msg}`); failed++; }
function warn(msg) { console.log(`  ${YELLOW}⚠ WARN${RESET} ${msg}`); warnings++; }

function section(title) {
  console.log(`\n${CYAN}━━━ ${title} ━━━${RESET}`);
}

async function req(method, path, body = null, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
}

async function run() {
  console.log(`\n${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  ${CYAN}GITNIX EVENTS — SECURITY AUDIT${RESET}`);
  console.log(`${CYAN}═══════════════════════════════════════════════════════════${RESET}`);

  // Setup: get tokens
  const adminLogin = await req('POST', '/api/auth/login', {
    email: 'admin@example.com', password: 'admin123'
  });
  const adminToken = adminLogin.data.token;

  await req('POST', '/api/auth/signup', {
    name: 'Security Tester', email: 'sec@test.com', password: 'securepass'
  });
  const userLogin = await req('POST', '/api/auth/login', {
    email: 'sec@test.com', password: 'securepass'
  });
  const userToken = userLogin.data.token;

  // Create a test event
  const eventRes = await req('POST', '/api/admin/events', {
    title: 'Security Test Event', date: '2026-12-01T10:00',
    location: 'Test', capacity: 10
  }, { Authorization: `Bearer ${adminToken}` });
  const eventId = eventRes.data.event._id;

  // ═══════════════════════════════════════════════════════════════════════
  section('1. AUTHENTICATION BYPASS');
  // ═══════════════════════════════════════════════════════════════════════

  // No token
  const r1 = await req('GET', '/api/auth/me');
  r1.status === 401 ? pass('No token → 401') : fail(`No token → ${r1.status}`);

  // Empty bearer
  const r2 = await req('GET', '/api/auth/me', null, { Authorization: 'Bearer ' });
  r2.status === 401 ? pass('Empty bearer → 401') : fail(`Empty bearer → ${r2.status}`);

  // Random string as token
  const r3 = await req('GET', '/api/auth/me', null, { Authorization: 'Bearer totally.not.a.token' });
  r3.status === 401 ? pass('Random string token → 401') : fail(`Random string → ${r3.status}`);

  // Null byte in token
  try {
    const r4 = await req('GET', '/api/auth/me', null, { Authorization: 'Bearer \x00\x00\x00' });
    r4.status === 401 ? pass('Null bytes in token → 401') : fail(`Null bytes → ${r4.status}`);
  } catch {
    pass('Null bytes in token → rejected by HTTP layer');
  }

  // SQL injection in auth header
  const r5 = await req('GET', '/api/auth/me', null, { Authorization: "Bearer ' OR '1'='1" });
  r5.status === 401 ? pass('SQLi in token → 401') : fail(`SQLi in token → ${r5.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  section('2. AUTHORIZATION / PRIVILEGE ESCALATION');
  // ═══════════════════════════════════════════════════════════════════════

  // User tries admin endpoints
  const adminEndpoints = [
    ['POST', '/api/admin/events', { title: 'x', date: '2026-01-01', location: 'x', capacity: 1 }],
    ['PUT', `/api/admin/events/${eventId}`, { title: 'hacked' }],
    ['DELETE', `/api/admin/events/${eventId}`, null],
    ['GET', '/api/admin/users', null],
    ['DELETE', '/api/admin/users/someid', null],
    ['PUT', '/api/admin/users/someid/role', { role: 'admin' }],
    ['GET', '/api/admin/stats', null],
  ];

  for (const [method, endpoint, body] of adminEndpoints) {
    const r = await req(method, endpoint, body, { Authorization: `Bearer ${userToken}` });
    r.status === 403 ? pass(`User → ${method} ${endpoint.split('/').slice(0, 4).join('/')}... → 403`)
                     : fail(`User → ${method} ${endpoint} → ${r.status}`);
  }

  // User tries to elevate own role
  const userId = userLogin.data.user.id;
  const elevate = await req('PUT', `/api/admin/users/${userId}/role`, { role: 'admin' },
    { Authorization: `Bearer ${userToken}` });
  elevate.status === 403 ? pass('Self-elevation blocked → 403') : fail(`Self-elevation → ${elevate.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  section('3. INPUT INJECTION');
  // ═══════════════════════════════════════════════════════════════════════

  // XSS in user name
  const xssPayloads = [
    '<script>alert("xss")</script>',
    '"><img src=x onerror=alert(1)>',
    "'; DROP TABLE users; --",
    '{{7*7}}',
    '${7*7}',
    '../../../etc/passwd',
    '%00%0a%0dSet-Cookie: hacked=1',
  ];

  for (const payload of xssPayloads) {
    const r = await req('POST', '/api/admin/events', {
      title: payload, date: '2026-01-01', location: payload, capacity: 10
    }, { Authorization: `Bearer ${adminToken}` });

    if (r.status === 201) {
      // Check if the payload was sanitized (< > stripped)
      const title = r.data.event.title;
      if (title.includes('<') || title.includes('>')) {
        fail(`XSS stored unsanitized: "${title.substring(0, 40)}"`);
      } else {
        pass(`Injection sanitized: "${payload.substring(0, 30)}..." → "${title.substring(0, 30)}"`);
      }
    } else {
      pass(`Injection rejected: "${payload.substring(0, 30)}..." → ${r.status}`);
    }
  }

  // NoSQL-style operator injection in login
  const nosql = await req('POST', '/api/auth/login', {
    email: { $gt: '' }, password: { $gt: '' }
  });
  nosql.status === 401 || nosql.status === 400
    ? pass(`NoSQL operator injection blocked → ${nosql.status}`)
    : fail(`NoSQL injection → ${nosql.status}`);

  // Path traversal in event ID (URL-encoded)
  const traversal = await req('GET', '/api/events/..%2F..%2Fetc%2Fpasswd');
  traversal.status === 400 || traversal.status === 404
    ? pass(`Path traversal (encoded) blocked → ${traversal.status}`)
    : fail(`Path traversal (encoded) → ${traversal.status}`);

  // Direct path with dots
  const dotPath = await req('GET', '/api/events/....passwd');
  dotPath.status === 404 || dotPath.status === 400
    ? pass(`Dot-path ID returns not found → ${dotPath.status}`)
    : fail(`Dot-path ID → ${dotPath.status}`);

  // Oversized payload
  const bigPayload = 'A'.repeat(2 * 1024 * 1024); // 2MB
  try {
    const big = await req('POST', '/api/admin/events', {
      title: bigPayload, date: '2026-01-01', location: 'x', capacity: 1
    }, { Authorization: `Bearer ${adminToken}` });
    big.status === 413 || big.status === 400
      ? pass(`Oversized payload rejected → ${big.status}`)
      : warn(`Oversized payload accepted → ${big.status} (should limit body size)`);
  } catch {
    pass('Oversized payload rejected (connection error)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('4. RATE LIMITING');
  // ═══════════════════════════════════════════════════════════════════════

  // Brute force login attempts
  let rateLimited = false;
  const bruteForceCount = 25;
  for (let i = 0; i < bruteForceCount; i++) {
    const r = await req('POST', '/api/auth/login', {
      email: 'nonexistent@evil.com', password: `attempt${i}`
    });
    if (r.status === 429) {
      rateLimited = true;
      pass(`Rate limit triggered after ${i + 1} login attempts`);
      break;
    }
  }
  if (!rateLimited) {
    warn(`No rate limit after ${bruteForceCount} rapid login attempts (may need lower threshold)`);
  }

  // Check rate limit headers
  const rateLimitRes = await req('GET', '/api/events');
  if (rateLimitRes.headers['ratelimit-limit']) {
    pass(`Rate limit headers present: limit=${rateLimitRes.headers['ratelimit-limit']}`);
  } else if (rateLimitRes.headers['x-ratelimit-limit']) {
    pass(`Rate limit headers present (x-ratelimit): ${rateLimitRes.headers['x-ratelimit-limit']}`);
  } else {
    warn('No rate limit headers in response');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('5. SECURITY HEADERS (OWASP)');
  // ═══════════════════════════════════════════════════════════════════════

  const headersRes = await req('GET', '/api/events');
  const h = headersRes.headers;

  // Required headers
  const requiredHeaders = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': null, // any value
    'content-security-policy': null,
    'strict-transport-security': null,
    'x-xss-protection': null,
  };

  for (const [header, expectedValue] of Object.entries(requiredHeaders)) {
    if (h[header]) {
      if (expectedValue && !h[header].includes(expectedValue)) {
        warn(`${header}: ${h[header]} (expected: ${expectedValue})`);
      } else {
        pass(`${header}: ${h[header].substring(0, 60)}${h[header].length > 60 ? '...' : ''}`);
      }
    } else {
      fail(`Missing header: ${header}`);
    }
  }

  // Should NOT have these
  if (!h['x-powered-by']) {
    pass('x-powered-by hidden (server fingerprint removed)');
  } else {
    fail(`x-powered-by exposed: ${h['x-powered-by']}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('6. JWT SECURITY');
  // ═══════════════════════════════════════════════════════════════════════

  // Decode JWT and check claims
  const parts = adminToken.split('.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

  // Algorithm
  header.alg === 'HS256'
    ? pass(`JWT algorithm: ${header.alg} (safe)`)
    : header.alg === 'none'
      ? fail(`JWT algorithm: none (CRITICAL — no signature!)`)
      : warn(`JWT algorithm: ${header.alg}`);

  // Claims
  payload.exp ? pass(`JWT has expiry: ${new Date(payload.exp * 1000).toISOString()}`)
              : fail('JWT has no expiry claim');

  // None algorithm attack
  const fakeHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const fakePayload = Buffer.from(JSON.stringify({ id: 'admin', role: 'admin', email: 'admin@example.com' })).toString('base64url');
  const noneToken = `${fakeHeader}.${fakePayload}.`;
  const noneRes = await req('GET', '/api/auth/me', null, { Authorization: `Bearer ${noneToken}` });
  noneRes.status === 401
    ? pass('Algorithm "none" attack blocked')
    : fail(`Algorithm "none" attack succeeded! Status: ${noneRes.status}`);

  // Tampered payload (user token with role changed to admin)
  const userParts = userToken.split('.');
  const userPayload = JSON.parse(Buffer.from(userParts[1], 'base64url').toString());
  const tamperedPayload = Buffer.from(JSON.stringify({ ...userPayload, role: 'admin' })).toString('base64url');
  const tamperedToken = `${userParts[0]}.${tamperedPayload}.${userParts[2]}`;
  const tamperedRes = await req('GET', '/api/admin/stats', null, { Authorization: `Bearer ${tamperedToken}` });
  tamperedRes.status === 401 || tamperedRes.status === 403
    ? pass('Tampered JWT payload rejected')
    : fail(`Tampered JWT accepted! Status: ${tamperedRes.status}`);

  // Expired token (manually create one with past exp)
  const expiredPayload = Buffer.from(JSON.stringify({ ...payload, exp: 1000000 })).toString('base64url');
  const expiredToken = `${parts[0]}.${expiredPayload}.${parts[2]}`;
  const expiredRes = await req('GET', '/api/auth/me', null, { Authorization: `Bearer ${expiredToken}` });
  expiredRes.status === 401
    ? pass('Expired token rejected')
    : fail(`Expired token accepted! Status: ${expiredRes.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  section('7. SESSION MANAGEMENT');
  // ═══════════════════════════════════════════════════════════════════════

  // Duplicate signup prevention (must test before brute force triggers rate limit)
  const dupSignup1 = await req('POST', '/api/auth/signup', {
    name: 'Dup Test', email: 'dupcheck@unique.com', password: 'duppass123'
  });
  const dupSignup2 = await req('POST', '/api/auth/signup', {
    name: 'Dup Test 2', email: 'dupcheck@unique.com', password: 'anotherpass'
  });
  dupSignup2.status === 409 ? pass('Duplicate email signup blocked → 409') : fail(`Duplicate signup → ${dupSignup2.status} (expected 409)`);

  // Logout should not invalidate existing token (stateless JWT)
  const preLogoutRes = await req('GET', '/api/auth/me', null, { Authorization: `Bearer ${userToken}` });
  preLogoutRes.status === 200 ? pass('Token valid before logout') : fail('Token invalid before logout');

  await req('POST', '/api/auth/logout');

  // In stateless JWT, token still works after "logout" (known limitation)
  const postLogoutRes = await req('GET', '/api/auth/me', null, { Authorization: `Bearer ${userToken}` });
  if (postLogoutRes.status === 200) {
    warn('Token still valid after logout (stateless JWT — expected but noted)');
  } else {
    pass('Token invalidated after logout (server-side session store)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('8. ENCRYPTION VERIFICATION (data at rest)');
  // ═══════════════════════════════════════════════════════════════════════

  const dataDir = path.join(__dirname, '.data');
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.enc'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');

      // Should be base64 (encrypted), not JSON
      const isBase64 = /^[A-Za-z0-9+/=\n]+$/.test(content.trim());
      const containsPlaintext = content.includes('"email"') || content.includes('"password"') ||
                                content.includes('admin@') || content.includes('sec@test');

      if (containsPlaintext) {
        fail(`${file} contains PLAINTEXT data!`);
      } else if (isBase64) {
        pass(`${file} is encrypted (base64, ${content.length} chars)`);
      } else {
        warn(`${file} format unclear (${content.length} chars)`);
      }
    }

    // Verify password hashes aren't stored in plaintext
    const usersFile = files.find(f => f.includes('users'));
    if (usersFile) {
      const content = fs.readFileSync(path.join(dataDir, usersFile), 'utf-8');
      const hasPlainPass = content.includes('securepass') || content.includes('admin123') || content.includes('benchpass');
      hasPlainPass ? fail('Plaintext passwords found in encrypted store!') : pass('No plaintext passwords in data files');
    }
  } else {
    warn('No .data directory found — cannot verify encryption at rest');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('9. INFORMATION DISCLOSURE');
  // ═══════════════════════════════════════════════════════════════════════

  // Error messages should not leak internal info
  const err404 = await req('GET', '/api/nonexistent');
  const errBody = JSON.stringify(err404.data || '');
  const leaksStack = errBody.includes('stack') || errBody.includes('node_modules') || errBody.includes('at ');
  leaksStack ? fail('Error response leaks stack trace') : pass('Error responses don\'t leak internals');

  // Login errors should be generic (not reveal if email exists)
  const wrongEmail = await req('POST', '/api/auth/login', { email: 'no@exist.com', password: 'x' });
  const wrongPass = await req('POST', '/api/auth/login', { email: 'sec@test.com', password: 'wrong' });
  wrongEmail.data.error === wrongPass.data.error
    ? pass(`Login errors are generic: "${wrongEmail.data.error}"`)
    : warn(`Different errors for wrong email vs wrong password (timing oracle)`);

  // Password not returned in user data
  const meRes = await req('GET', '/api/auth/me', null, { Authorization: `Bearer ${userToken}` });
  const meData = JSON.stringify(meRes.data);
  meData.includes('$2') || meData.includes('password')
    ? fail('Password hash leaked in /me response')
    : pass('Password hash not in /me response');

  // Admin user list shouldn't expose password hashes
  const usersRes = await req('GET', '/api/admin/users', null, { Authorization: `Bearer ${adminToken}` });
  const usersData = JSON.stringify(usersRes.data);
  usersData.includes('$2') || usersData.includes('"password"')
    ? fail('Password hashes leaked in admin user list')
    : pass('No password hashes in admin user list');

  // ═══════════════════════════════════════════════════════════════════════
  section('10. CORS POLICY');
  // ═══════════════════════════════════════════════════════════════════════

  // Preflight from evil origin
  const corsRes = await fetch(`${BASE}/api/events`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'POST' },
  });
  const allowOrigin = corsRes.headers.get('access-control-allow-origin');

  if (allowOrigin === '*') {
    warn('CORS allows all origins (fine for dev, tighten for production)');
  } else if (allowOrigin === 'https://evil.com') {
    fail('CORS reflects arbitrary origin!');
  } else {
    pass(`CORS restricted: ${allowOrigin || 'no origin header returned'}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('11. BUSINESS LOGIC');
  // ═══════════════════════════════════════════════════════════════════════

  // Register for same event twice
  const regRes = await req('POST', `/api/events/${eventId}/register`, null, { Authorization: `Bearer ${userToken}` });
  const dupReg = await req('POST', `/api/events/${eventId}/register`, null, { Authorization: `Bearer ${userToken}` });
  dupReg.status === 409 ? pass('Double registration prevented → 409') : fail(`Double registration → ${dupReg.status}`);

  // Admin can't delete themselves
  const adminMe = await req('GET', '/api/auth/me', null, { Authorization: `Bearer ${adminToken}` });
  const adminId = adminMe.data.user.id;
  const selfDelete = await req('DELETE', `/api/admin/users/${adminId}`, null, { Authorization: `Bearer ${adminToken}` });
  selfDelete.status === 400 ? pass('Admin cannot self-delete → 400') : fail(`Admin self-delete → ${selfDelete.status}`);

  // Invalid role assignment
  const badRole = await req('PUT', `/api/admin/users/${userId}/role`, { role: 'superadmin' },
    { Authorization: `Bearer ${adminToken}` });
  badRole.status === 400 ? pass('Invalid role rejected → 400') : fail(`Invalid role → ${badRole.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  ${CYAN}SECURITY AUDIT RESULTS${RESET}`);
  console.log(`${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  ${GREEN}Passed:   ${passed}${RESET}`);
  console.log(`  ${RED}Failed:   ${failed}${RESET}`);
  console.log(`  ${YELLOW}Warnings: ${warnings}${RESET}`);
  console.log(`  Total:    ${passed + failed + warnings}`);
  console.log(`\n  Security Score: ${failed === 0 ? GREEN + 'A+' : failed <= 2 ? YELLOW + 'B' : RED + 'C'}${RESET} ${failed === 0 ? '(no critical issues)' : `(${failed} issue${failed > 1 ? 's' : ''} to fix)`}`);
  console.log(`${CYAN}═══════════════════════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`${RED}Audit error:${RESET}`, err.message);
  process.exit(1);
});
