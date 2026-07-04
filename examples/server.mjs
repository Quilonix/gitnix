/**
 * ═══════════════════════════════════════════════════════════════
 * Gitnix Events — Main Server
 * ═══════════════════════════════════════════════════════════════
 *
 * Multi-user event registration platform with:
 *  - Public event browsing
 *  - User signup/login (JWT + bcrypt)
 *  - Event registration (attendees)
 *  - Admin panel (CRUD events, manage users, view registrations)
 *  - Encrypted database (Gitnix/tweetnacl)
 *  - Security: helmet, CORS, rate limiting, input validation
 */

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

import { initDatabase, getDb } from './db.mjs';
import {
  hashPassword,
  verifyPassword,
  createToken,
  requireAuth,
  requireAdmin,
  optionalAuth,
} from './auth.mjs';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MIN || '15', 10);

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZE
// ═══════════════════════════════════════════════════════════════════════════════

// Init encrypted database
initDatabase(
  process.env.DB_PASSWORD || 'dev-password',
  process.env.GITHUB_TOKEN,
  process.env.GITHUB_REPO
);

const app = express();

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || CORS_ORIGIN === '*' || CORS_ORIGIN.split(',').includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW * 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Stricter rate limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later.' },
});

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>]/g, '');
}

function validateRequired(fields, body) {
  const missing = fields.filter(f => !body[f] || String(body[f]).trim() === '');
  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(', ')}`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    const err = validateRequired(['email', 'password', 'name'], req.body);
    if (err) return res.status(400).json({ error: err });
    if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const users = getDb().collection('users');
    const existing = users.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashedPw = await hashPassword(password);
    const user = users.insert({
      email: email.toLowerCase(),
      password: hashedPw,
      name: sanitize(name),
      role: 'attendee',
    });

    const token = createToken(
      { id: user._id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      JWT_EXPIRES_IN
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({
      user: { id: user._id, email: user.email, name: user.name, role: user.role },
      token,
    });
  } catch (e) {
    console.error('Signup error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Type validation — prevent NoSQL operator injection
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const err = validateRequired(['email', 'password'], req.body);
    if (err) return res.status(400).json({ error: err });

    const users = getDb().collection('users');
    const user = users.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await verifyPassword(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = createToken(
      { id: user._id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      JWT_EXPIRES_IN
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      user: { id: user._id, email: user.email, name: user.name, role: user.role },
      token,
    });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth(JWT_SECRET), (req, res) => {
  res.json({ user: req.user });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC EVENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/events — list all events (public)
app.get('/api/events', (req, res) => {
  try {
    const events = getDb().collection('events');
    const allEvents = events.find({});

    // Return events with registration counts
    const registrations = getDb().collection('registrations');
    const enriched = allEvents.map(event => {
      const regCount = registrations.count({ eventId: event._id, status: 'confirmed' });
      const { ...safe } = event;
      return { ...safe, registeredCount: regCount, spotsLeft: (event.capacity || 0) - regCount };
    });

    // Sort by date (upcoming first)
    enriched.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({ events: enriched });
  } catch (e) {
    console.error('Events list error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/:id — single event details (public)
app.get('/api/events/:id', (req, res) => {
  try {
    // Validate ID format (reject path traversal)
    const id = req.params.id;
    if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
      return res.status(400).json({ error: 'Invalid event ID' });
    }

    const events = getDb().collection('events');
    const event = events.findById(id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const registrations = getDb().collection('registrations');
    const regCount = registrations.count({ eventId: event._id, status: 'confirmed' });

    res.json({
      event: { ...event, registeredCount: regCount, spotsLeft: (event.capacity || 0) - regCount },
    });
  } catch (e) {
    console.error('Event detail error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRATION ROUTES (authenticated)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/events/:id/register — register for an event
app.post('/api/events/:id/register', requireAuth(JWT_SECRET), (req, res) => {
  try {
    const events = getDb().collection('events');
    const event = events.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Check capacity
    const registrations = getDb().collection('registrations');
    const regCount = registrations.count({ eventId: event._id, status: 'confirmed' });
    if (event.capacity && regCount >= event.capacity) {
      return res.status(400).json({ error: 'Event is full' });
    }

    // Check if already registered
    const existing = registrations.findOne({ eventId: event._id, userId: req.user.id });
    if (existing) {
      return res.status(409).json({ error: 'Already registered for this event' });
    }

    // Check event date hasn't passed
    if (new Date(event.date) < new Date()) {
      return res.status(400).json({ error: 'This event has already passed' });
    }

    const registration = registrations.insert({
      userId: req.user.id,
      userName: req.user.name,
      userEmail: req.user.email,
      eventId: event._id,
      eventTitle: event.title,
      status: 'confirmed',
    });

    res.status(201).json({ registration });
  } catch (e) {
    console.error('Registration error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id/register — cancel registration
app.delete('/api/events/:id/register', requireAuth(JWT_SECRET), (req, res) => {
  try {
    const registrations = getDb().collection('registrations');
    const count = registrations.delete({ eventId: req.params.id, userId: req.user.id });
    if (count === 0) return res.status(404).json({ error: 'Registration not found' });
    res.json({ message: 'Registration cancelled' });
  } catch (e) {
    console.error('Cancel registration error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/my/registrations — user's own registrations
app.get('/api/my/registrations', requireAuth(JWT_SECRET), (req, res) => {
  try {
    const registrations = getDb().collection('registrations');
    const mine = registrations.find({ userId: req.user.id });
    res.json({ registrations: mine });
  } catch (e) {
    console.error('My registrations error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

const adminAuth = [requireAuth(JWT_SECRET), requireAdmin()];

// POST /api/admin/events — create event
app.post('/api/admin/events', ...adminAuth, (req, res) => {
  try {
    const { title, description, date, location, capacity } = req.body;

    const err = validateRequired(['title', 'date', 'location', 'capacity'], req.body);
    if (err) return res.status(400).json({ error: err });

    const events = getDb().collection('events');
    const event = events.insert({
      title: sanitize(title),
      description: sanitize(description || ''),
      date,
      location: sanitize(location),
      capacity: parseInt(capacity, 10) || 50,
      createdBy: req.user.id,
    });

    res.status(201).json({ event });
  } catch (e) {
    console.error('Create event error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/events/:id — update event
app.put('/api/admin/events/:id', ...adminAuth, (req, res) => {
  try {
    const events = getDb().collection('events');
    const existing = events.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const updates = {};
    if (req.body.title) updates.title = sanitize(req.body.title);
    if (req.body.description !== undefined) updates.description = sanitize(req.body.description);
    if (req.body.date) updates.date = req.body.date;
    if (req.body.location) updates.location = sanitize(req.body.location);
    if (req.body.capacity) updates.capacity = parseInt(req.body.capacity, 10);

    events.updateById(req.params.id, updates);
    const updated = events.findById(req.params.id);
    res.json({ event: updated });
  } catch (e) {
    console.error('Update event error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/events/:id — delete event
app.delete('/api/admin/events/:id', ...adminAuth, (req, res) => {
  try {
    const events = getDb().collection('events');
    const count = events.deleteById(req.params.id);
    if (count === 0) return res.status(404).json({ error: 'Event not found' });

    // Also delete related registrations
    const registrations = getDb().collection('registrations');
    registrations.delete({ eventId: req.params.id });

    res.json({ message: 'Event deleted' });
  } catch (e) {
    console.error('Delete event error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/events/:id/registrations — view registrations for an event
app.get('/api/admin/events/:id/registrations', ...adminAuth, (req, res) => {
  try {
    const registrations = getDb().collection('registrations');
    const regs = registrations.find({ eventId: req.params.id });
    res.json({ registrations: regs });
  } catch (e) {
    console.error('Event registrations error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/users — list all users
app.get('/api/admin/users', ...adminAuth, (req, res) => {
  try {
    const users = getDb().collection('users');
    const allUsers = users.find({}).map(u => ({
      id: u._id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u._createdAt,
    }));
    res.json({ users: allUsers });
  } catch (e) {
    console.error('List users error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/users/:id/role — change user role
app.put('/api/admin/users/:id/role', ...adminAuth, (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'attendee'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or attendee' });
    }

    const users = getDb().collection('users');
    const count = users.updateById(req.params.id, { role });
    if (count === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ message: `User role updated to ${role}` });
  } catch (e) {
    console.error('Update role error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/users/:id — delete user
app.delete('/api/admin/users/:id', ...adminAuth, (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    const users = getDb().collection('users');
    const count = users.deleteById(req.params.id);
    if (count === 0) return res.status(404).json({ error: 'User not found' });

    // Also delete their registrations
    const registrations = getDb().collection('registrations');
    registrations.delete({ userId: req.params.id });

    res.json({ message: 'User deleted' });
  } catch (e) {
    console.error('Delete user error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/sync — push encrypted data to GitHub
app.post('/api/admin/sync', ...adminAuth, async (req, res) => {
  try {
    const db = getDb();
    if (!db.githubEnabled) {
      return res.status(400).json({ error: 'GitHub sync not configured' });
    }

    // Ensure collections are loaded
    db.collection('users');
    db.collection('events');
    db.collection('registrations');

    const result = await db.sync();
    res.json(result);
  } catch (e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: 'Sync failed: ' + e.message });
  }
});

// POST /api/admin/pull — pull encrypted data from GitHub
app.post('/api/admin/pull', ...adminAuth, async (req, res) => {
  try {
    const db = getDb();
    if (!db.githubEnabled) {
      return res.status(400).json({ error: 'GitHub sync not configured' });
    }

    db.collection('users');
    db.collection('events');
    db.collection('registrations');

    const result = await db.pull();
    res.json(result);
  } catch (e) {
    console.error('Pull error:', e.message);
    res.status(500).json({ error: 'Pull failed: ' + e.message });
  }
});

// GET /api/admin/stats — dashboard statistics
app.get('/api/admin/stats', ...adminAuth, (req, res) => {
  try {
    const users = getDb().collection('users');
    const events = getDb().collection('events');
    const registrations = getDb().collection('registrations');

    res.json({
      stats: {
        totalUsers: users.count(),
        totalEvents: events.count(),
        totalRegistrations: registrations.count(),
        upcomingEvents: events.find({}).filter(e => new Date(e.date) > new Date()).length,
      },
    });
  } catch (e) {
    console.error('Stats error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEED DEFAULT ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

async function seedAdmin() {
  const users = getDb().collection('users');
  const adminExists = users.findOne({ role: 'admin' });

  if (!adminExists) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const hashedPw = await hashPassword(adminPassword);

    users.insert({
      email: adminEmail,
      password: hashedPw,
      name: 'Admin',
      role: 'admin',
    });

    console.log(`✓ Default admin created: ${adminEmail}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPA FALLBACK & START
// ═══════════════════════════════════════════════════════════════════════════════

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function start() {
  await seedAdmin();

  app.listen(PORT, () => {
    console.log(`\n═══════════════════════════════════════════════`);
    console.log(`  Gitnix Events — Running on port ${PORT}`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Admin: ${process.env.ADMIN_EMAIL || 'admin@example.com'}`);
    console.log(`═══════════════════════════════════════════════\n`);
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
