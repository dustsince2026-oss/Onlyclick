'use strict';
// Auth: contraseñas con scrypt (crypto nativo, sin dependencias nativas)
// y sesiones con token HMAC firmado. Nunca se guarda la contraseña en texto plano.
const crypto = require('crypto');

function getSecret() {
  return process.env.AUTH_SECRET || 'dev-secret-change-me';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (check.length !== expected.length) return false;
  return crypto.timingSafeEqual(check, expected);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function signPayload(obj) {
  const payload = b64url(JSON.stringify(obj));
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${payload}.${sig}`;
}

function verifyPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); } catch (_) { return null; }
}

function signToken(userId) {
  return signPayload({ userId, purpose: 'session', exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
}

function verifyToken(token) {
  const data = verifyPayload(token);
  if (!data || !data.userId || data.exp < Date.now()) return null;
  if (data.purpose && data.purpose !== 'session') return null;
  return data.userId;
}

// Enlace de restablecimiento: vale 1 hora y solo sirve para eso
// (un token de sesión no sirve como enlace y viceversa).
function signResetToken(userId) {
  return signPayload({ userId, purpose: 'reset', exp: Date.now() + 60 * 60 * 1000 });
}

function verifyResetToken(token) {
  const data = verifyPayload(token);
  if (!data || data.purpose !== 'reset' || !data.userId || data.exp < Date.now()) return null;
  return data.userId;
}

function tokenFromReq(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.query && req.query.token) return req.query.token;
  if (req.body && req.body.token) return req.body.token;
  return null;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, signResetToken, verifyResetToken, tokenFromReq, publicUser };
