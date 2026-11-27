-- =====================================================================
-- Run this ONCE in the Supabase SQL Editor (paste everything, click Run).
-- It adds: AI usage tracking, Paystack payments, and Pro plan expiry.
-- =====================================================================

-- 1. AI usage log: one row per AI call, with token counts (0004_melted_slyde.sql)
CREATE TABLE "ai_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"feature" text NOT NULL,
	"model" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");

-- 2. Payments + Pro plan expiry (0005_brown_blue_marvel.sql)
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reference" text NOT NULL,
	"amount_kobo" integer NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"paystack_id" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_reference_unique" UNIQUE("reference")
);

ALTER TABLE "users" ADD COLUMN "plan_expires_at" timestamp with time zone;
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id");

-- 3. Lock the new tables down like every other table. No policies means nothing
--    can reach them through Supabase's public REST API; your server connects as
--    a role that bypasses RLS, so the app is unaffected.
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- 4. A live "tokens per user" table. Find it in Supabase's Table Editor under
--    Views, or run:  SELECT * FROM ai_usage_by_user ORDER BY total_tokens DESC;
CREATE OR REPLACE VIEW public.ai_usage_by_user
WITH (security_invoker = true) AS
SELECT
  u.id   AS user_id,
  u.name,
  u.email,
  u.plan,
  u.plan_expires_at,
  count(a.id)                                   AS requests,
  coalesce(sum(a.total_tokens), 0)              AS total_tokens,
  coalesce(sum(a.total_tokens) FILTER (WHERE a.created_at > now() - interval '24 hours'), 0) AS tokens_last_24h,
  max(a.created_at)                             AS last_used
FROM public.users u
LEFT JOIN public.ai_usage a ON a.user_id = u.id
GROUP BY u.id, u.name, u.email, u.plan, u.plan_expires_at;

-- 5. The view contains emails: make sure Supabase's public API roles can't read it.
REVOKE ALL ON public.ai_usage_by_user FROM anon, authenticated;
