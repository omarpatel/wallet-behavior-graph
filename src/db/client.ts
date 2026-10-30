import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type DB = LibSQLDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __wbgDb?: { client: Client; db: DB } };

/**
 * libsql's local client keeps a pool of up to `concurrency` connections, opened lazily and borrowed per statement
 * (statements run synchronously, so more than one is only out at once across an `await` gap or an open transaction).
 * PRAGMAs are per connection: a plain `client.execute("PRAGMA …")` reaches just one of them. open() therefore caps
 * the pool at POOL_SIZE and borrows every connection in the same tick (each executeMultiple below takes an idle or
 * new connection synchronously), so the whole pool gets them before any query runs. A connection the pool drops after
 * a failed rollback is reopened without them (rare; the settings are performance-only).
 */
const POOL_SIZE = 4;
const CONNECTION_PRAGMAS = [
  // 64 MiB page cache per connection (default 2 MiB) for a multi-GB database
  "PRAGMA cache_size = -65536",
  // memory-map the first 1 GiB: reads skip the read() syscall + copy into the page cache
  "PRAGMA mmap_size = 1073741824",
  // truncate the WAL back to 64 MiB after a checkpoint resets it (the worker also checkpoints every 5 min)
  "PRAGMA journal_size_limit = 67108864",
].join(";\n");

function open() {
  const { DATABASE_URL, DATABASE_AUTH_TOKEN } = env();
  const local = DATABASE_URL.startsWith("file:");
  if (local) {
    mkdirSync(dirname(DATABASE_URL.slice("file:".length)), { recursive: true });
  }
  // Site, worker and scripts are separate processes on one SQLite file: each pooled connection waits up to 5 s for
  // another process's write lock instead of failing with SQLITE_BUSY. (libsql runs statements synchronously, so the
  // wait blocks this process's event loop; keep write transactions short and single-shot.)
  const client = createClient({
    url: DATABASE_URL,
    authToken: DATABASE_AUTH_TOKEN,
    ...(local ? { timeout: 5_000, concurrency: POOL_SIZE } : {}),
  });
  if (local) {
    for (let i = 0; i < POOL_SIZE; i++) {
      client.executeMultiple(CONNECTION_PRAGMAS).catch((err) => console.warn(`[db] connection pragmas: ${err instanceof Error ? err.message : err}`));
    }
  }
  return { client, db: drizzle(client, { schema }) };
}

/** Singleton across Next dev hot reloads and the worker process. */
export function getDb(): DB {
  globalForDb.__wbgDb ??= open();
  return globalForDb.__wbgDb.db;
}

export function getDbClient(): Client {
  globalForDb.__wbgDb ??= open();
  return globalForDb.__wbgDb.client;
}

export { schema };
