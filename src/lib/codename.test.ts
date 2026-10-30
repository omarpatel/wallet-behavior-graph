import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { codenameCandidate, codenameFor, pickCodename, resolveCodenameCollisions } from "./codename";

// Two random wallets whose preferred codenames collide ("Cobalt Hornet"); KEEPER sorts first.
const KEEPER = "3PFTMkS95wUcqwiREdC2g1fy2VATsRrVSwLYe6ia6Fge";
const RENAMED = "4X4pncjWrLmCZ4vrorfDuNsewHSd6gF9dgPEsCxwzz2Q";
const SPACE = 46 * 45;

const wallet = (i: number) => createHash("sha256").update(`wallet-${i}`).digest("hex");

/** Brains as created before codenames were unique: every one carries its preferred codename. */
const legacyRows = (n: number) => Array.from({ length: n }, (_, i) => ({ wallet: wallet(i), codename: codenameFor(wallet(i)) }));

describe("codenames", () => {
  it("keeps the original derivation for the preferred codename", () => {
    expect(codenameFor(KEEPER)).toBe("Cobalt Hornet");
    expect(codenameFor(RENAMED)).toBe("Cobalt Hornet");
    expect(codenameCandidate(RENAMED, 0)).toBe("Cobalt Hornet");
  });

  it("walks every adjective×animal pair once before adding a suffix", () => {
    const walk = Array.from({ length: SPACE }, (_, k) => codenameCandidate(RENAMED, k));
    expect(new Set(walk).size).toBe(SPACE);
    expect(walk.every((n) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(n))).toBe(true);
    expect(codenameCandidate(RENAMED, SPACE)).toBe(`${walk[0]} 2`);
  });

  it("picks the first free name on the wallet's walk", () => {
    expect(pickCodename(RENAMED, new Set())).toBe("Cobalt Hornet");
    expect(pickCodename(RENAMED, new Set(["Cobalt Hornet"]))).toBe(codenameCandidate(RENAMED, 1));
  });

  it("lets the lowest-sorted wallet keep a shared codename", () => {
    const renames = resolveCodenameCollisions([
      { wallet: RENAMED, codename: "Cobalt Hornet" },
      { wallet: KEEPER, codename: "Cobalt Hornet" },
    ]);
    expect([...renames.keys()]).toEqual([RENAMED]);
    expect(renames.get(RENAMED)).toBe(codenameCandidate(RENAMED, 1));
  });

  it("makes every codename unique, deterministically and idempotently, renaming only colliding brains", () => {
    const rows = legacyRows(1500);
    const renames = resolveCodenameCollisions(rows);
    const fixed = rows.map((r) => ({ wallet: r.wallet, codename: renames.get(r.wallet) ?? r.codename }));
    expect(new Set(fixed.map((r) => r.codename)).size).toBe(rows.length);

    const shared = new Set(rows.filter((r, i) => rows.findIndex((o) => o.codename === r.codename) !== i).map((r) => r.codename));
    for (const r of rows) {
      if (!shared.has(r.codename)) expect(renames.has(r.wallet)).toBe(false);
    }
    expect(resolveCodenameCollisions([...rows].reverse())).toEqual(renames);
    expect(resolveCodenameCollisions(fixed).size).toBe(0);
  });

  it("stays unique beyond the adjective×animal space", () => {
    const rows = legacyRows(SPACE + 500);
    const renames = resolveCodenameCollisions(rows);
    const names = rows.map((r) => renames.get(r.wallet) ?? r.codename);
    expect(new Set(names).size).toBe(rows.length);
    expect(names.some((n) => / 2$/.test(n))).toBe(true);
  });
});
