const express = require("express");
const { z } = require("zod");
const { eq, asc, desc } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");
const { getAIProvider } = require("../ai");
const { buildUserContext } = require("../lib/context");
const { checkLimits } = require("../lib/ai-usage");
const { logActivity } = require("../lib/activity");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

// List all of the user's interview sessions
router.get("/", auth, async (req, res) => {
  const sessions = await db
    .select()
    .from(schema.interviewSessions)
    .where(eq(schema.interviewSessions.userId, req.user.id))
    .orderBy(desc(schema.interviewSessions.createdAt));
  res.json({ sessions });
});

const startSchema = z.object({
  role: z.string().min(1, "Tell us what role you're interviewing for"),
  company: z.string().optional(),
  industry: z.string().optional(),
  experienceLevel: z.string().optional(),
  interviewType: z.string().min(1).default("behavioral"),
  questionCount: z.number().int().min(3).max(10).optional(),
});

// Start a new mock interview session — generates a set of tailored questions
router.post("/", auth, async (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  const user = req.user;
  await checkLimits(user); // reject before creating a session that would have no questions
  const data = parsed.data;
  const questionCount = data.questionCount || 5;

  const [session] = await db
    .insert(schema.interviewSessions)
    .values({
      userId: user.id,
      role: data.role,
      company: data.company,
      industry: data.industry,
      experienceLevel: data.experienceLevel,
      interviewType: data.interviewType,
      status: "in-progress",
    })
    .returning();

  const context = await buildUserContext(db, schema, user.id, "interview");
  const provider = getAIProvider();

  const generated = await provider.generateStructured({
    usage: { user: req.user, feature: "interview_questions" },
    system: `You are Orivon's interview prep module. Generate realistic, role-specific mock interview questions.\n${context}`,
    schemaDescription: `{ "questions": string[] } — ${questionCount} interview questions appropriate for the role, interview type, and experience level given. No preamble per question, just the question text.`,
    schema: z.object({ questions: z.array(z.string()).min(1) }),
    mockFallback: {
      questions: Array.from({ length: questionCount }, (_, i) => `[Placeholder question ${i + 1} — add GROQ_API_KEY to .env for real, role-specific questions.]`),
    },
    messages: [
      {
        role: "user",
        content: `Role: ${data.role}\nCompany: ${data.company || "not specified"}\nIndustry: ${data.industry || "not specified"}\nExperience level: ${data.experienceLevel || "not specified"}\nInterview type: ${data.interviewType}\nGenerate exactly ${questionCount} questions.`,
      },
    ],
  });

  const questions = (generated.questions || []).slice(0, questionCount);
  const inserted = questions.length
    ? await db
        .insert(schema.interviewQuestions)
        .values(questions.map((q, i) => ({ sessionId: session.id, question: q, order: i })))
        .returning()
    : [];

  await logActivity(db, schema, user.id, "interview_started", `Started a mock interview for ${data.role}`);
  res.json({ session, questions: inserted });
});

// Get a single session with all its questions
router.get("/:id", auth, async (req, res) => {
  const rows = await db.select().from(schema.interviewSessions).where(eq(schema.interviewSessions.id, req.params.id)).limit(1);
  const session = rows[0];
  if (!session || session.userId !== req.user.id) return res.status(404).json({ error: "Interview session not found." });
  const questions = await db
    .select()
    .from(schema.interviewQuestions)
    .where(eq(schema.interviewQuestions.sessionId, req.params.id))
    .orderBy(asc(schema.interviewQuestions.order));
  res.json({ session: { ...session, questions } });
});

const answerSchema = z.object({ answer: z.string().min(1, "Enter an answer before submitting.") });

// Submit an answer to one question — returns AI evaluation for that answer
router.post("/:id/questions/:questionId/answer", auth, async (req, res) => {
  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });

  const sessionRows = await db.select().from(schema.interviewSessions).where(eq(schema.interviewSessions.id, req.params.id)).limit(1);
  const session = sessionRows[0];
  if (!session || session.userId !== req.user.id) return res.status(404).json({ error: "Interview session not found." });

  const questionRows = await db.select().from(schema.interviewQuestions).where(eq(schema.interviewQuestions.id, req.params.questionId)).limit(1);
  const question = questionRows[0];
  if (!question || question.sessionId !== req.params.id) return res.status(404).json({ error: "Question not found." });

  const provider = getAIProvider();
  const evaluation = await provider.generateStructured({
    usage: { user: req.user, feature: "interview_answer" },
    system: `You are Orivon's interview coach. Evaluate a candidate's answer to a mock interview question. Be specific, honest, and constructive — point out what worked and what to improve.`,
    schemaDescription: `{ "evaluation": string, "score": number } — score is 1-10. evaluation is 2-4 sentences of specific, actionable feedback.`,
    schema: z.object({ evaluation: z.string(), score: z.coerce.number().min(1).max(10) }),
    mockFallback: { evaluation: "[Placeholder feedback — add GROQ_API_KEY to .env for real evaluation.]", score: 5 },
    messages: [
      {
        role: "user",
        content: `Role: ${session.role}\nInterview type: ${session.interviewType}\nQuestion: ${question.question}\nCandidate's answer: ${parsed.data.answer}`,
      },
    ],
  });

  await db
    .update(schema.interviewQuestions)
    .set({ answer: parsed.data.answer, evaluation: evaluation.evaluation })
    .where(eq(schema.interviewQuestions.id, req.params.questionId));

  res.json({ evaluation: evaluation.evaluation, score: evaluation.score });
});

// Complete the session — generates overall feedback and score across all answered questions
router.post("/:id/complete", auth, async (req, res) => {
  const sessionRows = await db.select().from(schema.interviewSessions).where(eq(schema.interviewSessions.id, req.params.id)).limit(1);
  const session = sessionRows[0];
  if (!session || session.userId !== req.user.id) return res.status(404).json({ error: "Interview session not found." });

  const questions = await db
    .select()
    .from(schema.interviewQuestions)
    .where(eq(schema.interviewQuestions.sessionId, req.params.id))
    .orderBy(asc(schema.interviewQuestions.order));

  const answered = questions.filter((q) => q.answer);
  if (answered.length === 0) return res.status(400).json({ error: "Answer at least one question before completing the session." });

  const provider = getAIProvider();
  const summary = await provider.generateStructured({
    usage: { user: req.user, feature: "interview_summary" },
    system: `You are Orivon's interview coach. Summarize a candidate's overall mock interview performance across all their answered questions.`,
    schemaDescription: `{ "overallScore": number, "feedback": string } — overallScore is 1-100. feedback is a short paragraph covering strengths, weaknesses, and concrete next steps.`,
    schema: z.object({ overallScore: z.coerce.number().min(1).max(100), feedback: z.string() }),
    mockFallback: { overallScore: 60, feedback: "[Placeholder overall feedback — add GROQ_API_KEY to .env for a real summary.]" },
    messages: [
      {
        role: "user",
        content: `Role: ${session.role}\nInterview type: ${session.interviewType}\n\n${answered
          .map((q, i) => `Q${i + 1}: ${q.question}\nAnswer: ${q.answer}\nEvaluation given: ${q.evaluation || "n/a"}`)
          .join("\n\n")}`,
      },
    ],
  });

  await db
    .update(schema.interviewSessions)
    .set({ status: "completed", overallScore: summary.overallScore, feedback: summary.feedback, completedAt: new Date().toISOString() })
    .where(eq(schema.interviewSessions.id, req.params.id));

  await logActivity(db, schema, req.user.id, "interview_completed", `Completed a mock interview for ${session.role} — score ${summary.overallScore}/100`);
  res.json({ overallScore: summary.overallScore, feedback: summary.feedback });
});

module.exports = router;
