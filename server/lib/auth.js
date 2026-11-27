const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production-please";
const SESSION_COOKIE = "orivon_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Short-lived cache so we don't hit the DB for a full user-row fetch on every
// single request. Your DB is far from you (EU vs Nigeria), so this round-trip
// was adding real latency to every click. 30s TTL keeps preferences/password
// changes feeling instant while cutting DB load for everything else.
const USER_CACHE_TTL_MS = 30 * 1000;
const userCache = new Map(); // userId -> { user, expiresAt }

function invalidateUserCache(userId) {
  userCache.delete(userId);
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signSession(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000) });
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setSessionCookie(res, payload) {
  const token = signSession(payload);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

function getSession(req) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifySessionToken(token);
}

/** Express middleware — attaches req.user or responds 401. */
function requireAuth(db, schema, eq) {
  return async (req, res, next) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: "Not authenticated." });

    let user = userCache.get(session.userId)?.expiresAt > Date.now() ? userCache.get(session.userId).user : null;

    if (!user) {
      const rows = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
      user = rows[0];
      if (!user) return res.status(401).json({ error: "Not authenticated." });
      userCache.set(session.userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    }

    // A session's embedded version must match the user's current version.
    // Password reset, password change, and logout all bump this number,
    // which instantly invalidates every other cookie issued before that
    // point — even ones that haven't naturally expired yet.
    if (session.sessionVersion !== user.sessionVersion) {
      return res.status(401).json({ error: "Your session has expired. Please log in again." });
    }

    // A Pro plan whose paid period has ended behaves as Free everywhere.
    if (user.plan === "pro" && user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) {
      user = { ...user, plan: "free" };
    }

    req.user = user;
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signSession,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  requireAuth,
  invalidateUserCache,
  SESSION_COOKIE,
};
