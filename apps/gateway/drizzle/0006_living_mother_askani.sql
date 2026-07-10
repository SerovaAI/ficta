CREATE TABLE "thread_protected_values" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "thread_protected_values_scope_idx" ON "thread_protected_values" USING btree ("user_id","org_id","thread_id");