ALTER TABLE `brains` ADD `backfill_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `brains` ADD `backfill_retry_at` integer;