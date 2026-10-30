/**
 * BrainProfile → StrategySpec. Pure and deterministic: the same profile always yields the same rules, summary and
 * provenance. Every rule records the profile statistic it came from ("provenance") so the UI can show why the agent
 * trades the way it does. The agent trades IN THE STYLE of the brain; it never mirrors the brain's wallet.
 *
 * Stats come straight from the profile when present (entry MC buckets, entry delay p25/p75, pre-graduation share,
 * launchpad mix, sizing style, hold buckets, exit shares, trades/day). Archetype defaults fill nulls and bound
 * everything to ranges an agent can execute (a 13-second median hold is not reproducible through Jupiter).
 */
import type { ArchetypeId, BrainProfile, Buckets } from "@/server/profile/types";
import {
  AGENT_OVERRIDE_BOUNDS,
  AGENT_SCHEMA_VERSION,
  type AgentOverridePath,
  type EntryRules,
  type ExitPlan,
  type SizingRules,
  type StrategyOverrides,
  type StrategySpec,
} from "./types";

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Archetypes an agent can trade. Unrated profiles are too thin; deployers' edge is launching tokens, not trading. */
export type TradableArchetype = Exclude<ArchetypeId, "unrated" | "deployer">;

interface ArchetypeDefaults {
  label: string;
  phase: EntryRules["phase"];
  entryMcUsd: { min: number; max: number };
  entryDelaySec: { min: number; max: number };
  momentum: { lookbackSec: number; minChangePct: number };
  takeProfitPct: number;
  stopLossPct: number;
  timeStopSec: number;
  maxOpenPositions: number;
  maxTradesPerHour: number;
  baseFraction: number;
}

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

/** Fallbacks per archetype, used only where the profile has no number. */
export const ARCHETYPE_DEFAULTS: Record<TradableArchetype, ArchetypeDefaults> = {
  sniper: {
    label: "Sniper",
    phase: "curve",
    entryMcUsd: { min: 2_500, max: 12_000 },
    entryDelaySec: { min: 0, max: 30 },
    momentum: { lookbackSec: 0, minChangePct: 0 },
    takeProfitPct: 30,
    stopLossPct: -20,
    timeStopSec: 3 * MIN,
    maxOpenPositions: 5,
    maxTradesPerHour: 30,
    baseFraction: 0.04,
  },
  bot_flipper: {
    label: "Bot flipper",
    phase: "curve",
    entryMcUsd: { min: 3_000, max: 30_000 },
    entryDelaySec: { min: 5, max: 5 * MIN },
    momentum: { lookbackSec: 0, minChangePct: 0 },
    takeProfitPct: 25,
    stopLossPct: -20,
    timeStopSec: 3 * MIN,
    maxOpenPositions: 5,
    maxTradesPerHour: 30,
    baseFraction: 0.04,
  },
  early_ape: {
    label: "Early ape",
    phase: "curve",
    entryMcUsd: { min: 5_000, max: 40_000 },
    entryDelaySec: { min: 15, max: 15 * MIN },
    momentum: { lookbackSec: 0, minChangePct: 0 },
    takeProfitPct: 60,
    stopLossPct: -30,
    timeStopSec: 10 * MIN,
    maxOpenPositions: 4,
    maxTradesPerHour: 20,
    baseFraction: 0.06,
  },
  momentum_chaser: {
    label: "Momentum chaser",
    phase: "graduated",
    entryMcUsd: { min: 60_000, max: 2_000_000 },
    entryDelaySec: { min: HOUR, max: 10 * DAY },
    momentum: { lookbackSec: 5 * MIN, minChangePct: 8 },
    takeProfitPct: 50,
    stopLossPct: -25,
    timeStopSec: 6 * HOUR,
    maxOpenPositions: 3,
    maxTradesPerHour: 6,
    baseFraction: 0.1,
  },
  intraday: {
    label: "Intraday",
    phase: "any",
    entryMcUsd: { min: 10_000, max: 150_000 },
    entryDelaySec: { min: MIN, max: 2 * HOUR },
    momentum: { lookbackSec: 5 * MIN, minChangePct: 3 },
    takeProfitPct: 40,
    stopLossPct: -30,
    timeStopSec: HOUR,
    maxOpenPositions: 4,
    maxTradesPerHour: 12,
    baseFraction: 0.08,
  },
  swing: {
    label: "Swing",
    phase: "graduated",
    entryMcUsd: { min: 50_000, max: 5_000_000 },
    entryDelaySec: { min: 6 * HOUR, max: 14 * DAY },
    momentum: { lookbackSec: HOUR, minChangePct: 5 },
    takeProfitPct: 100,
    stopLossPct: -40,
    timeStopSec: 2 * DAY,
    maxOpenPositions: 3,
    maxTradesPerHour: 2,
    baseFraction: 0.12,
  },
  diamond_hands: {
    label: "Diamond hands",
    phase: "graduated",
    entryMcUsd: { min: 50_000, max: 10_000_000 },
    entryDelaySec: { min: HOUR, max: 30 * DAY },
    momentum: { lookbackSec: HOUR, minChangePct: 0 },
    takeProfitPct: 200,
    stopLossPct: -50,
    timeStopSec: 3 * DAY,
    maxOpenPositions: 3,
    maxTradesPerHour: 2,
    baseFraction: 0.12,
  },
};

/** Lower/upper USD edges of BrainProfile.entryMc.buckets (<$10k … ≥$100M). The open ends are bounded for interpolation. */
const MC_EDGES = [2_500, 10_000, 30_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000];
/** Edges of BrainProfile.hold.buckets (<1m, 1–5m, 5–60m, 1–24h, 1–7d, >7d); "still open" is excluded. */
const HOLD_EDGES = [5, MIN, 5 * MIN, HOUR, DAY, 7 * DAY, 30 * DAY];

/**
 * Quantile q of a bucketed distribution, log-interpolated inside the bucket (MC and durations are log-scaled).
 * Uses the first `edges.length − 1` buckets in order. Null when the buckets are empty.
 */
export function bucketQuantile(buckets: Buckets, edges: number[], q: number): number | null {
  const counts = buckets.slice(0, edges.length - 1).map((b) => Math.max(0, b.count));
  const total = counts.reduce((s, c) => s + c, 0);
  if (!total) return null;
  const target = q * total;
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (c > 0 && cum + c >= target) {
      const frac = Math.min(1, Math.max(0, (target - cum) / c));
      const lo = Math.log(edges[i]);
      const hi = Math.log(edges[i + 1]);
      return Math.exp(lo + (hi - lo) * frac);
    }
    cum += c;
  }
  return edges[edges.length - 1];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "$8.2k", "$1.4M". */
export function usd(v: number): string {
  if (v >= 1e9) return `$${trim(v / 1e9)}B`;
  if (v >= 1e6) return `$${trim(v / 1e6)}M`;
  if (v >= 1e3) return `$${trim(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}

/** "45s", "8m", "3.5h", "2d". */
export function dur(sec: number): string {
  if (sec < MIN) return `${Math.round(sec)}s`;
  if (sec < HOUR) return `${trim(sec / MIN)}m`;
  if (sec < DAY) return `${trim(sec / HOUR)}h`;
  return `${trim(sec / DAY)}d`;
}

export function sol(lamports: number): string {
  const v = lamports / LAMPORTS_PER_SOL;
  return `${trim(v, Math.abs(v) < 0.01 ? 6 : 3)} SOL`;
}

function trim(v: number, maxDecimals = 1): string {
  const d = v >= 100 ? 0 : maxDecimals;
  return Number(v.toFixed(d)).toString();
}

/** Round to 2 significant figures so rules read cleanly ($8,734 → $8,700). */
function sig2(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / p) * p;
}

export type DeriveResult = { ok: true; strategy: StrategySpec } | { ok: false; reason: string };

export interface DeriveOptions {
  brainId: string;
  /** brains.playbook_md: not parsed into rules (it is prose); the LLM judge reads it. Recorded in provenance. */
  playbook?: string | null;
  /** Paper start / expected capital, used to scale the default daily loss limit. */
  capitalLamports?: number;
}

/** Why a brain can't have an agent, or null when it can. */
export function untradableReason(profile: BrainProfile | null): string | null {
  if (!profile) return "This brain has no profile yet (backfill pending).";
  if (!profile.rated || profile.archetype.id === "unrated")
    return `Profile too thin to derive a style (${profile.sample.trades} trades, ${profile.sample.tokens} tokens; needs ≥ 20 trades and ≥ 5 tokens).`;
  if (profile.archetype.id === "deployer") return "Deployer style: this wallet's edge is launching tokens, which an agent can't reproduce by trading.";
  return null;
}

export function deriveStrategy(profile: BrainProfile | null, opts: DeriveOptions): DeriveResult {
  const why = untradableReason(profile);
  if (why || !profile) return { ok: false, reason: why ?? "No profile." };
  const arch = profile.archetype.id as TradableArchetype;
  const d = ARCHETYPE_DEFAULTS[arch];
  const prov: Record<string, string> = {};
  prov.archetype = `${profile.archetype.label} ← ${profile.archetype.reason}`;

  // ---------------------------------------------------------------- entry
  const preGrad = profile.timing.preGraduationShare;
  let phase: EntryRules["phase"] = d.phase;
  if (preGrad != null) {
    phase = preGrad >= 0.6 ? "curve" : preGrad <= 0.2 ? "graduated" : "any";
    prov["entry.phase"] = `${phase} ← ${pct(preGrad)} of pump.fun entries were on the bonding curve`;
  } else prov["entry.phase"] = `${phase} ← ${d.label} default (no pump.fun entries to measure)`;

  const pads = profile.coinMix.launchpads.filter((b) => b.label !== "unknown");
  const padTotal = pads.reduce((s, b) => s + b.count, 0);
  const pumpShare = padTotal ? (pads.find((b) => b.label === "pump.fun")?.count ?? 0) / padTotal : null;
  // Curve entries only exist on launchpads; pump.fun is the one with an on-chain curve feed.
  const launchpads = phase === "curve" || (pumpShare != null && pumpShare >= 0.6) ? ["pump.fun"] : [];
  prov["entry.launchpads"] =
    pumpShare != null
      ? `${launchpads.length ? "pump.fun only" : "any launchpad"} ← ${pct(pumpShare)} of tokens were pump.fun launches`
      : `${launchpads.length ? "pump.fun only" : "any launchpad"} ← no launchpad mix measured`;

  const mcP25 = bucketQuantile(profile.entryMc.buckets, MC_EDGES, 0.25);
  const mcP75 = bucketQuantile(profile.entryMc.buckets, MC_EDGES, 0.75);
  let entryMcUsd = { ...d.entryMcUsd };
  if (mcP25 != null && mcP75 != null) {
    entryMcUsd = { min: sig2(mcP25), max: sig2(Math.max(mcP75, mcP25 * 2)) };
    const med = profile.entryMc.medianUsd;
    prov["entry.entryMcUsd"] = `${usd(entryMcUsd.min)}–${usd(entryMcUsd.max)} ← entry MC buckets p25–p75${med != null ? ` (median ${usd(med)})` : ""}`;
  } else prov["entry.entryMcUsd"] = `${usd(entryMcUsd.min)}–${usd(entryMcUsd.max)} ← ${d.label} default (no entry MC measured)`;

  const p25 = profile.timing.p25EntryDelaySec;
  const p75 = profile.timing.p75EntryDelaySec;
  let entryDelaySec = { ...d.entryDelaySec };
  if (p25 != null && p75 != null) {
    // Our feeds see a token ~1 s after creation at best; anything earlier is the same-block race we can't win.
    const lo = clamp(Math.round(p25), 2, 30 * DAY);
    entryDelaySec = { min: lo, max: clamp(Math.round(Math.max(p75, lo + 30)), lo + 30, 30 * DAY) };
    prov["entry.entryDelaySec"] = `${dur(entryDelaySec.min)}–${dur(entryDelaySec.max)} after launch ← entry delay p25–p75${
      profile.timing.medianEntryDelaySec != null ? ` (median ${dur(profile.timing.medianEntryDelaySec)})` : ""
    }`;
  } else prov["entry.entryDelaySec"] = `${dur(entryDelaySec.min)}–${dur(entryDelaySec.max)} ← ${d.label} default (no entry delay measured)`;

  const momentum = { ...d.momentum };
  prov["entry.momentum"] = momentum.minChangePct
    ? `price up ≥ ${momentum.minChangePct}% over ${dur(momentum.lookbackSec)} ← the ${d.label} style buys strength, not dips`
    : `off ← the ${d.label} style enters on launch flow, not on a measured move`;

  const curveish = phase !== "graduated";
  // the flow window must fit inside the entry window, or a young token could never show known flow (1 SOL / min pace)
  const flowWindow = clamp(Math.round(entryDelaySec.max / 2), 10, 60);
  const demand: EntryRules["demand"] = curveish
    ? { windowSec: flowWindow, minNetInflowSol: Math.max(0.3, Math.round(((arch === "sniper" ? 0.5 : 1) * flowWindow) / 6) / 10), minBuySellRatio: 1.2 }
    : { windowSec: 300, minNetInflowSol: 0, minBuySellRatio: 1.1 };
  prov["entry.demand"] = curveish
    ? `≥ ${demand.minNetInflowSol} SOL net into the curve over ${dur(demand.windowSec)} (pools: 5m buys/sells ≥ ${demand.minBuySellRatio}) ← demand gate sized to the entry window; unknown flow is never treated as zero`
    : `buys/sells ≥ ${demand.minBuySellRatio} over 5m ← demand gate; unknown flow is never treated as zero`;

  const minLiquidityUsd = phase === "curve" ? 2_500 : arch === "swing" || arch === "diamond_hands" ? 25_000 : 8_000;
  prov["entry.minLiquidityUsd"] =
    phase === "curve"
      ? `${usd(minLiquidityUsd)} ← platform floor on curve depth (virtual SOL reserves; standard pump.fun curves start at 30 SOL)`
      : `${usd(minLiquidityUsd)} ← platform floor for pool entries (exit must be possible)`;

  const rugExposed = profile.flags.some((f) => f.id === "rug_exposed");
  const maxRugScore = rugExposed ? 40 : 60;
  prov["entry.maxRugScore"] = rugExposed
    ? `${maxRugScore} ← tightened: the brain is flagged rug-exposed`
    : `${maxRugScore} ← platform safety gate (RugCheck ≤ 60 = "warn" or better)`;

  const maxTopHoldersPct = phase === "curve" ? 30 : 35;
  prov["entry.maxTopHoldersPct"] = `${maxTopHoldersPct}% ← platform safety gate (top-10 holders excluding the curve/pool)`;
  prov["entry.minSwarmMembers"] = "0 ← swarms are a feed and an input to the judge, not a hard gate";

  const entry: EntryRules = {
    launchpads,
    phase,
    entryMcUsd,
    entryDelaySec,
    momentum,
    minLiquidityUsd,
    maxRugScore,
    requireMintRevoked: true,
    requireFreezeRevoked: true,
    maxTopHoldersPct,
    minSwarmMembers: 0,
    demand,
  };

  // ---------------------------------------------------------------- sizing
  const style: SizingRules["style"] = profile.sizing.style ?? "variable";
  const base = d.baseFraction;
  const [baseFraction, maxFraction] =
    style === "fixed" ? [base, base] : style === "variable" ? [base, round2(base * 1.5)] : [round2(base * 0.75), round2(base * 2)];
  prov["sizing.style"] = profile.sizing.style
    ? `${style} ← buy-size spread σ/μ ${profile.sizing.cv != null ? profile.sizing.cv.toFixed(2) : "n/a"}${
        profile.sizing.medianBuySol != null ? `, median buy ${trim(profile.sizing.medianBuySol, 2)} SOL` : ""
      }`
    : `${style} ← default (sizing style not measured)`;
  prov["sizing.baseFraction"] = `${pct(baseFraction)}–${pct(maxFraction)} of free SOL per entry ← ${style} sizing on ${d.label} base ${pct(base)}`;
  const maxOpenPositions = d.maxOpenPositions;
  prov["sizing.maxOpenPositions"] = `${maxOpenPositions} ← ${d.label} default`;
  const sizing: SizingRules = {
    baseFraction,
    maxFraction,
    style,
    maxPositionLamports: LAMPORTS_PER_SOL,
    maxOpenPositions,
    minTradeLamports: 10_000_000,
  };
  prov["sizing.maxPositionLamports"] = "1 SOL ← platform cap per position";

  // ---------------------------------------------------------------- exits
  const holdP75 = bucketQuantile(profile.hold.buckets, HOLD_EDGES, 0.75);
  const timeStopSec = holdP75 != null ? clamp(Math.round(holdP75 / 30) * 30, 2 * MIN, 7 * DAY) : d.timeStopSec;
  prov["exit.timeStopSec"] =
    holdP75 != null
      ? `${dur(timeStopSec)} ← hold time p75 ${dur(holdP75)}${profile.hold.medianHoldSec != null ? ` (median ${dur(profile.hold.medianHoldSec)})` : ""}, floor 2m`
      : `${dur(timeStopSec)} ← ${d.label} default (no closed holds measured)`;

  const stopOut = profile.exits.stopOutShare;
  const slFactor = stopOut == null ? 1 : stopOut >= 0.3 ? 0.8 : stopOut < 0.1 ? 1.25 : 1;
  const stopLossPct = Math.round(clamp(d.stopLossPct * slFactor, -60, -10));
  prov["exit.stopLossPct"] =
    stopOut != null
      ? `${stopLossPct}% ← ${pct(stopOut)} of first sells were stop-outs at ≤ −30% (${slFactor < 1 ? "cuts fast" : slFactor > 1 ? "rarely cuts" : "typical"})`
      : `${stopLossPct}% ← ${d.label} default`;

  const winners = bucketShare(profile.pnl.buckets, [">5x", "2–5x"]);
  const tp = Math.round(d.takeProfitPct * (winners != null && winners >= 0.25 ? 1.5 : 1));
  const ladderShare = profile.exits.ladderShare;
  const ladder: ExitPlan["ladder"] =
    ladderShare != null && ladderShare >= 0.2
      ? [
          { pct: Math.round(tp / 2), fraction: 0.33 },
          { pct: tp, fraction: 0.5 },
          { pct: tp * 2, fraction: 1 },
        ]
      : [{ pct: tp, fraction: 1 }];
  prov["exit.ladder"] =
    ladder.length > 1
      ? `${ladder.map((s) => `+${s.pct}% sell ${s.fraction === 1 ? "rest" : pct(s.fraction)}`).join(", ")} ← ${pct(ladderShare!)} of tokens exited over ≥ 3 sells`
      : `sell all at +${tp}% ← ${
          profile.exits.fullDumpShare != null ? `${pct(profile.exits.fullDumpShare)} of exits sold ≥ 90% in one tx` : `${d.label} default`
        }${winners != null && winners >= 0.25 ? `; target ×1.5 because ${pct(winners)} of tokens reached ≥ 2×` : ""}`;

  const initialsOut = profile.exits.initialsOutShare;
  const initialsOutPct = initialsOut != null && initialsOut >= 0.1 ? 100 : null;
  prov["exit.initialsOutPct"] =
    initialsOutPct != null
      ? `at +100% sell enough to recover cost ← ${pct(initialsOut!)} of first sells recovered the full cost`
      : `off ← ${initialsOut != null ? `only ${pct(initialsOut)} of first sells were initials-out` : "not measured"}`;

  const trailingStopPct = ladder.length > 1 ? 25 : arch === "momentum_chaser" ? 20 : null;
  prov["exit.trailingStopPct"] =
    trailingStopPct != null
      ? `${trailingStopPct}% from peak after the first take-profit ← ${ladder.length > 1 ? "laddered exits" : "momentum styles ride strength"}`
      : "off ← single full exit";
  const exit: ExitPlan = { timeStopSec, stopLossPct, ladder, initialsOutPct, trailingStopPct };

  // ---------------------------------------------------------------- risk
  const tpd = profile.activity.tradesPerDay;
  const maxTradesPerHour = tpd != null ? clamp(Math.round((tpd / 24) * 1.5), 1, d.maxTradesPerHour) : d.maxTradesPerHour;
  prov["risk.maxTradesPerHour"] =
    tpd != null
      ? `${maxTradesPerHour} ← ${trim(tpd)} trades/day × 1.5 per hour, capped at ${d.maxTradesPerHour} for the ${d.label} style`
      : `${maxTradesPerHour} ← ${d.label} default`;
  const capital = opts.capitalLamports ?? 5 * LAMPORTS_PER_SOL;
  const dailyLossLimitLamports = Math.round((capital * 0.2) / 10_000_000) * 10_000_000;
  prov["risk.dailyLossLimitLamports"] = `${sol(dailyLossLimitLamports)} ← 20% of starting capital (${sol(capital)})`;
  const slippageBps = phase === "curve" ? 1_000 : phase === "any" ? 800 : arch === "swing" || arch === "diamond_hands" ? 300 : 500;
  prov["risk.slippageBps"] = `${slippageBps / 100}% ← ${phase === "curve" ? "bonding-curve volatility" : "pool depth"} for ${phase} entries`;
  const fast = arch === "sniper" || arch === "bot_flipper" || arch === "early_ape";
  const priorityFeeLamports = fast ? 300_000 : 100_000;
  prov["risk.priorityFeeLamports"] = `${sol(priorityFeeLamports)} ← ${fast ? "fast style: land in the next blocks" : "standard"}`;
  if (opts.playbook) prov.playbook = `LLM judge reads the brain's playbook (${opts.playbook.length} chars) for the final buy/skip`;

  const risk: StrategySpec["risk"] = { dailyLossLimitLamports, maxTradesPerHour, slippageBps, priorityFeeLamports };
  const spec: StrategySpec = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    brainId: opts.brainId,
    archetype: arch,
    summary: "",
    entry,
    sizing,
    exit,
    risk,
    provenance: prov,
  };
  spec.summary = summarize(spec);
  return { ok: true, strategy: spec };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function bucketShare(buckets: Buckets, labels: string[]): number | null {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (!total) return null;
  return buckets.filter((b) => labels.includes(b.label)).reduce((s, b) => s + b.count, 0) / total;
}

/** Deterministic plain-language summary of the rules (no numbers that aren't in the spec). */
export function summarize(s: StrategySpec): string {
  const e = s.entry;
  const where =
    e.phase === "curve"
      ? `${e.launchpads.length ? e.launchpads.join("/") : "launchpad"} tokens still on the bonding curve`
      : e.phase === "graduated"
        ? `${e.launchpads.length ? `${e.launchpads.join("/")} ` : ""}tokens that already trade in a pool`
        : `${e.launchpads.length ? `${e.launchpads.join("/")} ` : ""}tokens on the curve or in a pool`;
  const mom = e.momentum.minChangePct ? `, only while the price is up ≥ ${e.momentum.minChangePct}% over ${dur(e.momentum.lookbackSec)}` : "";
  const size =
    s.sizing.baseFraction === s.sizing.maxFraction
      ? `${pct(s.sizing.baseFraction)} of free SOL`
      : `${pct(s.sizing.baseFraction)}–${pct(s.sizing.maxFraction)} of free SOL (${s.sizing.style} sizing)`;
  const x = s.exit;
  const tps =
    x.ladder.length === 1 && x.ladder[0].fraction === 1
      ? `everything at +${x.ladder[0].pct}%`
      : x.ladder.map((l) => `${l.fraction === 1 ? "the rest" : pct(l.fraction)} at +${l.pct}%`).join(", ");
  const extras = [
    x.initialsOutPct != null ? `takes initials out at +${x.initialsOutPct}%` : null,
    x.trailingStopPct != null ? `trails ${x.trailingStopPct}% from the peak after the first take-profit` : null,
  ].filter(Boolean);
  return [
    `Hunts ${where}, ${dur(e.entryDelaySec.min)}–${dur(e.entryDelaySec.max)} after launch, at ${usd(e.entryMcUsd.min)}–${usd(e.entryMcUsd.max)} market cap${mom}.`,
    `Buys ${size}, at most ${sol(s.sizing.maxPositionLamports)} per position and ${s.sizing.maxOpenPositions} open positions.`,
    `Sells ${tps}${extras.length ? `; ${extras.join("; ")}` : ""}; stops out at ${x.stopLossPct}% or after ${dur(x.timeStopSec)}.`,
    `At most ${s.risk.maxTradesPerHour} ${s.risk.maxTradesPerHour === 1 ? "trade" : "trades"} per hour; halts after losing ${sol(s.risk.dailyLossLimitLamports)} in a UTC day.`,
  ].join(" ");
}

// ---------------------------------------------------------------- owner overrides

export class OverrideError extends Error {}

/** Flatten + validate overrides against AGENT_OVERRIDE_BOUNDS. Throws OverrideError on unknown paths / out of bounds. */
export function validateOverrides(o: StrategyOverrides): StrategyOverrides {
  const out: StrategyOverrides = {};
  for (const [group, fields] of Object.entries(o ?? {})) {
    if (fields == null) continue;
    if (typeof fields !== "object") throw new OverrideError(`${group} must be an object`);
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      if (v === undefined) continue;
      const path = `${group}.${k}` as AgentOverridePath;
      const b = AGENT_OVERRIDE_BOUNDS[path];
      if (!b) throw new OverrideError(`${path} is not editable`);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new OverrideError(`${path} must be a number`);
      if (v < b.min || v > b.max) throw new OverrideError(`${path} must be between ${b.min} and ${b.max}`);
      const isInt = path.endsWith("Lamports") || path.endsWith("Positions") || path.endsWith("PerHour") || path.endsWith("Bps") || path.endsWith("Sec");
      const value = isInt ? Math.round(v) : v;
      ((out as Record<string, Record<string, number>>)[group] ??= {})[k] = value;
    }
  }
  if (out.sizing?.baseFraction != null && out.sizing.maxFraction != null && out.sizing.baseFraction > out.sizing.maxFraction)
    throw new OverrideError("sizing.baseFraction must be ≤ sizing.maxFraction");
  return out;
}

/** Apply validated overrides on top of a derived strategy; provenance marks every overridden field. */
export function applyOverrides(spec: StrategySpec, o: StrategyOverrides | null): StrategySpec {
  if (!o) return spec;
  const next: StrategySpec = structuredClone(spec);
  for (const [group, fields] of Object.entries(o)) {
    for (const [k, v] of Object.entries((fields ?? {}) as Record<string, number>)) {
      (next[group as "sizing" | "exit" | "risk"] as unknown as Record<string, number>)[k] = v;
      next.provenance[`${group}.${k}`] = `owner override (derived: ${String((spec[group as "sizing" | "exit" | "risk"] as unknown as Record<string, number>)[k])})`;
    }
  }
  if (next.sizing.baseFraction > next.sizing.maxFraction) next.sizing.maxFraction = next.sizing.baseFraction;
  next.summary = summarize(next);
  return next;
}
