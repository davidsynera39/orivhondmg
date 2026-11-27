const express = require("express");
const { z } = require("zod");
const { eq, and, desc, inArray } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");
const { getAIProvider } = require("../ai");
const { buildUserContext } = require("../lib/context");
const { logActivity } = require("../lib/activity");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

// Get the user's scholarship profile (education level, field, funding needs, etc.)
router.get("/profile", auth, async (req, res) => {
  const rows = await db.select().from(schema.scholarshipProfiles).where(eq(schema.scholarshipProfiles.userId, req.user.id)).limit(1);
  res.json({ profile: rows[0] || null });
});

const profileSchema = z.object({
  educationLevel: z.string().optional(),
  field: z.string().optional(),
  country: z.string().optional(),
  nationality: z.string().optional(),
  targetDegree: z.string().optional(),
  fundingNeeds: z.string().optional(),
});

// Create or update the scholarship profile
router.put("/profile", auth, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const existing = await db.select().from(schema.scholarshipProfiles).where(eq(schema.scholarshipProfiles.userId, req.user.id)).limit(1);
  let profile;
  if (existing[0]) {
    [profile] = await db
      .update(schema.scholarshipProfiles)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(schema.scholarshipProfiles.userId, req.user.id))
      .returning();
  } else {
    [profile] = await db.insert(schema.scholarshipProfiles).values({ userId: req.user.id, ...parsed.data }).returning();
  }
  res.json({ profile });
});

// List scholarships already saved/discovered in the shared catalog
router.get("/", auth, async (req, res) => {
  const rows = await db.select().from(schema.scholarships).orderBy(desc(schema.scholarships.createdAt));
  res.json({ scholarships: rows });
});

// AI-assisted discovery — suggests well-known real scholarship programs matching the profile.
// These are NOT a live database lookup: Groq has no web access here, so results are the model's
// general knowledge of real, well-established programs, always marked unverified for the user
// to confirm on the official site before relying on them.
router.post("/discover", auth, async (req, res) => {
  const profiles = await db.select().from(schema.scholarshipProfiles).where(eq(schema.scholarshipProfiles.userId, req.user.id)).limit(1);
  const profile = profiles[0];
  if (!profile) return res.status(400).json({ error: "Fill out your scholarship profile first so suggestions can be matched to you." });

  const context = await buildUserContext(db, schema, req.user.id, "scholarship");
  const provider = getAIProvider();

  const result = await provider.generateStructured({
    usage: { user: req.user, feature: "scholarships" },
    system: `You are Orivon's scholarship discovery module. Suggest ONLY real, well-established, well-known scholarship or funding programs that you have genuine knowledge of (e.g. Chevening, Fulbright, DAAD, Mastercard Foundation, Commonwealth Scholarships, Erasmus Mundus, and similar). NEVER invent a scholarship name, provider, deadline, or funding amount. If you are not confident a program is real, leave it out rather than guessing. It is far better to return fewer results than to fabricate one.\n${context}`,
    schemaDescription: `{ "scholarships": [{ "name": string, "provider": string, "eligibility": string, "funding": string, "deadline": string, "destination": string, "requirements": string }] } — return 3-6 real programs. Use "Varies — check official site" for any deadline/funding/eligibility detail you are not certain about rather than inventing specifics.`,
    schema: z.object({
      scholarships: z.array(z.object({
        name: z.string(),
        provider: z.string(),
        eligibility: z.string(),
        funding: z.string(),
        deadline: z.string(),
        destination: z.string(),
        requirements: z.string(),
      })),
    }),
    mockFallback: { scholarships: [] },
    messages: [
      {
        role: "user",
        content: `Suggest real scholarship programs matching this profile. Education level: ${profile.educationLevel || "n/a"}. Field: ${profile.field || "n/a"}. Current country: ${profile.country || "n/a"}. Nationality: ${profile.nationality || "n/a"}. Target degree: ${profile.targetDegree || "n/a"}. Funding needs: ${profile.fundingNeeds || "n/a"}.`,
      },
    ],
  });

  const suggestions = result.scholarships || [];
  const inserted = [];
  for (const s of suggestions) {
    if (!s.name || !s.provider) continue;
    // avoid inserting exact duplicates of what's already in the catalog
    const existingRows = await db.select().from(schema.scholarships).where(eq(schema.scholarships.name, s.name));
    if (existingRows.length > 0) {
      inserted.push(existingRows[0]);
      continue;
    }
    const [row] = await db
      .insert(schema.scholarships)
      .values({
        name: s.name,
        provider: s.provider,
        eligibility: s.eligibility,
        funding: s.funding,
        deadline: s.deadline,
        destination: s.destination,
        requirements: s.requirements,
        verified: false,
      })
      .returning();
    inserted.push(row);
  }

  await logActivity(db, schema, req.user.id, "scholarships_discovered", `Found ${inserted.length} scholarship suggestions`);
  res.json({ scholarships: inserted, note: "AI-suggested from general knowledge — always verify details on the official scholarship site before applying." });
});

// List the user's applications, joined with scholarship details
router.get("/applications", auth, async (req, res) => {
  const apps = await db
    .select()
    .from(schema.scholarshipApplications)
    .where(eq(schema.scholarshipApplications.userId, req.user.id))
    .orderBy(desc(schema.scholarshipApplications.createdAt));

  const scholarshipIds = [...new Set(apps.map((a) => a.scholarshipId))];
  const scholarshipRows = scholarshipIds.length
    ? await db.select().from(schema.scholarships).where(inArray(schema.scholarships.id, scholarshipIds))
    : [];
  const scholarshipById = new Map(scholarshipRows.map((s) => [s.id, s]));

  const withDetails = apps.map((app) => ({ ...app, scholarship: scholarshipById.get(app.scholarshipId) || null }));
  res.json({ applications: withDetails });
});

const applySchema = z.object({ scholarshipId: z.string().min(1) });

// Start tracking an application to a scholarship
router.post("/applications", auth, async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const scholarshipRows = await db.select().from(schema.scholarships).where(eq(schema.scholarships.id, parsed.data.scholarshipId)).limit(1);
  if (!scholarshipRows[0]) return res.status(404).json({ error: "Scholarship not found." });

  const existing = await db
    .select()
    .from(schema.scholarshipApplications)
    .where(and(eq(schema.scholarshipApplications.userId, req.user.id), eq(schema.scholarshipApplications.scholarshipId, parsed.data.scholarshipId)));
  if (existing[0]) return res.json({ application: existing[0] });

  const [application] = await db
    .insert(schema.scholarshipApplications)
    .values({ userId: req.user.id, scholarshipId: parsed.data.scholarshipId, status: "not-started" })
    .returning();

  await logActivity(db, schema, req.user.id, "scholarship_application_started", `Started tracking an application to ${scholarshipRows[0].name}`);
  res.json({ application });
});

const updateAppSchema = z.object({
  status: z.enum(["not-started", "in-progress", "submitted", "accepted", "rejected"]).optional(),
  notes: z.string().optional(),
  checklist: z.string().optional(),
});

// Update an application's status/notes/checklist
router.patch("/applications/:id", auth, async (req, res) => {
  const parsed = updateAppSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const rows = await db.select().from(schema.scholarshipApplications).where(eq(schema.scholarshipApplications.id, req.params.id)).limit(1);
  const app = rows[0];
  if (!app || app.userId !== req.user.id) return res.status(404).json({ error: "Application not found." });

  const [updated] = await db
    .update(schema.scholarshipApplications)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(schema.scholarshipApplications.id, req.params.id))
    .returning();

  res.json({ application: updated });
});

module.exports = router;
