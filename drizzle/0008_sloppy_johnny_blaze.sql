CREATE TABLE "app_releases" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"platform" text DEFAULT 'android' NOT NULL,
	"version" text NOT NULL,
	"file_url" text NOT NULL,
	"size_bytes" integer,
	"release_notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
