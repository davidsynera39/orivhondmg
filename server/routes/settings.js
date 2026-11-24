const express = require("express");
const { z } = require("zod");
const { eq, sql } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth, hashPassword, verifyPassword, clearSessionCookie, invalidateUserCache, setSessionCookie } = require("../lib/auth");
const { createAndSendVerificationEmail } = require("./auth");
const { deleteUserDir } = require("../lib/storage");
const { logActivity } = require("../lib/activity");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

router.get("/preferences", auth, (req, res) => {
  const prefs = req.user.preferences ? JSON.parse(req.user.preferences) : {};
  res.json({ preferences: { theme: "system", notificationsEnabled: true, aiTone: "encouraging", ...prefs } });
});

router.patch("/preferences", auth, async (req, res) => {
  const parsed = z.object({
    theme: z.enum(["light", "dark", "system"]).optional(),
    notificationsEnabled: z.boolean().optional(),
    aiTone: z.enum(["direct", "encouraging", "concise"]).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const existing = req.user.preferences ? JSON.parse(req.user.preferences) : {};
  const updated = { ...existing, ...parsed.data };
  await db.update(schema.users).set({ preferences: JSON.stringify(updated) }).where(eq(schema.users.id, req.user.id));
  invalidateUserCache(req.user.id);
  res.json({ preferences: updated });
});

router.post("/password", auth, async (req, res) => {
  const parsed = z.object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "New password must be at least 8 characters"),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const valid = await verifyPassword(parsed.data.currentPassword, req.user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect." });

  const passwordHash = await hashPassword(parsed.data.newPassword);
  const [updated] = await db
    .update(schema.users)
    .set({ passwordHash, sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(eq(schema.users.id, req.user.id))
    .returning();
  invalidateUserCache(req.user.id);
  await logActivity(db, schema, req.user.id, "password_changed", "Changed account password.");

  // Bumping sessionVersion just invalidated every cookie for this account,
  // including the one this very request came in on. Re-issue a fresh cookie
  // for this device so the person isn't logged out of the page they're
  // standing on — every *other* device's old cookie stays revoked.
  setSessionCookie(res, { userId: updated.id, email: updated.email, sessionVersion: updated.sessionVersion });

  res.json({ ok: true });
});

router.patch("/account", auth, async (req, res) => {
  const parsed = z.object({
    email: z.string().email("Enter a valid email address"),
    currentPassword: z.string().min(1, "Enter your current password to confirm this change"),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  const email = parsed.data.email.toLowerCase();

  if (!(await verifyPassword(parsed.data.currentPassword, req.user.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing[0] && existing[0].id !== req.user.id) return res.status(409).json({ error: "That email is already in use." });

  const emailChanged = email !== req.user.email;
  await db.update(schema.users).set({ email, emailVerifiedAt: emailChanged ? null : req.user.emailVerifiedAt }).where(eq(schema.users.id, req.user.id));
  invalidateUserCache(req.user.id);

  if (emailChanged) {
    await createAndSendVerificationEmail({ ...req.user, email }, req);
    await logActivity(db, schema, req.user.id, "email_changed", `Changed account email to ${email}. Re-verification required.`);
  }

  res.json({ ok: true, email, reverified: emailChanged });
});

router.post("/account", auth, async (req, res) => {
  const parsed = z.object({ password: z.string().min(1, "Password is required to confirm deletion") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const valid = await verifyPassword(parsed.data.password, req.user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Password is incorrect." });

  await db.delete(schema.users).where(eq(schema.users.id, req.user.id)); // FK cascade removes everything else
  invalidateUserCache(req.user.id);
  await deleteUserDir("cvs", req.user.id);
  await deleteUserDir("research", req.user.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
