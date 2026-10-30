/**
 * Retry for SQLITE_BUSY / SQLITE_LOCKED across processes. Site, worker and scripts share one SQLite file; each
 * connection already waits up to 5 s for a foreign write lock (src/db/client.ts), but the worker's long rebuilds can
 * hold it longer. Only wrap work that is safe to repeat: a single autocommit statement (a BUSY statement wrote
 * nothing) or an idempotent sequence (upserts / onConflictDoNothing whose results don't gate later steps).
 */
export interface BusyRetryOptions {
  /** Total tries including the first. */
  attempts?: number;
  /** Backoff before retry n (1-based) is baseMs · 2^(n-1) · U(0.5, 1.5). */
  baseMs?: number;
  /** Logged on each retry so lock contention shows up in the serve log. */
  label?: string;
}

const BUSY_CODE = /^SQLITE_(BUSY|LOCKED)/;

/** True for libsql BUSY/LOCKED errors, including drizzle's DrizzleQueryError wrapper (`cause` chain). */
export function isBusyError(err: unknown): boolean {
  let e = err;
  for (let depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const codes = ["code" in e ? e.code : undefined, "extendedCode" in e ? e.extendedCode : undefined];
    if (codes.some((c) => typeof c === "string" && BUSY_CODE.test(c))) return true;
    if (e instanceof Error && /SQLITE_(BUSY|LOCKED)|database (table )?is locked/.test(e.message)) return true;
    e = "cause" in e ? e.cause : undefined;
  }
  return false;
}

export async function withBusyRetry<T>(fn: () => Promise<T>, opts: BusyRetryOptions = {}): Promise<T> {
  const { attempts = 5, baseMs = 500, label } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isBusyError(err)) throw err;
      const wait = Math.round(baseMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
      if (label) console.warn(`[db] ${label}: database busy, retry ${attempt}/${attempts - 1} in ${wait} ms`);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, wait);
      await promise;
    }
  }
}
