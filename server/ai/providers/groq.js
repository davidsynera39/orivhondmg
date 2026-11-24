const { checkLimits, recordUsage } = require("../../lib/ai-usage");

const DEFAULT_MODEL = "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2; // total attempts = MAX_RETRIES + 1
const RETRY_BASE_DELAY_MS = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GroqProvider {
  constructor(apiKey, model = DEFAULT_MODEL) {
    const key = apiKey || process.env.GROQ_API_KEY;
    if (!key) throw new Error("GROQ_API_KEY is not set.");
    this.apiKey = key;
    this.model = model;
    this.name = "groq";
  }

  async _call(payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(GROQ_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: this.model, ...payload }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.ok) return response.json();

        const isRetryable = response.status === 429 || response.status >= 500;
        const errText = await response.text().catch(() => "");

        if (isRetryable && attempt < MAX_RETRIES) {
          lastError = new Error(`Groq API error (${response.status}): ${errText.slice(0, 300)}`);
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }

        throw new Error(`Groq API error (${response.status}): ${errText.slice(0, 300)}`);
      } catch (err) {
        clearTimeout(timer);

        const isAbort = err.name === "AbortError";
        const isNetworkError = err.cause?.code || err.message?.includes("fetch failed");

        if ((isAbort || isNetworkError) && attempt < MAX_RETRIES) {
          lastError = isAbort ? new Error(`Groq request timed out after ${timeoutMs}ms`) : err;
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }

        if (isAbort) throw new Error(`Groq request timed out after ${timeoutMs}ms (after ${attempt + 1} attempt(s))`);
        throw err;
      }
    }

    throw lastError || new Error("Groq API request failed after retries.");
  }

  // usage: { user, feature } — identifies whose account to rate limit and bill
  // tokens to. Every call site should pass it.
  async generate({ system, messages, maxTokens = 2048, temperature = 0.7, jsonMode = false, usage }) {
    if (usage) await checkLimits(usage.user);
    else console.warn("[groq] AI call made without usage tracking context — it is not being counted or limited.");

    const chatMessages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    const payload = {
      messages: chatMessages,
      max_tokens: maxTokens,
      temperature,
    };
    if (jsonMode) payload.response_format = { type: "json_object" };

    const data = await this._call(payload);
    // Count the tokens even if the answer later turns out truncated or invalid —
    // they were still spent.
    if (usage) await recordUsage({ user: usage.user, feature: usage.feature, model: this.model, tokens: data.usage });

    const choice = data.choices?.[0];
    const content = choice?.message?.content || "";
    const finishReason = choice?.finish_reason;

    if (finishReason === "length") {
      console.warn("[groq] Response was truncated (hit max_tokens) — consider raising maxTokens for this call.");
    }

    return { content, raw: data, truncated: finishReason === "length" };
  }

  // schema: optional Zod schema. When provided, the parsed JSON is validated
  // (and coerced where the schema allows) before being returned, so callers
  // never have to trust the model's output shape blindly.
  async generateStructured({ system, schemaDescription, messages, temperature = 0.3, maxTokens = 4096, schema, usage }) {
    const fullSystem = `${system || ""}

You must respond with ONLY valid JSON matching this shape — no preamble, no markdown code fences, no explanation:
${schemaDescription}`.trim();

    const result = await this.generate({ system: fullSystem, messages, temperature, maxTokens, jsonMode: true, usage });

    if (result.truncated) {
      throw new Error("AI response was cut off before completing (hit the token limit). Try again, or this call may need a higher token budget.");
    }

    const cleaned = result.content.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`AI returned invalid JSON: ${cleaned.slice(0, 200)}`);
    }

    if (schema) {
      const validation = schema.safeParse(parsed);
      if (!validation.success) {
        const issues = validation.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new Error(`AI response didn't match the expected shape: ${issues}`);
      }
      return validation.data;
    }

    return parsed;
  }
}

module.exports = { GroqProvider };
