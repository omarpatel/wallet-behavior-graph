CREATE TABLE `neurons` (
	`brain_id` text PRIMARY KEY NOT NULL,
	`region` integer NOT NULL,
	`pagerank` real NOT NULL,
	`in_weight` real NOT NULL,
	`out_weight` real NOT NULL,
	`lead_share` real,
	`partners` integer NOT NULL,
	`entries` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`brain_id`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `synapses` (
	`pre` text NOT NULL,
	`post` text NOT NULL,
	`weight` real NOT NULL,
	`events` integer NOT NULL,
	`median_lag_sec` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	`sample_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`pre`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post`) REFERENCES `brains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `synapses_pair` ON `synapses` (`pre`,`post`);--> statement-breakpoint
CREATE INDEX `synapses_post` ON `synapses` (`post`);