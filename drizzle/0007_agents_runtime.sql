CREATE TABLE `agent_equity` (
	`agent_id` text NOT NULL,
	`t` integer NOT NULL,
	`equity_lamports` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_equity_pk` ON `agent_equity` (`agent_id`,`t`);--> statement-breakpoint
ALTER TABLE `agent_ledger` ADD `flagged` text;--> statement-breakpoint
ALTER TABLE `agent_ledger` ADD `counterparty` text;--> statement-breakpoint
ALTER TABLE `agent_orders` ADD `client_key` text;--> statement-breakpoint
ALTER TABLE `agent_orders` ADD `reason` text DEFAULT 'entry' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_orders` ADD `symbol` text;--> statement-breakpoint
ALTER TABLE `agent_orders` ADD `lamports` integer;--> statement-breakpoint
ALTER TABLE `agent_orders` ADD `fee_lamports` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_orders_client_key` ON `agent_orders` (`agent_id`,`client_key`);--> statement-breakpoint
ALTER TABLE `agent_positions` ADD `symbol` text;--> statement-breakpoint
ALTER TABLE `agent_positions` ADD `entry_price_usd` real;--> statement-breakpoint
ALTER TABLE `agent_positions` ADD `entry_mc_usd` real;--> statement-breakpoint
ALTER TABLE `agent_positions` ADD `peak_price_usd` real;--> statement-breakpoint
ALTER TABLE `agent_positions` ADD `last_price_usd` real;--> statement-breakpoint
ALTER TABLE `agent_positions` ADD `last_price_at` integer;--> statement-breakpoint
ALTER TABLE `agent_positions` ADD `tp_steps_hit` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_positions` ADD `initials_out_done` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `overrides_json` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `paper_cash_lamports` integer DEFAULT 5000000000 NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `day_key` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `day_start_equity_lamports` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `equity_lamports` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `chain_lamports` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `marked_at` integer;