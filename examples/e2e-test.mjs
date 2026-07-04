/**
 * ═══════════════════════════════════════════════════════════════
 * Gitnix Events — Playwright E2E Security & Functionality Test
 * ═══════════════════════════════════════════════════════════════
 */

import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ${GREEN}✓${RESET} ${message}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${message}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${CYAN}━━━ ${title} ━━━${RESET}`);
}

// Helper: login on a fresh page
async function login(browser, email, password) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');

  // Navigate to login page
  await page.evaluate(() => navigate('login'));
  await page.waitForTimeout(300);

  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type="submit"]');

  // Wait for token to appear (bcrypt can be slow)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    if (token) break;
  }

  return { context, page };
}

async function run() {
  const browser = await chromium.launch({ headless: true });

  try {
    // ═══════════════════════════════════════════════════════════════════════
    section('1. GUEST ACCESS CONTROL (UI)');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(BASE);
      await page.waitForLoadState('networkidle');

      const eventsVisible = await page.isVisible('#page-home');
      assert(eventsVisible, 'Guest can see events listing');

      const adminVisible = await page.locator('.admin-only').first().isVisible();
      assert(!adminVisible, 'Admin link is hidden for guest');

      const authVisible = await page.locator('.auth-only').first().isVisible();
      assert(!authVisible, 'My Registrations hidden for guest');

      const guestVisible = await page.locator('.guest-only').first().isVisible();
      assert(guestVisible, 'Login/Signup links visible for guest');

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('2. API SECURITY (no auth)');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const context = await browser.newContext();
      const page = await context.newPage();

      const r1 = await page.request.post(`${BASE}/api/events/fake/register`);
      assert(r1.status() === 401, `POST /register → 401 (got ${r1.status()})`);

      const r2 = await page.request.get(`${BASE}/api/admin/stats`);
      assert(r2.status() === 401, `GET /admin/stats → 401 (got ${r2.status()})`);

      const r3 = await page.request.post(`${BASE}/api/admin/events`, {
        data: { title: 'x', date: '2026-01-01', location: 'x', capacity: 1 }
      });
      assert(r3.status() === 401, `POST /admin/events → 401 (got ${r3.status()})`);

      const r4 = await page.request.get(`${BASE}/api/my/registrations`);
      assert(r4.status() === 401, `GET /my/registrations → 401 (got ${r4.status()})`);

      const r5 = await page.request.delete(`${BASE}/api/admin/users/fake`);
      assert(r5.status() === 401, `DELETE /admin/users → 401 (got ${r5.status()})`);

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('3. SIGNUP FLOW');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(BASE);
      await page.waitForLoadState('networkidle');

      await page.evaluate(() => navigate('signup'));
      await page.waitForTimeout(300);

      const signupVisible = await page.isVisible('#page-signup');
      assert(signupVisible, 'Signup page visible');

      await page.fill('#signup-name', 'E2E Tester');
      await page.fill('#signup-email', 'e2e@test.com');
      await page.fill('#signup-password', 'testpass123');
      await page.click('#signup-form button[type="submit"]');

      // Wait for token to appear (bcrypt is slow)
      let token = null;
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(500);
        token = await page.evaluate(() => localStorage.getItem('token'));
        if (token) break;
      }

      const homeVisible = await page.isVisible('#page-home');
      assert(homeVisible, 'Redirected to home after signup');
      assert(!!token, 'JWT token stored in localStorage');

      // Verify with API
      const meRes = await page.request.get(`${BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const me = await meRes.json();
      assert(me.user.name === 'E2E Tester', `Server confirms user: ${me.user.name}`);
      assert(me.user.role === 'attendee', `Role is attendee: ${me.user.role}`);

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('4. LOGIN FLOW');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { context, page } = await login(browser, 'e2e@test.com', 'testpass123');

      const homeVisible = await page.isVisible('#page-home');
      assert(homeVisible, 'After login, on home page');

      const token = await page.evaluate(() => localStorage.getItem('token'));
      assert(!!token, 'Token stored after login');

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('5. REGULAR USER BLOCKED FROM ADMIN');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { context, page } = await login(browser, 'e2e@test.com', 'testpass123');

      // UI: admin link hidden
      const adminVisible = await page.locator('.admin-only').first().isVisible();
      assert(!adminVisible, 'Admin link hidden for attendee');

      // API: 403 on admin endpoints
      const token = await page.evaluate(() => localStorage.getItem('token'));
      const r = await page.request.get(`${BASE}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert(r.status() === 403, `Attendee gets 403 on admin stats (got ${r.status()})`);

      const r2 = await page.request.post(`${BASE}/api/admin/events`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { title: 'hack', date: '2026-01-01', location: 'x', capacity: 1 }
      });
      assert(r2.status() === 403, `Attendee gets 403 on create event (got ${r2.status()})`);

      const r3 = await page.request.delete(`${BASE}/api/admin/users/someid`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert(r3.status() === 403, `Attendee gets 403 on delete user (got ${r3.status()})`);

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('6. ADMIN LOGIN & DASHBOARD');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { context, page } = await login(browser, 'admin@example.com', 'admin123');

      // Admin link should be visible
      const adminVisible = await page.locator('.admin-only').first().isVisible();
      assert(adminVisible, 'Admin link visible for admin');

      // Navigate to admin panel
      await page.evaluate(() => navigate('admin'));
      await page.waitForTimeout(2000);

      const adminPage = await page.isVisible('#page-admin');
      assert(adminPage, 'Admin page renders');

      const stats = await page.textContent('#admin-stats');
      assert(stats.includes('Users'), 'Stats show Users');
      assert(stats.includes('Events'), 'Stats show Events');

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('7. ADMIN CREATES EVENT');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { context, page } = await login(browser, 'admin@example.com', 'admin123');

      // Create event via API (more reliable than UI clicking)
      const token = await page.evaluate(() => localStorage.getItem('token'));
      const createRes = await page.request.post(`${BASE}/api/admin/events`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          title: 'Playwright Conference',
          date: '2026-10-20T10:00',
          location: 'Bangalore Convention Center',
          capacity: 30,
          description: 'Testing event creation via Playwright'
        }
      });
      assert(createRes.status() === 201, `Event created (${createRes.status()})`);

      const created = await createRes.json();
      assert(created.event.title === 'Playwright Conference', `Title: ${created.event.title}`);
      assert(created.event.capacity === 30, `Capacity: ${created.event.capacity}`);

      // Verify it shows in public listing
      const listRes = await page.request.get(`${BASE}/api/events`);
      const list = await listRes.json();
      const found = list.events.find(e => e.title === 'Playwright Conference');
      assert(!!found, 'Event visible in public listing');

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('8. USER REGISTERS FOR EVENT');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { context, page } = await login(browser, 'e2e@test.com', 'testpass123');
      const token = await page.evaluate(() => localStorage.getItem('token'));

      // Get event ID
      const listRes = await page.request.get(`${BASE}/api/events`);
      const list = await listRes.json();
      const event = list.events.find(e => e.title === 'Playwright Conference');
      assert(!!event, 'Found event to register for');

      // Register
      const regRes = await page.request.post(`${BASE}/api/events/${event._id}/register`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert(regRes.status() === 201, `Registration successful (${regRes.status()})`);

      const reg = await regRes.json();
      assert(reg.registration.status === 'confirmed', `Status: ${reg.registration.status}`);

      // Verify double registration blocked
      const dupRes = await page.request.post(`${BASE}/api/events/${event._id}/register`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert(dupRes.status() === 409, `Duplicate registration blocked (${dupRes.status()})`);

      // Verify spots updated
      const detailRes = await page.request.get(`${BASE}/api/events/${event._id}`);
      const detail = await detailRes.json();
      assert(detail.event.registeredCount === 1, `Registered count: ${detail.event.registeredCount}`);
      assert(detail.event.spotsLeft === 29, `Spots left: ${detail.event.spotsLeft}`);

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('9. USER CANCELS REGISTRATION');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { context, page } = await login(browser, 'e2e@test.com', 'testpass123');
      const token = await page.evaluate(() => localStorage.getItem('token'));

      // Get registrations
      const myRegsRes = await page.request.get(`${BASE}/api/my/registrations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const myRegs = await myRegsRes.json();
      assert(myRegs.registrations.length > 0, `Has registrations: ${myRegs.registrations.length}`);

      const eventId = myRegs.registrations[0].eventId;

      // Cancel
      const cancelRes = await page.request.delete(`${BASE}/api/events/${eventId}/register`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert(cancelRes.status() === 200, `Cancel successful (${cancelRes.status()})`);

      // Verify gone
      const afterRes = await page.request.get(`${BASE}/api/my/registrations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const after = await afterRes.json();
      assert(after.registrations.length === 0, 'Registration removed');

      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('10. LOGOUT & INVALID LOGIN');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { context, page } = await login(browser, 'admin@example.com', 'admin123');

      // Logout
      await page.click('text=Logout');
      await page.waitForTimeout(1000);

      const tokenGone = await page.evaluate(() => !localStorage.getItem('token'));
      assert(tokenGone, 'Token cleared after logout');

      const guestVisible = await page.locator('.guest-only').first().isVisible();
      assert(guestVisible, 'Guest links visible after logout');

      await context.close();

      // Invalid login
      const ctx2 = await browser.newContext();
      const page2 = await ctx2.newPage();
      await page2.goto(BASE);
      await page2.waitForLoadState('networkidle');
      await page2.evaluate(() => navigate('login'));
      await page2.waitForTimeout(300);
      await page2.fill('#login-email', 'hacker@evil.com');
      await page2.fill('#login-password', 'wrongpass');
      await page2.click('#login-form button[type="submit"]');
      await page2.waitForTimeout(1500);

      const errorMsg = await page2.textContent('#login-error');
      assert(errorMsg.length > 0, `Invalid login error: "${errorMsg}"`);

      const stillLogin = await page2.isVisible('#page-login');
      assert(stillLogin, 'Stays on login page after failure');

      const noToken = await page2.evaluate(() => !localStorage.getItem('token'));
      assert(noToken, 'No token stored for failed login');

      await ctx2.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('11. ADMIN DELETES EVENT & USER');
    // ═══════════════════════════════════════════════════════════════════════
    {
      const { context, page } = await login(browser, 'admin@example.com', 'admin123');
      const token = await page.evaluate(() => localStorage.getItem('token'));

      // Get events
      const eventsRes = await page.request.get(`${BASE}/api/events`);
      const events = await eventsRes.json();
      const eventToDelete = events.events[0];

      // Delete event
      const delRes = await page.request.delete(`${BASE}/api/admin/events/${eventToDelete._id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert(delRes.status() === 200, `Event deleted (${delRes.status()})`);

      // Verify gone
      const afterRes = await page.request.get(`${BASE}/api/events`);
      const after = await afterRes.json();
      const stillExists = after.events.find(e => e._id === eventToDelete._id);
      assert(!stillExists, 'Deleted event no longer in listing');

      // Get users, delete non-admin
      const usersRes = await page.request.get(`${BASE}/api/admin/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const users = await usersRes.json();
      const nonAdmin = users.users.find(u => u.role === 'attendee');

      if (nonAdmin) {
        const delUserRes = await page.request.delete(`${BASE}/api/admin/users/${nonAdmin.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        assert(delUserRes.status() === 200, `User deleted (${delUserRes.status()})`);
      }

      await context.close();
    }

  } finally {
    await browser.close();
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n${CYAN}═══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET} (total: ${passed + failed})`);
  console.log(`${CYAN}═══════════════════════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`${RED}Fatal error:${RESET}`, err.message);
  process.exit(1);
});
