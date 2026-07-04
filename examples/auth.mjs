/**
 * ═══════════════════════════════════════════════════════════════
 * Gitnix Events — Authentication Module
 * ═══════════════════════════════════════════════════════════════
 *
 * Handles password hashing (bcrypt), JWT token creation/verification,
 * and auth middleware for protected routes.
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SALT_ROUNDS = 12;

// ═══════════════════════════════════════════════════════════════════════════════
// PASSWORD HASHING
// ═══════════════════════════════════════════════════════════════════════════════

export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

// ═══════════════════════════════════════════════════════════════════════════════
// JWT TOKENS
// ═══════════════════════════════════════════════════════════════════════════════

export function createToken(payload, secret, expiresIn = '7d') {
  return jwt.sign(payload, secret, { expiresIn, algorithm: 'HS256' });
}

export function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Middleware: Require authentication.
 * Extracts JWT from Authorization header or cookie.
 * Sets req.user = { id, email, role }
 */
export function requireAuth(secret) {
  return (req, res, next) => {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const payload = verifyToken(token, secret);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = payload;
    next();
  };
}

/**
 * Middleware: Require admin role.
 * Must be used after requireAuth.
 */
export function requireAdmin() {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };
}

/**
 * Middleware: Optional auth — sets req.user if token is valid, continues otherwise.
 */
export function optionalAuth(secret) {
  return (req, res, next) => {
    const token = extractToken(req);
    if (token) {
      const payload = verifyToken(token, secret);
      if (payload) req.user = payload;
    }
    next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function extractToken(req) {
  // 1. Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Check cookie
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }

  return null;
}
