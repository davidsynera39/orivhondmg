const { pgTable, text, integer, boolean, timestamp, index } = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ────────────────────────────────────────────────────────────
// CORE IDENTITY
// ────────────────────────────────────────────────────────────

const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
  plan: text("plan").notNull().default("free"),
  preferences: text("preferences"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  sessionVersion: integer("session_version").notNull().default(0),
  planExpiresAt: timestamp("plan_expires_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const userProfiles = pgTable("user_profiles", {
  id: id(),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  occupationStatus: text("occupation_status"),
  experienceLevel: text("experience_level"),
  primaryGoalType: text("primary_goal_type"),
  primaryGoalTitle: text("primary_goal_title"),
  targetRole: text("target_role"),
  industry: text("industry"),
  locationPref: text("location_pref"),
  skills: text("skills"),
  interests: text("interests"),
  bio: text("bio"),
  updatedAt: updatedAt(),
});

const education = pgTable("education", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  institution: text("institution"),
  fieldOfStudy: text("field_of_study"),
  level: text("level"),
  graduationYear: integer("graduation_year"),
  createdAt: createdAt(),
});

const careerGoals = pgTable("career_goals", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  rationale: text("rationale"),
  skillsNeeded: text("skills_needed"),
  skillGaps: text("skill_gaps"),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const learningGoals = pgTable("learning_goals", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  skill: text("skill").notNull(),
  currentLevel: text("current_level"),
  desiredLevel: text("desired_level"),
  deadline: text("deadline"),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

const learningRoadmaps = pgTable("learning_roadmaps", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  careerGoalId: text("career_goal_id").references(() => careerGoals.id),
  learningGoalId: text("learning_goal_id").references(() => learningGoals.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("active"),
  deadline: text("deadline"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const roadmapItems = pgTable("roadmap_items", {
  id: id(),
  roadmapId: text("roadmap_id").notNull().references(() => learningRoadmaps.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  title: text("title").notNull(),
  notes: text("notes"),
  order: integer("order").notNull().default(0),
  completed: boolean("completed").notNull().default(false),
  completedAt: text("completed_at"),
  createdAt: createdAt(),
});

const cvs = pgTable("cvs", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  storagePath: text("storage_path").notNull(),
  extractedText: text("extracted_text"),
  isOriginal: boolean("is_original").notNull().default(true),
  createdAt: createdAt(),
});

const cvReviews = pgTable("cv_reviews", {
  id: id(),
  cvId: text("cv_id").notNull().references(() => cvs.id, { onDelete: "cascade" }),
  jobDescription: text("job_description"),
  matchScore: integer("match_score"),
  strongAreas: text("strong_areas"),
  weakAreas: text("weak_areas"),
  recommendations: text("recommendations"),
  rawAnalysis: text("raw_analysis"),
  versionId: text("version_id"), // which saved version of the CV was reviewed (null = the original upload)
  createdAt: createdAt(),
});

// Corrected/edited copies of a CV. The original upload text stays in cvs.extractedText;
// the newest row here is the "current" working version.
const cvVersions = pgTable("cv_versions", {
  id: id(),
  cvId: text("cv_id").notNull().references(() => cvs.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  label: text("label").notNull(),
  createdAt: createdAt(),
}, (t) => [index("cv_versions_cv_idx").on(t.cvId, t.createdAt)]);

const interviewSessions = pgTable("interview_sessions", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  company: text("company"),
  industry: text("industry"),
  experienceLevel: text("experience_level"),
  interviewType: text("interview_type").notNull(),
  status: text("status").notNull().default("in-progress"),
  overallScore: integer("overall_score"),
  feedback: text("feedback"),
  createdAt: createdAt(),
  completedAt: text("completed_at"),
});

const interviewQuestions = pgTable("interview_questions", {
  id: id(),
  sessionId: text("session_id").notNull().references(() => interviewSessions.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  answer: text("answer"),
  evaluation: text("evaluation"),
  order: integer("order").notNull().default(0),
  createdAt: createdAt(),
});

const scholarshipProfiles = pgTable("scholarship_profiles", {
  id: id(),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  educationLevel: text("education_level"),
  field: text("field"),
  country: text("country"),
  nationality: text("nationality"),
  targetDegree: text("target_degree"),
  fundingNeeds: text("funding_needs"),
  updatedAt: updatedAt(),
});

const scholarships = pgTable("scholarships", {
  id: id(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  eligibility: text("eligibility"),
  funding: text("funding"),
  deadline: text("deadline"),
  destination: text("destination"),
  requirements: text("requirements"),
  sourceUrl: text("source_url"),
  verified: boolean("verified").notNull().default(false),
  createdAt: createdAt(),
});

const scholarshipApplications = pgTable("scholarship_applications", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scholarshipId: text("scholarship_id").notNull().references(() => scholarships.id),
  status: text("status").notNull().default("not-started"),
  checklist: text("checklist"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const researchProjects = pgTable("research_projects", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  researchQuestion: text("research_question"),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const researchDocuments = pgTable("research_documents", {
  id: id(),
  projectId: text("project_id").notNull().references(() => researchProjects.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  storagePath: text("storage_path").notNull(),
  extractedText: text("extracted_text"),
  createdAt: createdAt(),
});

const researchNotes = pgTable("research_notes", {
  id: id(),
  projectId: text("project_id").notNull().references(() => researchProjects.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  source: text("source"),
  createdAt: createdAt(),
});

const aiConversations = pgTable("ai_conversations", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  context: text("context").notNull(),
  contextRefId: text("context_ref_id"),
  title: text("title"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const aiMessages = pgTable("ai_messages", {
  id: id(),
  conversationId: text("conversation_id").notNull().references(() => aiConversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: createdAt(),
});

const activities = pgTable("activities", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  summary: text("summary").notNull(),
  metadata: text("metadata"),
  createdAt: createdAt(),
});

const notifications = pgTable("notifications", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  message: text("message").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: createdAt(),
});

const goals = pgTable("goals", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  deadline: text("deadline"),
  status: text("status").notNull().default("not-started"),
  progress: integer("progress").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const subscriptions = pgTable("subscriptions", {
  id: id(),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  renewsAt: text("renews_at"),
  createdAt: createdAt(),
});

const passwordResets = pgTable("password_resets", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

const emailVerifications = pgTable("email_verifications", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

const aiUsage = pgTable("ai_usage", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  feature: text("feature").notNull(),
  model: text("model"),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("ai_usage_user_created_idx").on(t.userId, t.createdAt)]);

const payments = pgTable("payments", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reference: text("reference").notNull().unique(),
  amountKobo: integer("amount_kobo").notNull(),
  currency: text("currency").notNull().default("NGN"),
  planKey: text("plan_key").notNull().default("pro"),
  status: text("status").notNull().default("pending"),
  paystackId: text("paystack_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("payments_user_idx").on(t.userId)]);

// Downloadable app builds (e.g. the Android APK). The file itself lives in Supabase
// Storage; this table records which file is current. Rows are added by hand in the
// Supabase Table Editor, so the id has a database default.
const appReleases = pgTable("app_releases", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  platform: text("platform").notNull().default("android"),
  version: text("version").notNull(),
  fileUrl: text("file_url").notNull(),
  sizeBytes: integer("size_bytes"),
  releaseNotes: text("release_notes"),
  isActive: boolean("is_active").notNull().default(true),
  downloadCount: integer("download_count").notNull().default(0),
  createdAt: createdAt(),
});

module.exports = { users, userProfiles, education, careerGoals, learningGoals, learningRoadmaps, roadmapItems, cvs, cvReviews, interviewSessions, interviewQuestions, scholarshipProfiles, scholarships, scholarshipApplications, researchProjects, researchDocuments, researchNotes, aiConversations, aiMessages, activities, notifications, goals, subscriptions, passwordResets, emailVerifications, aiUsage, payments, cvVersions, appReleases };
