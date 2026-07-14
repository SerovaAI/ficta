ALTER TABLE "protected_registry_entries" ADD COLUMN "protection_kind" text DEFAULT 'literal' NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD COLUMN "forms" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" DROP COLUMN "aliases";--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD CONSTRAINT "protected_registry_entries_protection_kind_check" CHECK ("protected_registry_entries"."protection_kind" in ('literal', 'entity'));--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD CONSTRAINT "protected_registry_entries_entity_type_check" CHECK ("protected_registry_entries"."entity_type" is null or "protected_registry_entries"."entity_type" in ('organization', 'person'));
