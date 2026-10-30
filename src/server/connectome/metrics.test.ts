import { describe, expect, it } from "vitest";
import {
  canonicalRegions,
  cascade,
  coEntries,
  idf,
  pageRank,
  regionNames,
  rotations,
  significantSynapses,
  strongestPath,
  type FirstBuy,
  type GraphSynapse,
} from "./metrics";

const opts = { windowSec: 3600, tauSec: 900, gapSlots: 2 };
// ~2.5 slots per second on Solana
const fb = (brainId: string, mint: string, t: number): FirstBuy => ({ brainId, mint, t, slot: Math.round(t * 2.5) });
// a lone buyer so N > n_m and idf > 0
const filler = fb("Z", "zz", 0);

describe("coEntries", () => {
  it("directs earlier → later and respects the window boundary inclusively", () => {
    const ev = coEntries([fb("A", "m1", 100), fb("B", "m1", 100 + 3600), fb("C", "m1", 100 + 3601), filler], opts);
    const pairs = ev.map((e) => `${e.pre}>${e.post}:${e.lagSec}`).sort();
    expect(pairs).toEqual(["A>B:3600", "B>C:1"]);
  });

  it("skips same-second and near-simultaneous (|Δslot| ≤ 2) entries", () => {
    const ev = coEntries(
      [
        { brainId: "A", mint: "m", t: 10, slot: 1000 },
        { brainId: "B", mint: "m", t: 10, slot: 1000 },
        { brainId: "C", mint: "m", t: 11, slot: 1002 },
        { brainId: "D", mint: "m", t: 20, slot: 1030 },
        filler,
      ],
      opts,
    );
    expect(ev.map((e) => `${e.pre}>${e.post}`).sort()).toEqual(["A>D", "B>D", "C>D"]);
  });

  it("decays contributions with lag", () => {
    const [near] = coEntries([fb("A", "m", 0), fb("B", "m", 60), filler], opts);
    const [far] = coEntries([fb("A", "m", 0), fb("B", "m", 1800), filler], opts);
    expect(near.contribution / far.contribution).toBeCloseTo(Math.exp((1800 - 60) / 900), 6);
  });
});

describe("idf", () => {
  it("down-weights popular tokens and zeroes a token every active brain bought", () => {
    expect(idf(2, 30)).toBeGreaterThan(idf(20, 30));
    expect(idf(30, 30)).toBe(0);
    const rare = coEntries([fb("A", "rare", 0), fb("B", "rare", 60), ...["C", "D", "E", "F"].map((b) => fb(b, "solo" + b, 0))], opts);
    const popular = coEntries(
      [fb("A", "pop", 0), fb("B", "pop", 60), ...["C", "D", "E", "F"].map((b, i) => fb(b, "pop", 5000 + i * 10))],
      opts,
    );
    const ab = (ev: typeof rare) => ev.find((e) => e.pre === "A" && e.post === "B")!.contribution;
    expect(ab(rare)).toBeGreaterThan(ab(popular));
  });
});

describe("significantSynapses", () => {
  it("keeps a consistent leader → follower edge and drops the reverse", () => {
    const buys: FirstBuy[] = [filler, fb("Y", "yy", 0)];
    for (let i = 0; i < 12; i++) buys.push(fb("A", `t${i}`, i * 10_000), fb("B", `t${i}`, i * 10_000 + 120));
    const { synapses } = significantSynapses(buys, { ...opts, seed: 7 });
    expect(synapses.map((s) => `${s.pre}>${s.post}`)).toEqual(["A>B"]);
    expect(synapses[0].events).toBe(12);
    expect(synapses[0].medianLagSec).toBe(120);
    expect(synapses[0].z).toBeGreaterThanOrEqual(3);
  });

  it("drops pairs with fewer than 3 shared tokens", () => {
    const buys: FirstBuy[] = [filler, fb("A", "t1", 0), fb("B", "t1", 60), fb("A", "t2", 9000), fb("B", "t2", 9060)];
    expect(significantSynapses(buys, opts).synapses).toEqual([]);
  });

  it("is deterministic for a seed", () => {
    const buys: FirstBuy[] = [filler];
    for (let i = 0; i < 8; i++) buys.push(fb("A", `t${i}`, i * 10_000), fb("B", `t${i}`, i * 10_000 + 60 + (i % 3) * 400), fb("C", `t${i}`, i * 10_000 + 30));
    expect(significantSynapses(buys, { ...opts, seed: 3 })).toEqual(significantSynapses(buys, { ...opts, seed: 3 }));
  });
});

describe("pageRank", () => {
  it("ranks the leader highest on the reversed (follower → leader) graph", () => {
    // L leads F1, F2; F1 leads F2 weakly.
    const synapses = [
      { pre: "L", post: "F1", weight: 5 },
      { pre: "L", post: "F2", weight: 5 },
      { pre: "F1", post: "F2", weight: 1 },
    ];
    const pr = pageRank(["F1", "F2", "L", "X"], synapses.map((s) => ({ from: s.post, to: s.pre, weight: s.weight })));
    expect(pr.get("L")).toBe(1);
    expect(pr.get("F1")!).toBeGreaterThan(pr.get("F2")!);
    expect(pr.get("F2")!).toBeGreaterThan(0);
  });
});

const g = (pre: string, post: string, weight: number, medianLagSec = 60): GraphSynapse => ({ pre, post, weight, medianLagSec });

describe("strongestPath", () => {
  it("maximises the product of input shares", () => {
    // Direct A→D is a small share of D's input; A→B→D carries most of it.
    const syn = [g("A", "D", 1), g("X", "D", 9), g("A", "B", 4), g("B", "D", 30)];
    const hops = strongestPath(syn, "A", "D")!;
    expect(hops.map((h) => `${h.pre}>${h.post}`)).toEqual(["A>B", "B>D"]);
    expect(strongestPath(syn, "D", "A")).toBeNull();
    expect(strongestPath(syn, "A", "A")).toEqual([]);
  });
});

describe("cascade", () => {
  it("activates by summed input share ≥ threshold, layer by layer, with cumulative lag", () => {
    const syn = [
      g("S", "A", 5, 30), // A: 5/6 from S → depth 1
      g("Q", "A", 1),
      g("S", "B", 1, 40), // B: 1/5 from S alone (below 0.3) …
      g("A", "B", 1, 50), // … + 1/5 from A once A is active → 0.4 at depth 2
      g("R", "B", 3),
      g("B", "C", 2, 100), // C: depth 3 via B
      g("C", "D", 1), // D: depth 4 — beyond depth 3
    ];
    const steps = cascade(syn, "S", 3);
    expect(steps.map((s) => [s.id, s.depth])).toEqual([["A", 1], ["B", 2], ["C", 3]]);
    const b = steps.find((s) => s.id === "B")!;
    expect(b.strength).toBeCloseTo(0.4);
    expect(["S", "A"]).toContain(b.via);
    expect(steps.find((s) => s.id === "C")!.cumulativeLagSec).toBe(b.cumulativeLagSec + 100);
    expect(steps.find((s) => s.id === "A")!.cumulativeLagSec).toBe(30);
  });
});

describe("regions", () => {
  it("canonicalises ids by size and gives isolated brains singleton regions", () => {
    const r = canonicalRegions(["a", "b", "c", "d", "e"], { a: 7, b: 3, c: 3, d: 7, e: 7 });
    expect([r.get("a"), r.get("d"), r.get("e"), r.get("b"), r.get("c")]).toEqual([0, 0, 0, 1, 1]);
    expect(canonicalRegions(["x", "a"], { a: 1 }).get("x")).toBe(1);
  });

  it("names regions after the hub with a trait suffix; singletons are Unwired", () => {
    const m = (region: number, label: string, pagerank: number, leadShare: number | null, medianEntryDelaySec: number | null) => ({
      region,
      label,
      pagerank,
      leadShare,
      medianEntryDelaySec,
    });
    const names = regionNames([
      m(0, "Basalt Manta", 1, 0.9, 20),
      m(0, "Wild Lynx", 0.5, 0.2, 40),
      m(0, "Amber Viper", 0.4, 0.1, 400),
      m(1, "Rusted Barracuda", 0.3, 0.7, 300),
      m(1, "Feral Bison", 0.6, 0.8, null),
      m(2, "Quartz Ocelot", 0.2, 0.5, 300),
      m(2, "Cobalt Osprey", 0.2, 0.2, 500),
      m(3, "Solo Heron", 0.1, null, null),
    ]);
    expect([...names.values()].map((v) => v.name)).toEqual([
      "Basalt Manta fast-entry cortex",
      "Feral Bison lead nucleus",
      "Cobalt Osprey cluster",
      "Unwired · Solo Heron",
    ]);
  });
});

describe("rotations", () => {
  it("links a sell to the next buy of another token within the window", () => {
    const t = (side: "buy" | "sell", mint: string, blockTime: number) => ({ side, mint, blockTime, order: blockTime });
    const r = rotations([
      t("sell", "A", 0),
      t("buy", "B", 100),
      t("sell", "A", 1000),
      t("buy", "B", 1100),
      t("sell", "B", 2000),
      t("buy", "B", 2010), // same token: no edge, consumes the sell
      t("buy", "C", 2020),
      t("sell", "C", 3000),
      t("buy", "D", 3181), // outside 180s
    ]);
    expect(r).toEqual([{ from: "A", to: "B", count: 2 }]);
  });
});
