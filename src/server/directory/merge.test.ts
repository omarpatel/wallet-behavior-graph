import { describe, expect, it } from "vitest";
import { cleanHandle, cleanName, directoryScore, emptyStats, mergeDirectory, type SourceRow } from "./merge";
import { directoryRows, loadDirectoryRows, studyRecord } from "./snapshot";

const A = "Fuo8aFUYKva8xm4Bp5BnbywcU68ZB7FyvX1aRo7mkVij";
const B = "DjoPBMKHsG61zeHkbrhnQ4v3pk5SsHCReuq4L3ZeKthU";

const row = (over: Partial<SourceRow> & Pick<SourceRow, "source">): SourceRow => ({
  address: A,
  name: null,
  handle: null,
  url: null,
  avatarUrl: null,
  followers: null,
  telegram: null,
  rank: null,
  stats: null,
  tags: [],
  study: null,
  kol: false,
  fetchedAt: 1_000,
  ...over,
});

describe("mergeDirectory", () => {
  it("one record per wallet; drops invalid addresses and duplicate rows of one source", () => {
    const out = mergeDirectory(
      [
        row({ source: "directory", name: "First", kol: true }),
        row({ source: "directory", name: "Dup" }),
        row({ source: "study", address: B }),
        row({ source: "directory", address: "not-a-wallet" }),
        row({ source: "directory", address: "1111111111111111111111111111111" }), // 31 bytes
      ],
      2_000,
    );
    expect(out.map((w) => w.address).sort()).toEqual([A, B].sort());
    const a = out.find((w) => w.address === A)!;
    expect(a.name).toBe("First");
    expect(a.sources).toHaveLength(1);
  });

  it("identity precedence directory > study", () => {
    const rows = [row({ source: "study", name: "S", handle: "s" }), row({ source: "directory", name: "D", handle: "d" })];
    const [w] = mergeDirectory(rows, 0);
    expect([w.name, w.handle]).toEqual(["D", "d"]);
    expect(w.sources.map((s) => s.source)).toEqual(["directory", "study"]);
    expect(mergeDirectory(rows.slice(0, 1), 0)[0].name).toBe("S");
  });

  it("keeps the directory's own stats and the study record", () => {
    const stats = { ...emptyStats(), pnl7dUsd: 1_200, trades7d: 14 };
    const study = studyRecord({ hitRate: 0.5, earlyRunners: 2 });
    const [w] = mergeDirectory([row({ source: "directory", stats, kol: true }), row({ source: "study", study })], 0);
    expect(w.externalStats.listing?.pnl7dUsd).toBe(1_200);
    expect(w.externalStats.study?.earlyRunners).toBe(2);
    expect(w.externalStats.directory?.tags).toContain("kol");
  });

  it("brain eligibility and provenance", () => {
    expect(mergeDirectory([row({ source: "directory" }), row({ source: "study" })], 0)[0].kol).toBe(false);
    const d = mergeDirectory([row({ source: "directory", kol: true, url: "https://example.com/w/x" })], 0)[0];
    expect([d.kol, d.studyOnly, d.provenanceUrl]).toEqual([true, false, "https://example.com/w/x"]);
    const s = mergeDirectory([row({ source: "study", kol: true })], 0)[0];
    expect([s.kol, s.studyOnly, s.provenanceUrl]).toEqual([true, true, null]);
  });
});

describe("directoryScore", () => {
  it("gates high-frequency wallets below steady ones with the same PnL", () => {
    const steady = { ...emptyStats(), pnl30dUsd: 100_000, pnl7dUsd: 20_000, trades30d: 90, winRate30d: 0.55, avgHoldSecs: 3 * 3600 };
    const hft = { ...steady, trades30d: 30_000, avgHoldSecs: 20 };
    expect(directoryScore(steady, 0).value!).toBeGreaterThan(directoryScore(hft, 0).value!);
    expect(directoryScore(emptyStats(), 0).value).toBeNull();
  });
});

describe("cleaners", () => {
  it("cleans names and handles", () => {
    expect(cleanName("ִֶָ")).toBeNull();
    expect(cleanHandle('"https://x.com/trader_01"')).toBe("trader_01");
    expect(cleanHandle("pump:foo")).toBeNull();
  });
});

describe("directory sample", () => {
  it("maps entries to directory rows plus study rows", () => {
    const rows = directoryRows({
      generatedAt: 5,
      wallets: [
        { address: A, name: "Wallet A", handle: null, avatarUrl: null, url: null, telegram: null, followers: null, rank: 1, stats: { trades7d: 3 }, tags: ["sample"], kol: true, study: { hitRate: 0.4 } },
        { address: B, name: "Wallet B", handle: null, avatarUrl: null, url: null, telegram: null, followers: null, rank: 2, stats: null, tags: null, kol: false, study: null },
      ],
    });
    expect(rows.map((r) => [r.source, r.address])).toEqual([
      ["directory", A],
      ["study", A],
      ["directory", B],
    ]);
    expect(rows[0].stats?.trades7d).toBe(3);
    expect(rows[1].study?.hitRate).toBe(0.4);
  });

  it("the committed sample loads and every wallet is a valid, brain-eligible pubkey", () => {
    const merged = mergeDirectory(loadDirectoryRows(), 0);
    expect(merged.length).toBeGreaterThanOrEqual(12);
    expect(merged.every((w) => w.kol)).toBe(true);
  });
});
