ALTER TABLE "protection_stats_daily" ADD COLUMN "ambiguous_entity_links" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "protection_stats_daily" ADD COLUMN "ambiguous_entity_link_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_egress_events" ADD COLUMN "ambiguous_entity_links" integer DEFAULT 0 NOT NULL;