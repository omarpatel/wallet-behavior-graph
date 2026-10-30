CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text NOT NULL,
	`trade_id` integer NOT NULL,
	`headline` text NOT NULL,
	`facts_json` text NOT NULL,
	`explanation` text,
	`explanation_model` text,
	`publish_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_trade_id_unique` ON `alerts` (`trade_id`);--> statement-breakpoint
CREATE INDEX `alerts_brain_publish` ON `alerts` (`brain_id`,`publish_at`);--> statement-breakpoint
CREATE TABLE `auth_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`input_json` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brains` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet` text NOT NULL,
	`codename` text NOT NULL,
	`display_name` text,
	`x_handle` text,
	`provenance` text DEFAULT 'unattributed' NOT NULL,
	`provenance_source` text,
	`status` text DEFAULT 'unclaimed' NOT NULL,
	`claimed_at` integer,
	`kol_payout_wallet` text,
	`x_user_id` text,
	`avatar_url` text,
	`bio` text,
	`seat_supply` integer DEFAULT 100 NOT NULL,
	`seat_price_lamports` integer DEFAULT 500000000 NOT NULL,
	`renewal_price_lamports` integer DEFAULT 150000000 NOT NULL,
	`term_days` integer DEFAULT 30 NOT NULL,
	`kol_share_bps` integer DEFAULT 3000 NOT NULL,
	`royalty_bps` integer DEFAULT 500 NOT NULL,
	`price_override` integer DEFAULT false NOT NULL,
	`collection_address` text,
	`tier` text DEFAULT 'unrated' NOT NULL,
	`track_score` real,
	`profile_json` text,
	`profile_version` integer DEFAULT 0 NOT NULL,
	`profile_updated_at` integer,
	`playbook_md` text,
	`playbook_profile_version` integer,
	`alert_delay_sec` integer DEFAULT 0 NOT NULL,
	`revenue_held` integer DEFAULT false NOT NULL,
	`revenue_held_reason` text,
	`backfill_status` text DEFAULT 'pending' NOT NULL,
	`backfill_error` text,
	`last_signature` text,
	`last_slot` integer,
	`listed` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brains_wallet_unique` ON `brains` (`wallet`);--> statement-breakpoint
CREATE INDEX `brains_tier_idx` ON `brains` (`tier`);--> statement-breakpoint
CREATE TABLE `chain_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`wallet` text NOT NULL,
	`brain_id` text,
	`asset` text,
	`listing_id` text,
	`seat_number` integer,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`tx_base64` text NOT NULL,
	`last_valid_block_height` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`signature` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `actions_brain_kind_status` ON `chain_actions` (`brain_id`,`kind`,`status`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text NOT NULL,
	`wallet` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_brain_wallet` ON `chat_messages` (`brain_id`,`wallet`,`id`);--> statement-breakpoint
CREATE TABLE `disputes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text,
	`contact` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kol_payouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text NOT NULL,
	`wallet` text NOT NULL,
	`amount_lamports` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`signature` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text NOT NULL,
	`kind` text NOT NULL,
	`asset` text,
	`payer` text NOT NULL,
	`amount_lamports` integer NOT NULL,
	`kol_lamports` integer DEFAULT 0 NOT NULL,
	`treasury_lamports` integer DEFAULT 0 NOT NULL,
	`kol_paid_inline` integer DEFAULT false NOT NULL,
	`signature` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ledger_brain` ON `ledger` (`brain_id`);--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`asset` text NOT NULL,
	`brain_id` text NOT NULL,
	`seller` text NOT NULL,
	`price_lamports` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`buyer` text,
	`list_signature` text,
	`sale_signature` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`asset`) REFERENCES `seats`(`asset`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `listings_brain_status` ON `listings` (`brain_id`,`status`);--> statement-breakpoint
CREATE INDEX `listings_asset` ON `listings` (`asset`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`code_verifier` text NOT NULL,
	`wallet` text NOT NULL,
	`brain_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seats` (
	`asset` text PRIMARY KEY NOT NULL,
	`brain_id` text NOT NULL,
	`number` integer NOT NULL,
	`owner` text NOT NULL,
	`owner_checked_at` integer,
	`expires_at` integer NOT NULL,
	`mint_signature` text,
	`minted_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seats_brain_number` ON `seats` (`brain_id`,`number`);--> statement-breakpoint
CREATE INDEX `seats_owner` ON `seats` (`owner`);--> statement-breakpoint
CREATE TABLE `shill_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text NOT NULL,
	`tweet_id` text NOT NULL,
	`mint` text NOT NULL,
	`strong` integer NOT NULL,
	`pre_position_usd` real,
	`lead_time_sec` integer,
	`entry_discount` real,
	`sold_frac_1h` real,
	`sold_frac_24h` real,
	`first_sell_after_sec` integer,
	`evidence_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shill_dedupe` ON `shill_events` (`brain_id`,`tweet_id`,`mint`);--> statement-breakpoint
CREATE TABLE `sol_usd_1m` (
	`minute_ts` integer PRIMARY KEY NOT NULL,
	`close` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `token_transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text NOT NULL,
	`signature` text NOT NULL,
	`block_time` integer NOT NULL,
	`mint` text NOT NULL,
	`amount` real NOT NULL,
	`direction` text NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_dedupe` ON `token_transfers` (`brain_id`,`signature`,`mint`,`direction`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`mint` text PRIMARY KEY NOT NULL,
	`symbol` text,
	`name` text,
	`icon` text,
	`decimals` integer,
	`total_supply` real,
	`launchpad` text,
	`created_at_ts` integer,
	`first_pool_created_at` integer,
	`dev` text,
	`liquidity_usd` real,
	`mcap_usd` real,
	`usd_price` real,
	`holder_count` integer,
	`organic_score` real,
	`top_holders_pct` real,
	`mint_authority_disabled` integer,
	`freeze_authority_disabled` integer,
	`source` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_id` text NOT NULL,
	`wallet` text NOT NULL,
	`signature` text NOT NULL,
	`slot` integer NOT NULL,
	`tx_index` integer DEFAULT 0 NOT NULL,
	`block_time` integer NOT NULL,
	`side` text NOT NULL,
	`mint` text NOT NULL,
	`token_amount` real NOT NULL,
	`quote_mint` text NOT NULL,
	`quote_amount` real NOT NULL,
	`sol_value` real,
	`usd_value` real,
	`fees_sol` real DEFAULT 0 NOT NULL,
	`price_usd` real,
	`sol_usd` real,
	`mc_usd` real,
	`venue` text,
	`launchpad` text,
	`token_created_at` integer,
	`entry_delay_sec` integer,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trades_dedupe` ON `trades` (`wallet`,`signature`,`mint`,`side`);--> statement-breakpoint
CREATE INDEX `trades_brain_time` ON `trades` (`brain_id`,`block_time`);--> statement-breakpoint
CREATE INDEX `trades_brain_mint` ON `trades` (`brain_id`,`mint`);--> statement-breakpoint
CREATE TABLE `tweets` (
	`id` text PRIMARY KEY NOT NULL,
	`brain_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`mentions_json` text DEFAULT '[]' NOT NULL,
	`stance` text,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tweets_brain_time` ON `tweets` (`brain_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `users` (
	`wallet` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer
);
