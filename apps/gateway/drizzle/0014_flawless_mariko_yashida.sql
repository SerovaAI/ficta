ALTER TABLE "messages" DROP CONSTRAINT "messages_pkey";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_id_pk" PRIMARY KEY("thread_id","id");--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;