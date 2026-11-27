const express = require("express");
const crypto = require("crypto");
const { z } = require("zod");
const { eq, and, isNull, gt, sql } = require("drizzle-orm");
const { db, schema } = require("../db");
const { hashPassword, verifyPassword, setSessionCookie, clearSessionCookie, requireAuth, invalidateUserCache } = require("../lib/auth");
const { logActivity } = require("../lib/activity");
const { sendPasswordResetEmail, sendEmailVerificationEmail } = require("../lib/email");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

async function createAndSendVerificationEmail(user, req) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await db.insert(schema.emailVerifications).values({ userId: user.id, tokenHash, expiresAt });

  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
  const verifyUrl = `${appUrl}/#/verify-email?token=${rawToken}`;
  const firstName = (user.name || "").split(" ")[0];
  await sendEmailVerificationEmail({ to: user.email, verifyUrl, firstName });
}

const registerSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  const { name, email, password } = parsed.data;

  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1);
  if (existing[0]) return res.status(409).json({ error: "An account with this email already exists." });

  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(schema.users).values({ name, email: email.toLowerCase(), passwordHash }).returning();
  await db.insert(schema.subscriptions).values({ userId: user.id, plan: "free" });
  await logActivity(db, schema, user.id, "account_created", "Created an Orivon account.");
  await createAndSendVerificationEmail(user, req);

  setSessionCookie(res, { userId: user.id, email: user.email, sessionVersion: user.sessionVersion });
  res.status(201).json({ user: { id: user.id, name: user.name, email: user.email, emailVerified: false } });
});

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  const { email, password } = parsed.data;

  const rows = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1);
  const user = rows[0];
  const invalid = () => res.status(401).json({ error: "Invalid email or password." });
  if (!user) return invalid();
  if (!(await verifyPassword(password, user.passwordHash))) return invalid();

  setSessionCookie(res, { userId: user.id, email: user.email, sessionVersion: user.sessionVersion });
  res.json({ user: { id: user.id, name: user.name, email: user.email, onboardingCompleted: user.onboardingCompleted, emailVerified: Boolean(user.emailVerifiedAt) } });
});

router.post("/logout", auth, async (req, res) => {
  // Bumping sessionVersion invalidates this cookie (and any other copies of
  // it) immediately — not just on this device, but everywhere, since there's
  // no way to distinguish "this device's token" from "a copied token" once
  // it's been issued. Clearing the cookie alone only removes it from this
  // browser; a copied/leaked token would otherwise keep working.
  await db.update(schema.users).set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` }).where(eq(schema.users.id, req.user.id));
  invalidateUserCache(req.user.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/me", auth, (req, res) => {
  const u = req.user;
  res.json({ user: { id: u.id, name: u.name, email: u.email, onboardingCompleted: u.onboardingCompleted, plan: u.plan, planExpiresAt: u.planExpiresAt ? new Date(u.planExpiresAt).toISOString() : null, emailVerified: Boolean(u.emailVerifiedAt) } });
});

const forgotPasswordSchema = z.object({ email: z.string().email("Enter a valid email address") });

router.post("/forgot-password", async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  // Always respond the same way whether or not the account exists, so this
  // endpoint can't be used to check which emails are registered.
  const genericResponse = { ok: true, message: "If an account with that email exists, we've sent a password reset link." };

  const rows = await db.select().from(schema.users).where(eq(schema.users.email, parsed.data.email.toLowerCase())).limit(1);
  const user = rows[0];
  if (!user) return res.json(genericResponse);

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.insert(schema.passwordResets).values({ userId: user.id, tokenHash, expiresAt });

  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
  const resetUrl = `${appUrl}/#/reset-password?token=${rawToken}`;
  await sendPasswordResetEmail({ to: user.email, resetUrl });

  res.json(genericResponse);
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Reset token is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
  const rows = await db
    .select()
    .from(schema.passwordResets)
    .where(and(eq(schema.passwordResets.tokenHash, tokenHash), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, new Date())))
    .limit(1);
  const resetRecord = rows[0];
  if (!resetRecord) return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db.update(schema.users).set({ passwordHash, sessionVersion: sql`${schema.users.sessionVersion} + 1` }).where(eq(schema.users.id, resetRecord.userId));
  await db.update(schema.passwordResets).set({ usedAt: new Date() }).where(eq(schema.passwordResets.id, resetRecord.id));
  invalidateUserCache(resetRecord.userId);
  await logActivity(db, schema, resetRecord.userId, "password_reset", "Reset account password via email link.");

  res.json({ ok: true });
});

const verifyEmailSchema = z.object({ token: z.string().min(1, "Verification token is required") });

router.post("/verify-email", async (req, res) => {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
  const rows = await db
    .select()
    .from(schema.emailVerifications)
    .where(and(eq(schema.emailVerifications.tokenHash, tokenHash), isNull(schema.emailVerifications.usedAt), gt(schema.emailVerifications.expiresAt, new Date())))
    .limit(1);
  const record = rows[0];
  if (!record) return res.status(400).json({ error: "This verification link is invalid or has expired. Request a new one." });

  await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, record.userId));
  await db.update(schema.emailVerifications).set({ usedAt: new Date() }).where(eq(schema.emailVerifications.id, record.id));
  invalidateUserCache(record.userId);
  await logActivity(db, schema, record.userId, "email_verified", "Verified account email address.");

  res.json({ ok: true });
});

router.post("/resend-verification", auth, async (req, res) => {
  if (req.user.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });
  await createAndSendVerificationEmail(req.user, req);
  res.json({ ok: true });
});

module.exports = router;
module.exports.createAndSendVerificationEmail = createAndSendVerificationEmail;
