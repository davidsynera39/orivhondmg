const { eq, desc } = require("drizzle-orm");

async function buildUserContext(db, schema, userId, scope) {
  const profiles = await db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)).limit(1);
  const profile = profiles[0];

  const baseLines = [];
  if (profile) {
    if (profile.primaryGoalTitle) baseLines.push(`Primary goal: ${profile.primaryGoalTitle}`);
    if (profile.experienceLevel) baseLines.push(`Experience level: ${profile.experienceLevel}`);
    if (profile.targetRole) baseLines.push(`Target role: ${profile.targetRole}`);
    if (profile.skills) baseLines.push(`Known skills: ${safeJoin(profile.skills)}`);
  }

  const section = (title, lines) => (lines.length === 0 ? "" : `\n${title}:\n${lines.join("\n")}\n`);

  if (scope === "career") {
    const goals = await db.select().from(schema.careerGoals).where(eq(schema.careerGoals.userId, userId)).orderBy(desc(schema.careerGoals.createdAt)).limit(5);
    return section("User context", baseLines) + section("Existing career goals", goals.map((g) => `- ${g.title} (status: ${g.status})`));
  }
  if (scope === "roadmap") {
    const roadmaps = await db.select().from(schema.learningRoadmaps).where(eq(schema.learningRoadmaps.userId, userId)).orderBy(desc(schema.learningRoadmaps.createdAt)).limit(5);
    return section("User context", baseLines) + section("Existing roadmaps", roadmaps.map((r) => `- ${r.title} (status: ${r.status})`));
  }
  if (scope === "interview") {
    const sessions = await db.select().from(schema.interviewSessions).where(eq(schema.interviewSessions.userId, userId)).orderBy(desc(schema.interviewSessions.createdAt)).limit(3);
    return section("User context", baseLines) + section("Recent interview sessions", sessions.map((s) => `- ${s.role} (${s.interviewType}), status: ${s.status}`));
  }
  if (scope === "cv" || scope === "research") {
    return section("User context", scope === "research" ? baseLines.slice(0, 1) : baseLines);
  }
  if (scope === "scholarship") {
    const profiles = await db.select().from(schema.scholarshipProfiles).where(eq(schema.scholarshipProfiles.userId, userId)).limit(1);
    const sp = profiles[0];
    const lines = [];
    if (sp) {
      if (sp.educationLevel) lines.push(`Education level: ${sp.educationLevel}`);
      if (sp.field) lines.push(`Field of study: ${sp.field}`);
      if (sp.country) lines.push(`Current country: ${sp.country}`);
      if (sp.nationality) lines.push(`Nationality: ${sp.nationality}`);
      if (sp.targetDegree) lines.push(`Target degree: ${sp.targetDegree}`);
      if (sp.fundingNeeds) lines.push(`Funding needs: ${sp.fundingNeeds}`);
    }
    return section("User context", baseLines) + section("Scholarship profile", lines);
  }
  return section("User context", baseLines);
}

function safeJoin(jsonArrayString) {
  try {
    const arr = JSON.parse(jsonArrayString);
    return Array.isArray(arr) ? arr.join(", ") : jsonArrayString;
  } catch {
    return jsonArrayString;
  }
}

module.exports = { buildUserContext };
