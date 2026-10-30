import { describe, expect, it, vi } from "vitest";
import { isBusyError, withBusyRetry } from "./retry";

/** Shape of a drizzle DrizzleQueryError wrapping a LibsqlError, as seen in the serve log. */
function busyError(code = "SQLITE_BUSY") {
  const cause = Object.assign(new Error(`${code}: database is locked`), { code, extendedCode: code, rawCode: 5 });
  return Object.assign(new Error('Failed query: insert into "trades" ...'), { cause });
}

describe("isBusyError", () => {
  it("matches BUSY/LOCKED through the cause chain", () => {
    expect(isBusyError(busyError())).toBe(true);
    expect(isBusyError(busyError("SQLITE_LOCKED"))).toBe(true);
    expect(isBusyError(busyError("SQLITE_BUSY_SNAPSHOT"))).toBe(true);
    expect(isBusyError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
  });
  it("rejects other errors", () => {
    expect(isBusyError(new Error("UNIQUE constraint failed"))).toBe(false);
    expect(isBusyError(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError("busy")).toBe(false);
  });
});

describe("withBusyRetry", () => {
  it("retries on BUSY until it succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(busyError()).mockRejectedValueOnce(busyError()).mockResolvedValue("ok");
    await expect(withBusyRetry(fn, { attempts: 5, baseMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors", async () => {
    const err = Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT" });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withBusyRetry(fn, { attempts: 5, baseMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after `attempts` tries with the last BUSY error", async () => {
    const err = busyError();
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withBusyRetry(fn, { attempts: 3, baseMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("backs off exponentially with jitter", async () => {
    vi.useFakeTimers();
    try {
      const random = vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor 1.0
      const calls: number[] = [];
      const fn = vi.fn(async () => {
        calls.push(Date.now());
        if (calls.length < 4) throw busyError();
        return 1;
      });
      const p = withBusyRetry(fn, { attempts: 5, baseMs: 100 });
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBe(1);
      expect(calls.slice(1).map((t, i) => t - calls[i])).toEqual([100, 200, 400]);
      random.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
