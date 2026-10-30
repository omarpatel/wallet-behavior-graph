import { migrate } from "drizzle-orm/libsql/migrator";
import { getDb, getDbClient } from "@/db/client";
import { dedupeCodenames } from "@/db/codenames";

await getDbClient().execute("PRAGMA journal_mode = WAL");
// before migrating: 0012 adds a unique index on brains.codename
const renamed = await dedupeCodenames(getDbClient());
if (renamed) console.log(`renamed ${renamed} brain(s) with a shared codename`);
await migrate(getDb(), { migrationsFolder: "./drizzle" });
console.log("migrations applied");
