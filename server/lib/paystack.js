// Minimal Paystack client (https://paystack.com/docs/api). Uses raw fetch, like
// the Groq and Resend integrations, so there's no extra dependency.
//
// Needs PAYSTACK_SECRET_KEY (sk_test_... while testing, sk_live_... once live).
// The secret key must only ever live in the server's environment variables.

const crypto = require("crypto");

const PAYSTACK_URL = "https://api.paystack.co";

function secretKey() {
  return process.env.PAYSTACK_SECRET_KEY;
}

function isConfigured() {
  return Boolean(secretKey());
}

async function paystackRequest(path, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(PAYSTACK_URL + path, {
      method,
      headers: { Authorization: `Bearer ${secretKey()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.status !== true) {
      throw new Error(`Paystack error (${res.status}): ${json?.message || "unknown error"}`);
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

// amountKobo: Paystack amounts are in the smallest unit (kobo). ₦5,000 = 500000.
function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  return paystackRequest("/transaction/initialize", {
    method: "POST",
    body: { email, amount: amountKobo, currency: "NGN", reference, callback_url: callbackUrl, metadata },
  });
}

function verifyTransaction(reference) {
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
}

// Paystack signs every webhook with HMAC-SHA512 of the raw request body, using
// your secret key, and sends it in the x-paystack-signature header.
function verifyWebhookSignature(rawBody, signature) {
  if (!isConfigured() || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha512", secretKey()).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, initializeTransaction, verifyTransaction, verifyWebhookSignature };
