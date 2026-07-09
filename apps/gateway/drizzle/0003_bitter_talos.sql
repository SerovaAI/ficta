CREATE TABLE "protection_stats_checkpoints" (
	"org_id" text NOT NULL,
	"proxy_url" text NOT NULL,
	"proxy_started_at" timestamp with time zone NOT NULL,
	"stats_path" text NOT NULL,
	"last_totals" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protection_stats_checkpoints_org_id_proxy_url_proxy_started_at_stats_path_pk" PRIMARY KEY("org_id","proxy_url","proxy_started_at","stats_path")
);
--> statement-breakpoint
CREATE TABLE "protection_stats_daily" (
	"org_id" text NOT NULL,
	"day" date NOT NULL,
	"events" integer DEFAULT 0 NOT NULL,
	"affected_requests" integer DEFAULT 0 NOT NULL,
	"redacted_values" integer DEFAULT 0 NOT NULL,
	"surviving_values" integer DEFAULT 0 NOT NULL,
	"blocked_requests" integer DEFAULT 0 NOT NULL,
	"kept_out_of_model_values" integer DEFAULT 0 NOT NULL,
	"restored_values" integer DEFAULT 0 NOT NULL,
	"withheld_from_tools_values" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protection_stats_daily_org_id_day_pk" PRIMARY KEY("org_id","day")
);
--> statement-breakpoint
CREATE INDEX "protection_stats_checkpoints_updated_idx" ON "protection_stats_checkpoints" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "protection_stats_daily_org_day_idx" ON "protection_stats_daily" USING btree ("org_id","day");