CREATE TABLE `swarms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mint` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_join_at` integer NOT NULL,
	`members` integer NOT NULL,
	`members_json` text NOT NULL,
	`mc_at_start_usd` real,
	`publish_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `swarms_mint_start` ON `swarms` (`mint`,`started_at`);--> statement-breakpoint
CREATE INDEX `swarms_last_join` ON `swarms` (`last_join_at`);--> statement-breakpoint
ALTER TABLE `brains` ADD `public_avatar_url` text;--> statement-breakpoint
ALTER TABLE `brains` ADD `telegram` text;--> statement-breakpoint
ALTER TABLE `brains` ADD `followers` integer;--> statement-breakpoint
ALTER TABLE `brains` ADD `sources_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `brains` ADD `external_stats_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `brains` ADD `tracking` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `brains` ADD `last_reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `tokens` ADD `rug_score` integer;--> statement-breakpoint
ALTER TABLE `tokens` ADD `lp_locked_pct` real;--> statement-breakpoint
ALTER TABLE `tokens` ADD `rug_risks_json` text;--> statement-breakpoint
ALTER TABLE `tokens` ADD `rug_checked_at` integer;