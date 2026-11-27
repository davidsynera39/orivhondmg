-- Run this ONCE in the Supabase SQL Editor (paste everything, click Run).
-- Safe to run twice. Adds the table the "Download the app" page reads from.

CREATE TABLE IF NOT EXISTS public.app_releases (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  platform text DEFAULT 'android' NOT NULL,
  version text NOT NULL,
  file_url text NOT NULL,
  size_bytes integer,
  release_notes text,
  is_active boolean DEFAULT true NOT NULL,
  download_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Lock the table down like every other table (no policies = nothing can reach it
-- through Supabase's public REST API; your app's server connection is unaffected).
-- You can still add and edit rows yourself in the Table Editor.
ALTER TABLE public.app_releases ENABLE ROW LEVEL SECURITY;
