CREATE TABLE `snapshots` (
	`key` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `swarms_started` ON `swarms` (`started_at`);--> statement-breakpoint
CREATE INDEX `trades_mint_time` ON `trades` (`mint`,`block_time`);