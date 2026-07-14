ALTER TABLE "protected_registry_entries" ADD COLUMN "protection_kind" text DEFAULT 'literal' NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD COLUMN "forms" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "protected_registry_entries"
SET "forms" = (
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('value', alias, 'kind', 'alias', 'boundary', 'substring')),
    '[]'::jsonb
  )
  FROM jsonb_array_elements_text("protected_registry_entries"."aliases") AS alias
)
WHERE jsonb_array_length("aliases") > 0;--> statement-breakpoint
ALTER TABLE "protected_registry_entries" DROP COLUMN "aliases";--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD CONSTRAINT "protected_registry_entries_protection_kind_check" CHECK ("protected_registry_entries"."protection_kind" in ('literal', 'entity'));--> statement-breakpoint
ALTER TABLE "protected_registry_entries" ADD CONSTRAINT "protected_registry_entries_entity_type_check" CHECK ("protected_registry_entries"."entity_type" is null or "protected_registry_entries"."entity_type" in ('organization', 'person'));
