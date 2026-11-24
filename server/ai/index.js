const { GroqProvider } = require("./providers/groq");
const { MockProvider } = require("./providers/mock");

let cached = null;

function getAIProvider() {
  if (cached) return cached;
  const hasKey = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "your-groq-api-key-here");
  cached = hasKey ? new GroqProvider() : new MockProvider();
  return cached;
}

module.exports = { getAIProvider };
