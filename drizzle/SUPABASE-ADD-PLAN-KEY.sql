-- Run this ONCE in the Supabase SQL Editor, AFTER SUPABASE-RUN-ONCE.sql
-- (it is safe to run twice). It lets each payment remember which plan it was for.
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS plan_key text NOT NULL DEFAULT 'pro';
