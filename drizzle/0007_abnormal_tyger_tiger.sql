CREATE TABLE "cv_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"cv_id" text NOT NULL,
	"content" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cv_reviews" ADD COLUMN "version_id" text;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD CONSTRAINT "cv_versions_cv_id_cvs_id_fk" FOREIGN KEY ("cv_id") REFERENCES "public"."cvs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cv_versions_cv_idx" ON "cv_versions" USING btree ("cv_id","created_at");