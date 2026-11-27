class MockProvider {
  constructor() {
    this.name = "mock";
  }

  async generate({ messages }) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    return {
      content:
        `[No AI provider configured — this is a placeholder response.]\n\n` +
        `Add GROQ_API_KEY to your .env file to enable real AI guidance.\n\n` +
        `You said: "${(lastUser && lastUser.content.slice(0, 200)) || ""}"`,
    };
  }

  async generateStructured({ schemaDescription, mockFallback }) {
    if (mockFallback !== undefined) return mockFallback;
    return { __mock: true, note: "Add GROQ_API_KEY to .env for real output.", requestedShape: schemaDescription };
  }
}

module.exports = { MockProvider };
