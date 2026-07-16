CREATE TABLE "records_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"thread_id" text,
	"owner_user_id" text,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"reference" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "records_audit_events_org_time_idx" ON "records_audit_events" USING btree ("org_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "records_audit_events_thread_idx" ON "records_audit_events" USING btree ("org_id","thread_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "threads_retention_idx" ON "threads" USING btree ("org_id","purge_after");