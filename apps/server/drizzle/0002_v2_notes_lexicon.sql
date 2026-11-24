-- v2 (docs/api-v1.md, "v2"): notes, the shared lexicon cache (no user columns),
-- items.stars and the record-page indexes. Additive only: old clients keep working.
-- entries_input_trgm_idx uses pg_trgm, which migration 0001 created.
CREATE TABLE "lexicon" (
	"lang" text NOT NULL,
	"explain_lang" text NOT NULL,
	"lemma" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"model" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lexicon_lang_explain_lang_lemma_version_pk" PRIMARY KEY("lang","explain_lang","lemma","version")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"translation" text,
	"lang" text NOT NULL,
	"stars" smallint NOT NULL,
	"lemma" text,
	"entry_id" text,
	"item_id" text,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notes_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "stars" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_user_seq_idx" ON "notes" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "notes_user_kind_idx" ON "notes" USING btree ("user_id","kind","id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notes_user_item_idx" ON "notes" USING btree ("user_id","item_id");--> statement-breakpoint
CREATE INDEX "entries_user_created_idx" ON "entries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "entries_input_trgm_idx" ON "entries" USING gin ("input" gin_trgm_ops);