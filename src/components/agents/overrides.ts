import { AGENT_OVERRIDE_BOUNDS, type AgentOverridePath, type StrategyOverrides, type StrategySpec } from "@/server/agents/types";

/** Owner-editable fields; display value = stored value / scale (fractions and bps as %, lamports as SOL, seconds as minutes). */
export const OVERRIDE_FIELDS: { path: AgentOverridePath; label: string; unit: string; scale: number }[] = [
  { path: "sizing.baseFraction", label: "Base size", unit: "% of free SOL", scale: 0.01 },
  { path: "sizing.maxFraction", label: "Max size", unit: "% of free SOL", scale: 0.01 },
  { path: "sizing.maxPositionLamports", label: "Max per position", unit: "SOL", scale: 1e9 },
  { path: "sizing.maxOpenPositions", label: "Max open positions", unit: "", scale: 1 },
  { path: "exit.stopLossPct", label: "Stop loss", unit: "%", scale: 1 },
  { path: "exit.timeStopSec", label: "Time stop", unit: "min", scale: 60 },
  { path: "risk.dailyLossLimitLamports", label: "Daily loss limit", unit: "SOL", scale: 1e9 },
  { path: "risk.maxTradesPerHour", label: "Max trades / hour", unit: "", scale: 1 },
  { path: "risk.slippageBps", label: "Slippage", unit: "%", scale: 100 },
];

/** Stored → display string, rounding away float noise (0.07 / 0.01 → "7"). */
export function toDisplay(stored: number, scale: number): string {
  return String(+(stored / scale).toPrecision(10));
}

export function readOverridePath(s: StrategySpec, path: AgentOverridePath): number {
  const [group, key] = path.split(".") as ["sizing" | "exit" | "risk", string];
  return (s[group] as unknown as Record<string, number>)[key];
}

/**
 * Display strings → PATCH `strategyOverrides` with only the changed fields, validated against AGENT_OVERRIDE_BOUNDS
 * (and base ≤ max size). Integers for integer-scaled fields (lamports, counts, seconds, bps).
 */
export function buildOverrides(s: StrategySpec, values: Record<string, string>): { overrides: StrategyOverrides } | { error: string } {
  const overrides: StrategyOverrides = {};
  const nested = overrides as Record<string, Record<string, number>>;
  for (const f of OVERRIDE_FIELDS) {
    const raw = values[f.path] ?? "";
    const display = Number(raw);
    const b = AGENT_OVERRIDE_BOUNDS[f.path];
    const stored = f.scale >= 1 ? Math.round(display * f.scale) : +(display * f.scale).toFixed(6);
    if (raw.trim() === "" || !Number.isFinite(display) || stored < b.min || stored > b.max) {
      return { error: `${f.label} must be between ${toDisplay(b.min, f.scale)} and ${toDisplay(b.max, f.scale)}${f.unit ? ` ${f.unit}` : ""}` };
    }
    if (stored === readOverridePath(s, f.path)) continue;
    const [group, key] = f.path.split(".");
    nested[group] = { ...nested[group], [key]: stored };
  }
  const base = overrides.sizing?.baseFraction ?? s.sizing.baseFraction;
  const max = overrides.sizing?.maxFraction ?? s.sizing.maxFraction;
  if (base > max) return { error: "Base size can't exceed max size" };
  return { overrides };
}
