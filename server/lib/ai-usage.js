// Per-account AI usage tracking and rate limiting.
//
// Every AI call is logged to the ai_usage table with the token counts Groq
// reports. Before each call we check two limits for that account:
//   1. a burst limit   — max AI requests in the last 60 seconds
//   2. a token budget  — max tokens used in the last 24 hours (depends on plan)
//
// Limits can be changed without a code change via environment variables:
//   AI_REQUESTS_PER_MINUTE   (default 8)
//   AI_DAILY_TOKENS_FREE     (default 60000)
//   AI_DAILY_TOKENS_PRO      (default 300000)

const { and, eq, gt, sql } = require("drizzle-orm");
const { db, schema } = require("../db");

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getLimits(plan) {
  return {
    perMinute: intEnv("AI_REQUESTS_PER_MINUTE", 8),
    dailyTokens: plan === "pro" ? intEnv("AI_DAILY_TOKENS_PRO", 300000) : intEnv("AI_DAILY_TOKENS_FREE", 60000),
  };
}

class AiLimitError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = "AiLimitError";
    this.status = 429;
    this.publicMessage = message;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Pure decision function (no database access) so it can be tested on its own.
function evaluateLimits({ plan, requestsLastMinute, tokens24h }) {
  const limits = getLimits(plan);

  if (requestsLastMinute >= limits.perMinute) {
    return { retryAfterSeconds: 60, message: "You're sending AI requests too quickly. Please wait a minute and try again." };
  }
  if (tokens24h >= limits.dailyTokens) {
    const message = plan === "pro"
      ? "You've reached your AI usage limit for now. It frees up gradually over the next 24 hours."
      : "You've reached the AI usage limit for the Free plan. It frees up gradually over the next 24 hours, or you can upgrade to Pro for a higher limit.";
    return { retryAfterSeconds: 3600, message };
  }
  return null;
}

async function readWindow(userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const minuteAgo = new Date(Date.now() - 60 * 1000);
  const [row] = await db
    .select({
      tokens24h: sql`coalesce(sum(${schema.aiUsage.totalTokens}), 0)`,
      requestsLastMinute: sql`count(*) filter (where ${schema.aiUsage.createdAt} > ${minuteAgo.toISOString()}::timestamptz)`,
    })
    .from(schema.aiUsage)
    .where(and(eq(schema.aiUsage.userId, userId), gt(schema.aiUsage.createdAt, since)));
  return { tokens24h: Number(row.tokens24h) || 0, requestsLastMinute: Number(row.requestsLastMinute) || 0 };
}

// Throws AiLimitError (HTTP 429) when the account is over a limit.
async function checkLimits(user) {
  const window = await readWindow(user.id);
  const blocked = evaluateLimits({ plan: user.plan, ...window });
  if (blocked) throw new AiLimitError(blocked.message, blocked.retryAfterSeconds);
}

// Logging must never break the answer the user is waiting for, so failures
// here are reported to the server log and swallowed.
async function recordUsage({ user, feature, model, tokens }) {
  try {
    await db.insert(schema.aiUsage).values({
      userId: user.id,
      feature,
      model,
      promptTokens: tokens?.prompt_tokens || 0,
      completionTokens: tokens?.completion_tokens || 0,
      totalTokens: tokens?.total_tokens || 0,
    });
  } catch (e) {
    console.error("[ai-usage] Failed to record usage:", e.message);
  }
}

async function getUsageSummary(user) {
  const window = await readWindow(user.id);
  const limits = getLimits(user.plan);
  return {
    plan: user.plan === "pro" ? "pro" : "free",
    tokens24h: window.tokens24h,
    dailyTokenLimit: limits.dailyTokens,
    requestsLastMinute: window.requestsLastMinute,
    requestsPerMinuteLimit: limits.perMinute,
    percentUsed: Math.min(100, Math.round((window.tokens24h / limits.dailyTokens) * 100)),
  };
}

module.exports = { AiLimitError, evaluateLimits, checkLimits, recordUsage, getUsageSummary, getLimits };
