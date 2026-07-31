CREATE TYPE "public"."chunk_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transcription_status" AS ENUM('queued', 'processing', 'transcribed', 'editing', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcription_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"start_sec" numeric(12, 3) NOT NULL,
	"end_sec" numeric(12, 3) NOT NULL,
	"has_overlap" boolean DEFAULT false NOT NULL,
	"status" "chunk_status" DEFAULT 'pending' NOT NULL,
	"raw_text" text,
	"clean_text" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"ip" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"audio_seconds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_ip_window_start_pk" PRIMARY KEY("ip","window_start")
);
--> statement-breakpoint
CREATE TABLE "transcriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"filename" text NOT NULL,
	"source_ext" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_sec" integer,
	"status" "transcription_status" DEFAULT 'queued' NOT NULL,
	"stt_provider" text NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"raw_text" text,
	"clean_text" text,
	"summary_text" text,
	"word_count" integer,
	"cost_usd" numeric(10, 5) DEFAULT '0' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worker_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_transcription_id_idx_idx" ON "chunks" USING btree ("transcription_id","idx");--> statement-breakpoint
CREATE INDEX "transcriptions_status_created_at_idx" ON "transcriptions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "transcriptions_session_created_at_idx" ON "transcriptions" USING btree ("session_id","created_at");