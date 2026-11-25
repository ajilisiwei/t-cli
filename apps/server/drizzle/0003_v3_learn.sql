-- v3 (docs/api-v1.md, "v3 (M12–M17)"): lookup events and materials.read_at.
-- Additive only: old clients keep working. materials.kind gains 'digest' and
-- 'extend' in the Drizzle schema only (the column has no CHECK constraint).
-- lookup_events.merged_at marks events the nightly job has merged into units.
CREATE TABLE "lookup_events" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"lemma_key" text NOT NULL,
	"explain_lang" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone,
	CONSTRAINT "lookup_events_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lookup_events" ADD CONSTRAINT "lookup_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lookup_events_user_created_idx" ON "lookup_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "lookup_events_unmerged_idx" ON "lookup_events" USING btree ("user_id") WHERE merged_at is null;