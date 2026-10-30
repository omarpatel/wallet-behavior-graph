CREATE TABLE `brain_picks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text NOT NULL,
	`mint` text NOT NULL,
	`symbol` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`features_json` text NOT NULL,
	`reason` text NOT NULL,
	`chips_json` text DEFAULT '[]' NOT NULL,
	`llm_model` text,
	`llm_text` text,
	`entry_mc_usd` real,
	`entry_price_usd` real NOT NULL,
	`suggested_fraction` real NOT NULL,
	`exit_plan_json` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_at` integer,
	`close_reason` text,
	`peak_price_usd` real,
	`last_price_usd` real,
	`last_price_at` integer,
	`tp_steps_hit` integer DEFAULT 0 NOT NULL,
	`initials_out_done` integer DEFAULT false NOT NULL,
	`remaining` real DEFAULT 1 NOT NULL,
	`realized` real DEFAULT 0 NOT NULL,
	`max_gain_pct` real,
	`last_gain_pct` real,
	`outcome_pct` real,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_picks_brain` ON `brain_picks` (`brain_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `brain_picks_brain_mint` ON `brain_picks` (`brain_id`,`mint`);--> statement-breakpoint
CREATE INDEX `brain_picks_status` ON `brain_picks` (`status`);--> statement-breakpoint
CREATE INDEX `brain_picks_created` ON `brain_picks` (`created_at`);