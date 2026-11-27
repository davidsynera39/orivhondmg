const express = require("express");
const { z } = require("zod");
const { eq, asc, desc } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");
const { getAIProvider } = require("../ai");
const { buildUserContext } = require("../lib/context");
const { logActivity } = require("../lib/activity");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

router.get("/", auth, async (req, res) => {
  const roadmaps = await db.select().from(schema.learningRoadmaps).where(eq(schema.learningRoadmaps.userId, req.user.id)).orderBy(desc(schema.learningRoadmaps.createdAt));
  res.json({ roadmaps });
});

const createSchema = z.object({
  careerGoalId: z.string().optional(), skill: z.string().min(1, "Tell us what you want to learn"),
  currentLevel: z.string().optional(), desiredLevel: z.string().optional(),
  availableTime: z.string().optional(), deadline: z.string().optional(), learningPreference: z.string().optional(),
});

router.post("/", auth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  const user = req.user;
  const data = parsed.data;

  let careerGoalTitle;
  if (data.careerGoalId) {
    const rows = await db.select().from(schema.careerGoals).where(eq(schema.careerGoals.id, data.careerGoalId)).limit(1);
    const goal = rows[0];
    if (!goal || goal.userId !== user.id) return res.status(404).json({ error: "Career goal not found." });
    careerGoalTitle = goal.title;
  }

  const context = await buildUserContext(db, schema, user.id, "roadmap");
  const provider = getAIProvider();

  const plan = await provider.generateStructured({
    usage: { user: req.user, feature: "roadmap" },
    system: `You are Orivon's learning roadmap module. Build a structured, staged learning roadmap tailored to the person's goal, current level, and available time.\n${context}`,
    schemaDescription: `{ "title": string, "description": string, "stages": [{ "stage": string, "items": string[] }] } — 3-5 stages, fundamentals to job/goal readiness.`,
    schema: z.object({
      title: z.string(),
      description: z.string(),
      stages: z.array(z.object({ stage: z.string(), items: z.array(z.string()) })).min(1),
    }),
    mockFallback: {
      title: careerGoalTitle || data.skill,
      description: "[Placeholder roadmap — add ANTHROPIC_API_KEY to .env for a real, personalized plan.]",
      stages: [
        { stage: "Stage 1 — Fundamentals", items: ["Learn the core concepts", "Complete an introductory exercise"] },
        { stage: "Stage 2 — Practice", items: ["Build a small project", "Get feedback and iterate"] },
        { stage: "Stage 3 — Readiness", items: ["Polish your portfolio", "Review with Orivon Chat"] },
      ],
    },
    messages: [{ role: "user", content: `Goal / skill: ${careerGoalTitle || data.skill}\nCurrent level: ${data.currentLevel || "not specified"}\nDesired level: ${data.desiredLevel || "not specified"}\nAvailable time: ${data.availableTime || "not specified"}\nDeadline: ${data.deadline || "not specified"}\nLearning preference: ${data.learningPreference || "not specified"}` }],
  });

  const [roadmap] = await db.insert(schema.learningRoadmaps).values({
    userId: user.id, careerGoalId: data.careerGoalId, title: plan.title || data.skill, description: plan.description, deadline: data.deadline, status: "active",
  }).returning();

  let order = 0;
  const itemRows = [];
  for (const stage of plan.stages || []) {
    for (const item of stage.items || []) {
      itemRows.push({ roadmapId: roadmap.id, stage: stage.stage, title: item, order: order++ });
    }
  }
  if (itemRows.length) await db.insert(schema.roadmapItems).values(itemRows);

  await logActivity(db, schema, user.id, "roadmap_created", `Started roadmap: ${roadmap.title}`);
  res.json({ roadmap });
});

router.get("/:id", auth, async (req, res) => {
  const rows = await db.select().from(schema.learningRoadmaps).where(eq(schema.learningRoadmaps.id, req.params.id)).limit(1);
  const roadmap = rows[0];
  if (!roadmap || roadmap.userId !== req.user.id) return res.status(404).json({ error: "Roadmap not found." });
  const items = await db.select().from(schema.roadmapItems).where(eq(schema.roadmapItems.roadmapId, req.params.id)).orderBy(asc(schema.roadmapItems.order));
  res.json({ roadmap: { ...roadmap, items } });
});

router.patch("/:id/items/:itemId", auth, async (req, res) => {
  const completed = z.object({ completed: z.boolean() }).safeParse(req.body);
  if (!completed.success) return res.status(400).json({ error: "Invalid input" });

  const roadmapRows = await db.select().from(schema.learningRoadmaps).where(eq(schema.learningRoadmaps.id, req.params.id)).limit(1);
  const roadmap = roadmapRows[0];
  if (!roadmap || roadmap.userId !== req.user.id) return res.status(404).json({ error: "Roadmap not found." });

  const itemRows = await db.select().from(schema.roadmapItems).where(eq(schema.roadmapItems.id, req.params.itemId)).limit(1);
  const item = itemRows[0];
  if (!item || item.roadmapId !== req.params.id) return res.status(404).json({ error: "Roadmap item not found." });

  await db.update(schema.roadmapItems).set({
    completed: completed.data.completed, completedAt: completed.data.completed ? new Date().toISOString() : null,
  }).where(eq(schema.roadmapItems.id, req.params.itemId));

  if (completed.data.completed) await logActivity(db, schema, req.user.id, "roadmap_item_completed", `Completed "${item.title}"`);
  res.json({ ok: true });
});

module.exports = router;
