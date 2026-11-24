// Optional PIN protection. When ACCESS_PIN is set, every /api route except the public ones
// needs a signed cookie, which is issued after the correct PIN is entered.
import crypto from 'node:crypto';

const COOKIE = 'wl_auth';
const MAX_AGE_DAYS = 30;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 30;
const PUBLIC_PATHS = new Set(['/api/health', '/api/session', '/api/login', '/api/logout']);

export function createAuth({ pin = process.env.ACCESS_PIN, secret = process.env.SESSION_SECRET } = {}) {
  const required = !!(pin && String(pin).trim());
  pin = required ? String(pin).trim() : '';
  // Without SESSION_SECRET a random one is used, so a restart signs everyone out (harmless).
  const key = secret || crypto.randomBytes(32).toString('hex');
  // The token depends on the PIN, so changing the PIN signs out every device.
  const token = crypto.createHmac('sha256', key).update(`waybill-logger:${pin}`).digest('base64url');

  const fails = new Map(); // ip -> [timestamps]
  let globalFails = [];

  const prune = (list, now) => list.filter((t) => now - t < WINDOW_MS);

  function readCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return decodeURIComponent(v.join('='));
    }
    return '';
  }

  function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }

  function isAuthed(req) {
    return !required || safeEqual(readCookie(req), token);
  }

  function setCookie(req, res, value, maxAgeSec) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
  }

  /** Blocks /api routes (except PUBLIC_PATHS) until the PIN has been entered. */
  function middleware(req, res, next) {
    if (!required || !req.path.startsWith('/api/') || PUBLIC_PATHS.has(req.path) || isAuthed(req)) return next();
    res.status(401).json({ error: 'Enter the PIN to continue.', needPin: true });
  }

  function session(req, res) {
    res.json({ required, ok: isAuthed(req) });
  }

  function login(req, res) {
    if (!required) return res.json({ ok: true });
    const now = Date.now();
    const ip = req.ip || 'unknown';
    const mine = prune(fails.get(ip) || [], now);
    globalFails = prune(globalFails, now);
    if (mine.length >= MAX_FAILS_PER_IP || globalFails.length >= MAX_FAILS_GLOBAL) {
      return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes and try again.' });
    }
    if (safeEqual(String(req.body?.pin ?? '').trim(), pin)) {
      fails.delete(ip);
      setCookie(req, res, token, MAX_AGE_DAYS * 86400);
      return res.json({ ok: true });
    }
    mine.push(now);
    fails.set(ip, mine);
    globalFails.push(now);
    const left = MAX_FAILS_PER_IP - mine.length;
    res.status(401).json({ error: left > 0 ? `Wrong PIN. ${left} attempt(s) left.` : 'Too many wrong PINs. Wait 15 minutes and try again.' });
  }

  function logout(req, res) {
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  }

  return { required, middleware, session, login, logout };
}
