const express = require("express");
const { z } = require("zod");
const { eq, desc } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");
const { logActivity } = require("../lib/activity");
const { getUsageSummary } = require("../lib/ai-usage");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

// The signed-in user's own AI usage and limits (shown in Settings).
router.get("/usage", auth, async (req, res) => {
  res.json({ usage: await getUsageSummary(req.user) });
});

router.get("/goals", auth, async (req, res) => {
  const goals = await db.select().from(schema.goals).where(eq(schema.goals.userId, req.user.id)).orderBy(desc(schema.goals.createdAt));
  res.json({ goals });
});

router.post("/goals", auth, async (req, res) => {
  const parsed = z.object({ title: z.string().min(1), type: z.string().default("custom") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const [goal] = await db.insert(schema.goals).values({ userId: req.user.id, title: parsed.data.title, type: parsed.data.type, status: "not-started" }).returning();
  await logActivity(db, schema, req.user.id, "goal_added", `Added goal: ${parsed.data.title}`);
  res.json({ goal });
});

router.get("/activity", auth, async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  let q = db.select().from(schema.activities).where(eq(schema.activities.userId, req.user.id)).orderBy(desc(schema.activities.createdAt));
  const rows = await q;
  res.json({ activities: limit ? rows.slice(0, limit) : rows });
});

module.exports = router;
