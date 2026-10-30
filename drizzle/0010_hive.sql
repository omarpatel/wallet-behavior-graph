CREATE TABLE `hive_scores` (
	`brain_id` text NOT NULL,
	`t` integer NOT NULL,
	`agent_id` text NOT NULL,
	`score` real NOT NULL,
	`exploit` real NOT NULL,
	`bonus` real NOT NULL,
	`pnl_lamports` integer NOT NULL,
	`return_pct` real,
	`drawdown_pct` real NOT NULL,
	`hit_rate` real,
	`sample` integer NOT NULL,
	`eligible` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hive_scores_pk` ON `hive_scores` (`brain_id`,`t`);--> statement-breakpoint
CREATE INDEX `hive_scores_t` ON `hive_scores` (`t`);--> statement-breakpoint
CREATE TABLE `hive_switches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`from_brain_id` text,
	`to_brain_id` text NOT NULL,
	`from_score` real,
	`to_score` real NOT NULL,
	`reason` text NOT NULL,
	`scores_json` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agent_decisions` ADD `context_json` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `kind` text DEFAULT 'user' NOT NULL;