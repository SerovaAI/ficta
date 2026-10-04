ALTER TABLE "thread_egress_events" ADD COLUMN "registry_fingerprint" text;--> statement-breakpoint
ALTER TABLE "thread_egress_events" ADD COLUMN "restore" jsonb;