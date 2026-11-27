const express = require("express");
const { z } = require("zod");
const { eq, asc } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth } = require("../lib/auth");
const { getAIProvider } = require("../ai");
const { buildUserContext } = require("../lib/context");
const { checkLimits } = require("../lib/ai-usage");
const { logActivity } = require("../lib/activity");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

const ORIVON_CHAT_SYSTEM = `You are Orivon, a personal AI guide for learning, career development, and finding opportunities.
You help with career direction, learning plans, CV feedback, interview prep, scholarships, and research — as one connected guide, not a generic chatbot.
Be specific and actionable. Clearly label recommendations and opinions as guidance rather than guaranteed fact.
Never invent qualifications, achievements, or scholarship listings. If you don't know something concrete, say so rather than guessing.
Keep responses focused and conversational.

Write like you're talking to the person directly, in plain paragraphs — the way a knowledgeable friend would explain something out loud, not like a formatted document. Avoid bullet points, numbered lists, dashes, asterisks for emphasis, and headers unless the person is explicitly asking for a structured list (like a checklist or step-by-step plan) where a list is genuinely clearer than prose. Default to short, natural paragraphs.`;

router.post("/", auth, async (req, res) => {
  const parsed = z.object({ conversationId: z.string().optional(), message: z.string().min(1).max(4000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  const user = req.user;
  await checkLimits(user); // reject before saving anything, so a blocked message leaves no orphan conversation
  const { message } = parsed.data;
  let conversationId = parsed.data.conversationId;

  if (conversationId) {
    const rows = await db.select({ userId: schema.aiConversations.userId }).from(schema.aiConversations).where(eq(schema.aiConversations.id, conversationId)).limit(1);
    if (!rows[0] || rows[0].userId !== user.id) return res.status(404).json({ error: "Conversation not found." });
  } else {
    const [convo] = await db.insert(schema.aiConversations).values({ userId: user.id, context: "chat", title: message.slice(0, 60) }).returning();
    conversationId = convo.id;
  }

  const priorMessages = await db.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, conversationId)).orderBy(asc(schema.aiMessages.createdAt));
  await db.insert(schema.aiMessages).values({ conversationId, role: "user", content: message });

  const context = await buildUserContext(db, schema, user.id, "chat");
  const provider = getAIProvider();
  const result = await provider.generate({
    usage: { user: req.user, feature: "chat" },
    system: `${ORIVON_CHAT_SYSTEM}\n${context}`,
    messages: [...priorMessages.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: message }],
    maxTokens: 1000,
  });

  await db.insert(schema.aiMessages).values({ conversationId, role: "assistant", content: result.content });
  await db.update(schema.aiConversations).set({ updatedAt: new Date() }).where(eq(schema.aiConversations.id, conversationId));

  if (priorMessages.length === 0) await logActivity(db, schema, user.id, "chat_started", "Started a conversation with Orivon.");

  res.json({ conversationId, reply: result.content });
});

router.get("/", auth, async (req, res) => {
  const conversationId = req.query.conversationId;
  if (!conversationId) {
    const conversations = await db.select().from(schema.aiConversations).where(eq(schema.aiConversations.userId, req.user.id));
    return res.json({ conversations });
  }
  const rows = await db.select().from(schema.aiConversations).where(eq(schema.aiConversations.id, conversationId)).limit(1);
  if (!rows[0] || rows[0].userId !== req.user.id) return res.status(404).json({ error: "Conversation not found." });
  const messages = await db.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, conversationId)).orderBy(asc(schema.aiMessages.createdAt));
  res.json({ messages });
});

module.exports = router;
