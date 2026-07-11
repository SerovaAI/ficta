CREATE TABLE "thread_egress_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"screening" text NOT NULL,
	"model" text NOT NULL,
	"redacted_values" integer NOT NULL,
	"surviving_values" integer NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previous_hash" text,
	"event_hash" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "thread_egress_events_scope_thread_idx" ON "thread_egress_events" USING btree ("user_id","org_id","thread_id","occurred_at" DESC NULLS LAST);