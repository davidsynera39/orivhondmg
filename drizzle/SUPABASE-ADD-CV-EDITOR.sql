-- Run this ONCE in the Supabase SQL Editor (paste everything, click Run).
-- Safe to run twice. Adds what the CV editor needs: saved versions of a CV,
-- and a note on which version each review looked at.

CREATE TABLE IF NOT EXISTS public.cv_versions (
  id text PRIMARY KEY NOT NULL,
  cv_id text NOT NULL,
  content text NOT NULL,
  label text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.cv_reviews ADD COLUMN IF NOT EXISTS version_id text;

DO $$ BEGIN
  ALTER TABLE public.cv_versions
    ADD CONSTRAINT cv_versions_cv_id_cvs_id_fk
    FOREIGN KEY (cv_id) REFERENCES public.cvs(id) ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS cv_versions_cv_idx ON public.cv_versions USING btree (cv_id, created_at);

-- Lock the new table down like every other table (no policies = nothing can reach
-- it through Supabase's public REST API; your server's connection is unaffected).
ALTER TABLE public.cv_versions ENABLE ROW LEVEL SECURITY;
