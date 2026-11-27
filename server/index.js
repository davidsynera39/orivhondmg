require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Render (like most hosts) sits behind a proxy; this makes req.protocol / req.ip
// reflect the real client connection instead of the proxy.
app.set("trust proxy", 1);

// Paystack signs the exact bytes it sends, so keep the raw body for the webhook route.
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith("/api/payments/webhook")) req.rawBody = buf;
  },
}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/onboarding", require("./routes/onboarding"));
app.use("/api/career", require("./routes/career"));
app.use("/api/roadmap", require("./routes/roadmap"));
app.use("/api/interview", require("./routes/interview"));
app.use("/api/scholarships", require("./routes/scholarships"));
app.use("/api/research", require("./routes/research"));
app.use("/api/chat", require("./routes/chat"));
app.use("/api/cv", require("./routes/cv"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/downloads", require("./routes/downloads"));
app.use("/api", require("./routes/misc")); // /api/goals, /api/activity

// Any other GET request falls through to index.html — the frontend router
// (hash-based) handles the actual page from there.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Central error handler — keeps stack traces out of API responses.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Rate-limit errors are expected and safe to show to the user as-is.
  if (err.status === 429 && err.publicMessage) {
    if (err.retryAfterSeconds) res.set("Retry-After", String(err.retryAfterSeconds));
    return res.status(429).json({ error: err.publicMessage, rateLimited: true });
  }

  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log(`Orivon server running at http://localhost:${PORT}`);
});
