ALTER TABLE "chunks" ADD COLUMN "stt_provider" text;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "resume_after" timestamp with time zone;