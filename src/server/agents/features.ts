/**
 * CandidateFeatures from a hub TokenState, and the deterministic entry filter. Every rule is either pass, fail or
 * unknown; unknown blocks a buy exactly like a fail (sniper: unknown is never zero) but is reported as such.
 * Rules run in two stages: market (free, from the feeds) then safety (RPC + RugCheck, only when the market stage passes).
 */
import type { TokenState } from "./feeds/hub";
import { dur, usd } from "./strategy";
import type { CandidateFeatures, EntryRules } from "./types";

export function buildFeatures(t: TokenState, now: number, rules: EntryRules, visibleSwarmMembers: number): CandidateFeatures {
  const inflow = rules.demand ? t.window.netInflowLamports(rules.demand.windowSec) : null;
  const safety = t.safety;
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    launchpad: t.launchpad,
    phase: t.phase,
    ageSec: t.createdAt != null ? Math.max(0, now - t.createdAt) : null,
    mcUsd: t.mcUsd,
    priceUsd: t.priceUsd,
    liquidityUsd: t.liquidityUsd,
    // our own samples first (exact window); provider numbers when our history is shorter
    change5mPct: round(t.window.changePct(300) ?? t.providerChange5m),
    change1hPct: round(t.window.changePct(3600) ?? t.providerChange1h),
    buys5m: t.buys5m,
    sells5m: t.sells5m,
    rugScore: safety?.rugScore ?? null,
    mintRevoked: safety?.mintRevoked ?? t.jupAudit?.mintRevoked ?? null,
    freezeRevoked: safety?.freezeRevoked ?? t.jupAudit?.freezeRevoked ?? null,
    topHoldersPct: round(safety?.topHoldersPct ?? t.jupAudit?.topHoldersPct ?? null),
    swarmMembers: visibleSwarmMembers,
    source: t.source,
    netInflowSol: inflow != null ? Math.round(inflow / 1e6) / 1e3 : null,
    curveProgressPct: round(t.curveProgressPct),
    priceAgeSec: t.priceAt != null ? now - t.priceAt : null,
  };
}

function round(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100;
}

/** Momentum over the rule's lookback, from our window or the matching provider figure. */
export function momentumChange(t: TokenState, lookbackSec: number): number | null {
  const own = t.window.changePct(lookbackSec);
  if (own != null) return own;
  if (lookbackSec <= 300) return t.providerChange5m;
  if (lookbackSec <= 3600) return t.providerChange1h;
  return null;
}

export interface RuleCheck {
  rule: string;
  status: "pass" | "fail" | "unknown";
  detail: string;
}

export interface EntryVerdict {
  stage: "market" | "safety";
  pass: boolean;
  checks: RuleCheck[];
  /** Fails + unknowns, in rule order. */
  misses: RuleCheck[];
}

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

function check(rule: string, value: number | null, ok: (v: number) => boolean, show: (v: number) => string, want: string): RuleCheck {
  if (value == null) return { rule, status: "unknown", detail: `${rule} unknown (need ${want})` };
  return ok(value) ? { rule, status: "pass", detail: `${rule} ${show(value)}` } : { rule, status: "fail", detail: `${rule} ${show(value)}, need ${want}` };
}

/** Stage 1: market rules (launchpad, phase, MC, age, liquidity, momentum, demand, swarm). */
export function marketChecks(rules: EntryRules, f: CandidateFeatures, momentum: number | null): RuleCheck[] {
  const out: RuleCheck[] = [];
  if (rules.launchpads.length) {
    const lp = f.launchpad;
    out.push(
      lp == null
        ? { rule: "launchpad", status: "unknown", detail: `launchpad unknown (need ${rules.launchpads.join("/")})` }
        : rules.launchpads.includes(lp)
          ? { rule: "launchpad", status: "pass", detail: `launchpad ${lp}` }
          : { rule: "launchpad", status: "fail", detail: `launchpad ${lp}, need ${rules.launchpads.join("/")}` },
    );
  }
  if (rules.phase !== "any") {
    out.push(
      f.phase === "unknown"
        ? { rule: "phase", status: "unknown", detail: `phase unknown (need ${rules.phase})` }
        : f.phase === rules.phase
          ? { rule: "phase", status: "pass", detail: `phase ${f.phase}` }
          : { rule: "phase", status: "fail", detail: `phase ${f.phase}, need ${rules.phase}` },
    );
  }
  const { min: mcMin, max: mcMax } = rules.entryMcUsd;
  out.push(check("MC", f.mcUsd, (v) => v >= mcMin && v <= mcMax, usd, `${usd(mcMin)}–${usd(mcMax)}`));
  const { min: aMin, max: aMax } = rules.entryDelaySec;
  out.push(check("age", f.ageSec, (v) => v >= aMin && v <= aMax, dur, `${dur(aMin)}–${dur(aMax)}`));
  out.push(check("liquidity", f.liquidityUsd, (v) => v >= rules.minLiquidityUsd, usd, `≥ ${usd(rules.minLiquidityUsd)}`));
  if (rules.momentum.minChangePct > 0) {
    out.push(
      check(`${dur(rules.momentum.lookbackSec)} change`, momentum, (v) => v >= rules.momentum.minChangePct, fmtPct, `≥ +${rules.momentum.minChangePct}%`),
    );
  }
  if (rules.demand) {
    const d = rules.demand;
    if (f.phase === "curve") {
      if (d.minNetInflowSol > 0)
        out.push(check(`${dur(d.windowSec)} net inflow`, f.netInflowSol, (v) => v >= d.minNetInflowSol, (v) => `${v.toFixed(2)} SOL`, `≥ ${d.minNetInflowSol} SOL`));
    } else if (d.minBuySellRatio > 0) {
      const ratio = f.buys5m != null && f.sells5m != null ? f.buys5m / Math.max(1, f.sells5m) : null;
      out.push(check("5m buys/sells", ratio, (v) => v >= d.minBuySellRatio, (v) => v.toFixed(2), `≥ ${d.minBuySellRatio}`));
    }
  }
  if (rules.minSwarmMembers > 0) out.push(check("swarm", f.swarmMembers, (v) => v >= rules.minSwarmMembers, (v) => `${v} brains`, `≥ ${rules.minSwarmMembers}`));
  return out;
}

/** Stage 2: safety rules (needs hub.ensureSafety first). */
export function safetyChecks(rules: EntryRules, f: CandidateFeatures): RuleCheck[] {
  const out: RuleCheck[] = [];
  const flag = (rule: string, v: boolean | null): RuleCheck =>
    v == null ? { rule, status: "unknown", detail: `${rule} unknown` } : v ? { rule, status: "pass", detail: rule } : { rule, status: "fail", detail: `${rule}: no` };
  if (rules.requireMintRevoked) out.push(flag("mint authority revoked", f.mintRevoked));
  if (rules.requireFreezeRevoked) out.push(flag("freeze authority revoked", f.freezeRevoked));
  if (rules.maxTopHoldersPct != null) {
    const cap = rules.maxTopHoldersPct;
    out.push(check("top-10 holders", f.topHoldersPct, (v) => v <= cap, (v) => `${v.toFixed(1)}%`, `≤ ${cap}%`));
  }
  // RugCheck rarely knows a token in its first minutes; on the curve the on-chain checks above stand in for it.
  if (f.rugScore == null && f.phase === "curve") out.push({ rule: "RugCheck", status: "pass", detail: "RugCheck not indexed yet (curve token; on-chain checks used)" });
  else out.push(check("RugCheck", f.rugScore, (v) => v <= rules.maxRugScore, (v) => `${v}`, `≤ ${rules.maxRugScore}`));
  return out;
}

export function verdict(stage: EntryVerdict["stage"], checks: RuleCheck[]): EntryVerdict {
  const misses = checks.filter((c) => c.status !== "pass");
  return { stage, pass: misses.length === 0, checks, misses };
}

/** "skip: MC $4.2k, need $8k–$30k; age unknown (need 19s–8m)" / "rules pass: MC $12k; age 45s; …". */
export function describeVerdict(v: EntryVerdict): string {
  if (v.pass) return `rules pass: ${v.checks.map((c) => c.detail).join("; ")}`;
  return `skip: ${v.misses.map((c) => c.detail).join("; ")}`;
}
