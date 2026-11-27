const express = require("express");
const { z } = require("zod");
const { eq } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");
const { logActivity } = require("../lib/activity");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

const onboardingSchema = z.object({
  aboutYou: z.object({
    educationLevel: z.string().optional(),
    fieldOfStudy: z.string().optional(),
    institution: z.string().optional(),
    graduationYear: z.number().optional(),
    occupationStatus: z.string().optional(),
    experienceLevel: z.string().optional(),
  }),
  goals: z.array(z.string()).min(1, "Select at least one goal"),
  situation: z.record(z.string(), z.string()).optional(),
});

const GOAL_LABELS = {
  "get-job": "Get a job", "change-careers": "Change careers", "learn-skill": "Learn a new skill",
  "prepare-interview": "Prepare for an interview", "improve-cv": "Improve my CV",
  "find-scholarships": "Find scholarships", "conduct-research": "Conduct research",
  "start-learning": "Start learning", "explore-careers": "Explore career options", other: "A personal goal",
};

function deriveGoalTitle(goalKey, situation) {
  if (situation?.targetRole) return situation.targetRole;
  if (situation?.skill) return `Learn ${situation.skill}`;
  return GOAL_LABELS[goalKey] || "A personal goal";
}
function mapGoalType(goalKey) {
  if (["get-job", "change-careers", "explore-careers"].includes(goalKey)) return "career";
  if (["learn-skill", "start-learning"].includes(goalKey)) return "learning";
  if (goalKey === "find-scholarships") return "application";
  if (goalKey === "conduct-research") return "research";
  return "custom";
}

router.post("/", auth, async (req, res) => {
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  const { aboutYou, goals, situation } = parsed.data;
  const user = req.user;
  const primaryGoal = goals[0];

  if (aboutYou.institution || aboutYou.fieldOfStudy || aboutYou.educationLevel) {
    await db.insert(schema.education).values({
      userId: user.id, institution: aboutYou.institution, fieldOfStudy: aboutYou.fieldOfStudy,
      level: aboutYou.educationLevel, graduationYear: aboutYou.graduationYear,
    });
  }

  const primaryGoalTitle = deriveGoalTitle(primaryGoal, situation);

  const existingProfile = await db.select({ id: schema.userProfiles.id }).from(schema.userProfiles).where(eq(schema.userProfiles.userId, user.id)).limit(1);

  const profileValues = {
    occupationStatus: aboutYou.occupationStatus,
    experienceLevel: situation?.experienceLevel || aboutYou.experienceLevel,
    primaryGoalType: primaryGoal,
    primaryGoalTitle,
    targetRole: situation?.targetRole,
    industry: situation?.industry,
    locationPref: situation?.locationPref,
    skills: situation?.currentSkills ? JSON.stringify(situation.currentSkills.split(",").map((s) => s.trim()).filter(Boolean)) : undefined,
  };

  if (existingProfile[0]) {
    await db.update(schema.userProfiles).set(profileValues).where(eq(schema.userProfiles.userId, user.id));
  } else {
    await db.insert(schema.userProfiles).values({ userId: user.id, ...profileValues });
  }

  if (["get-job", "change-careers", "explore-careers"].includes(primaryGoal)) {
    await db.insert(schema.careerGoals).values({ userId: user.id, title: primaryGoalTitle, status: "active" });
  } else if (["learn-skill", "start-learning"].includes(primaryGoal)) {
    await db.insert(schema.learningGoals).values({
      userId: user.id, skill: situation?.skill || primaryGoalTitle,
      currentLevel: situation?.currentLevel, desiredLevel: situation?.desiredLevel, deadline: situation?.targetCompletionDate,
    });
  }

  await db.insert(schema.goals).values({ userId: user.id, type: mapGoalType(primaryGoal), title: primaryGoalTitle, status: "not-started" });
  await db.update(schema.users).set({ onboardingCompleted: true }).where(eq(schema.users.id, user.id));
  await logActivity(db, schema, user.id, "onboarding_completed", `Set primary goal: ${primaryGoalTitle}`);

  res.json({ ok: true, primaryGoalTitle });
});

module.exports = router;
