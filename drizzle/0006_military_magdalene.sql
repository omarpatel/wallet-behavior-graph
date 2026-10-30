CREATE TABLE `agent_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`mint` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`features_json` text NOT NULL,
	`llm_model` text,
	`llm_text` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_decisions_agent` ON `agent_decisions` (`agent_id`,`id`);--> statement-breakpoint
CREATE TABLE `agent_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_lamports` integer NOT NULL,
	`signature` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_ledger_agent` ON `agent_ledger` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_ledger_sig` ON `agent_ledger` (`signature`);--> statement-breakpoint
CREATE TABLE `agent_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`decision_id` integer,
	`side` text NOT NULL,
	`mint` text NOT NULL,
	`in_amount` text NOT NULL,
	`out_amount` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`paper` integer NOT NULL,
	`signature` text,
	`price_usd` real,
	`mc_usd` real,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`filled_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_orders_agent` ON `agent_orders` (`agent_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_orders_status` ON `agent_orders` (`status`);--> statement-breakpoint
CREATE TABLE `agent_positions` (
	`agent_id` text NOT NULL,
	`mint` text NOT NULL,
	`qty_raw` text NOT NULL,
	`decimals` integer NOT NULL,
	`cost_lamports` integer NOT NULL,
	`realized_lamports` integer DEFAULT 0 NOT NULL,
	`peak_qty_raw` text NOT NULL,
	`exit_plan_json` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`last_trade_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_positions_pk` ON `agent_positions` (`agent_id`,`mint`,`opened_at`);--> statement-breakpoint
CREATE INDEX `agent_positions_open` ON `agent_positions` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`brain_id` text NOT NULL,
	`name` text NOT NULL,
	`wallet_pubkey` text NOT NULL,
	`enc_secret` text NOT NULL,
	`mode` text DEFAULT 'paper' NOT NULL,
	`status` text DEFAULT 'paused' NOT NULL,
	`halted_reason` text,
	`strategy_json` text NOT NULL,
	`strategy_profile_version` integer NOT NULL,
	`use_llm` integer DEFAULT true NOT NULL,
	`paper_start_lamports` integer DEFAULT 5000000000 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_wallet_pubkey_unique` ON `agents` (`wallet_pubkey`);--> statement-breakpoint
CREATE INDEX `agents_owner` ON `agents` (`owner`);--> statement-breakpoint
CREATE INDEX `agents_status` ON `agents` (`status`);