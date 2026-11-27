const express = require("express");
const { z } = require("zod");
const { eq, desc } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");
const { getAIProvider } = require("../ai");
const { buildUserContext } = require("../lib/context");
const { logActivity } = require("../lib/activity");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

router.get("/", auth, async (req, res) => {
  const goals = await db.select().from(schema.careerGoals).where(eq(schema.careerGoals.userId, req.user.id)).orderBy(desc(schema.careerGoals.createdAt));
  res.json({ goals: goals.map(deserialize) });
});

const assessSchema = z.object({
  interests: z.string().optional(), skills: z.string().optional(), education: z.string().optional(),
  experience: z.string().optional(), preferredWorkType: z.string().optional(), careerGoals: z.string().optional(),
});

router.post("/", auth, async (req, res) => {
  const parsed = assessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  const user = req.user;
  const data = parsed.data;

  const context = await buildUserContext(db, schema, user.id, "career");
  const provider = getAIProvider();
  const requestedRole = data.careerGoals || "a role matching your interests";

  const recommendation = await provider.generateStructured({
    usage: { user: req.user, feature: "career" },
    system: `You are Orivon's career guidance module. Based on the person's interests, skills, education, and experience, recommend ONE well-suited career path. Be realistic and specific. Distinguish your recommendation clearly as guidance, not a guarantee.\n${context}`,
    schemaDescription: `{ "title": string, "rationale": string (2-3 sentences, framed as guidance), "skillsNeeded": string[] (5-8 items), "skillGaps": string[] }`,
    schema: z.object({
      title: z.string(),
      rationale: z.string(),
      skillsNeeded: z.array(z.string()),
      skillGaps: z.array(z.string()),
    }),
    mockFallback: {
      title: requestedRole,
      rationale: "[Placeholder — add ANTHROPIC_API_KEY to .env for a real, personalized recommendation.]",
      skillsNeeded: (data.skills || "Core skills, Communication, Problem solving").split(",").map((s) => s.trim()).filter(Boolean),
      skillGaps: [],
    },
    messages: [{ role: "user", content: `Interests: ${data.interests || "not specified"}\nCurrent skills: ${data.skills || "not specified"}\nEducation: ${data.education || "not specified"}\nExperience: ${data.experience || "not specified"}\nPreferred work type: ${data.preferredWorkType || "not specified"}\nStated career goals: ${data.careerGoals || "not specified"}` }],
  });

  const [goal] = await db.insert(schema.careerGoals).values({
    userId: user.id, title: recommendation.title, rationale: recommendation.rationale,
    skillsNeeded: JSON.stringify(recommendation.skillsNeeded || []), skillGaps: JSON.stringify(recommendation.skillGaps || []), status: "active",
  }).returning();

  await logActivity(db, schema, user.id, "career_assessment", `Explored career path: ${recommendation.title}`);
  res.json({ goal: deserialize(goal) });
});

function deserialize(goal) {
  return {
    ...goal,
    skillsNeeded: goal.skillsNeeded ? JSON.parse(goal.skillsNeeded) : [],
    skillGaps: goal.skillGaps ? JSON.parse(goal.skillGaps) : [],
  };
}

module.exports = router;
