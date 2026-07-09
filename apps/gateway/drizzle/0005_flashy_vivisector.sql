CREATE TABLE "protected_registry_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"matter_id" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "protected_registry_entries_scope_status_idx" ON "protected_registry_entries" USING btree ("org_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "protected_registry_entries_scope_matter_idx" ON "protected_registry_entries" USING btree ("org_id","matter_id","type");