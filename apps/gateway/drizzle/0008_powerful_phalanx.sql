ALTER TABLE "protected_registry_entries" ADD COLUMN "protection_kind" text DEFAULT 'literal' NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD COLUMN "forms" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" DROP COLUMN "aliases";