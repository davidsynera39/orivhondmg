const express = require("express");
const crypto = require("crypto");
const { eq, and, ne, sql } = require("drizzle-orm");
const { db, schema } = require("../db");
const { requireAuth, invalidateUserCache } = require("../lib/auth");
const { logActivity } = require("../lib/activity");
const paystack = require("../lib/paystack");

const router = express.Router();
const auth = requireAuth(db, schema, eq);

// Plans and prices live here (and in the pricing UI) — never taken from the browser.
// Prices are in kobo (₦1 = 100 kobo).
const PLANS = {
  pro: { label: "Orivon Pro", priceKobo: 500000, days: 30 },
  pro_day: { label: "Orivon Pro — 1-day pass", priceKobo: 50000, days: 1 },
};

function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

// Confirms a payment with Paystack and, if it's genuinely paid, gives the user
// 30 days of Pro. Safe to call any number of times for the same reference (the
// browser redirect AND the webhook both call it): only the first call that
// sees the payment as paid grants anything.
async function settlePayment(reference) {
  const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.reference, reference)).limit(1);
  if (!payment) return { status: "unknown" };
  if (payment.status === "success") return { status: "success", granted: false };

  const plan = Object.prototype.hasOwnProperty.call(PLANS, payment.planKey) ? PLANS[payment.planKey] : null;
  if (!plan) {
    console.error(`[payments] Payment ${reference} is for unknown plan "${payment.planKey}" — not granting anything.`);
    await db.update(schema.payments).set({ status: "mismatch" }).where(and(eq(schema.payments.id, payment.id), ne(schema.payments.status, "success")));
    return { status: "failed" };
  }

  // Never trust the browser or the webhook body for "was it paid" — ask Paystack.
  const tx = await paystack.verifyTransaction(reference);

  if (tx.status !== "success") {
    if (tx.status === "failed") {
      await db.update(schema.payments).set({ status: "failed" }).where(and(eq(schema.payments.id, payment.id), ne(schema.payments.status, "success")));
      return { status: "failed" };
    }
    return { status: "pending" }; // e.g. abandoned, or a transfer still processing
  }

  if (tx.amount !== payment.amountKobo || tx.currency !== payment.currency) {
    console.error(`[payments] Amount mismatch for ${reference}: expected ${payment.amountKobo} ${payment.currency}, Paystack says ${tx.amount} ${tx.currency}`);
    await db.update(schema.payments).set({ status: "mismatch" }).where(and(eq(schema.payments.id, payment.id), ne(schema.payments.status, "success")));
    return { status: "failed" };
  }

  // Claim the payment atomically so a simultaneous redirect + webhook can't both grant.
  const claimed = await db
    .update(schema.payments)
    .set({ status: "success", paystackId: String(tx.id), paidAt: tx.paid_at ? new Date(tx.paid_at) : new Date() })
    .where(and(eq(schema.payments.id, payment.id), ne(schema.payments.status, "success")))
    .returning();
  if (claimed.length === 0) return { status: "success", granted: false };

  // Extend from the current expiry if still active, otherwise from now.
  const [user] = await db
    .update(schema.users)
    .set({ plan: "pro", planExpiresAt: sql`greatest(coalesce(${schema.users.planExpiresAt}, now()), now()) + make_interval(days => ${plan.days}::int)` })
    .where(eq(schema.users.id, payment.userId))
    .returning();

  await db
    .update(schema.subscriptions)
    .set({ plan: "pro", status: "active", renewsAt: new Date(user.planExpiresAt).toISOString() })
    .where(eq(schema.subscriptions.userId, payment.userId));

  invalidateUserCache(payment.userId);
  await logActivity(db, schema, payment.userId, "subscription_paid", `Paid ₦${(payment.amountKobo / 100).toLocaleString("en-NG")} — Pro active until ${new Date(user.planExpiresAt).toDateString()}.`);
  return { status: "success", granted: true };
}

// The plans anyone can buy, with their prices.
router.get("/plans", auth, (req, res) => {
  const plans = Object.entries(PLANS).map(([key, p]) => ({ key, label: p.label, priceNgn: p.priceKobo / 100, days: p.days }));
  res.json({ plans });
});

// Starts a payment: records it, asks Paystack for a checkout link, returns it.
router.post("/initialize", auth, async (req, res) => {
  if (!paystack.isConfigured()) {
    return res.status(503).json({ error: "Payments aren't available yet. Please try again later." });
  }

  const planKey = typeof req.body?.plan === "string" ? req.body.plan : "pro";
  if (!Object.prototype.hasOwnProperty.call(PLANS, planKey)) return res.status(400).json({ error: "Unknown plan." });
  const plan = PLANS[planKey];

  const reference = "orv_" + crypto.randomBytes(12).toString("hex");
  await db.insert(schema.payments).values({ userId: req.user.id, reference, amountKobo: plan.priceKobo, currency: "NGN", planKey });

  try {
    const tx = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo: plan.priceKobo,
      reference,
      callbackUrl: `${appUrl(req)}/api/payments/callback`,
      metadata: { userId: req.user.id, plan: planKey },
    });
    res.json({ authorizationUrl: tx.authorization_url, reference });
  } catch (e) {
    console.error("[payments] Could not initialize Paystack transaction:", e.message);
    res.status(502).json({ error: "We couldn't start the payment. Please try again in a moment." });
  }
});

// Paystack sends the customer back here after checkout (?reference=...).
router.get("/callback", async (req, res) => {
  const reference = String(req.query.reference || req.query.trxref || "");
  let status = "failed";
  if (reference) {
    try {
      const result = await settlePayment(reference);
      status = result.status === "success" ? "success" : result.status === "pending" ? "pending" : "failed";
    } catch (e) {
      console.error("[payments] Callback verification failed:", e.message);
      status = "pending"; // couldn't reach Paystack — the webhook will still settle it
    }
  }
  res.redirect(`/#/payment-result?status=${status}`);
});

// Paystack's server-to-server notification. This is what makes sure the user
// gets Pro even if they close the tab before being redirected back.
router.post("/webhook", async (req, res) => {
  if (!paystack.verifyWebhookSignature(req.rawBody, req.get("x-paystack-signature"))) {
    return res.status(401).json({ error: "Invalid signature." });
  }
  const reference = req.body?.data?.reference;
  if (req.body?.event === "charge.success" && reference) {
    await settlePayment(reference); // throws -> 500 -> Paystack retries later
  }
  res.sendStatus(200);
});

module.exports = router;
