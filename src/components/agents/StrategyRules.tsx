import type { ReactNode } from "react";
import type { StrategySpec } from "@/server/agents/types";
import { fmtDuration, fmtUsd } from "@/lib/format";
import { solOf } from "./lib";

/** "←" chip naming the profile statistic a rule came from (or "owner override"). */
function Provenance({ text }: { text: string | undefined }) {
  if (!text) return null;
  const override = text === "owner override";
  const arrow = text.indexOf("←");
  const short = arrow >= 0 ? text.slice(arrow).trim() : `← ${text}`;
  return (
    <span
      className={`chip h-auto max-w-full whitespace-normal py-0.5 text-[11px] leading-snug ${override ? "border-accent/40 text-accent" : "border-line-2 text-mute"}`}
      title={text}
    >
      {override ? "owner override" : short}
    </span>
  );
}

interface Rule {
  label: string;
  value: ReactNode;
  path?: string;
}

const pct = (n: number) => `${+(n * 100).toFixed(1)}%`;

function rules(s: StrategySpec): { group: string; items: Rule[] }[] {
  const e = s.entry;
  const momentum = e.momentum.minChangePct > 0 ? `≥ +${e.momentum.minChangePct}% over ${fmtDuration(e.momentum.lookbackSec)}` : "off";
  const safety = [
    `liquidity ≥ ${fmtUsd(e.minLiquidityUsd)}`,
    `rug score ≤ ${e.maxRugScore}`,
    e.requireMintRevoked && "mint revoked",
    e.requireFreezeRevoked && "freeze revoked",
    e.maxTopHoldersPct != null && `top holders ≤ ${e.maxTopHoldersPct}%`,
  ]
    .filter(Boolean)
    .join(" · ");
  const ladder = s.exit.ladder.length
    ? s.exit.ladder.map((st) => `+${st.pct}% → sell ${pct(st.fraction)}`).join(", ")
    : "none (single exit)";
  return [
    {
      group: "Entry",
      items: [
        { label: "Launchpads", value: e.launchpads.length ? e.launchpads.join(", ") : "any", path: "entry.launchpads" },
        { label: "Phase", value: e.phase === "curve" ? "bonding curve" : e.phase === "graduated" ? "graduated" : "any", path: "entry.phase" },
        { label: "Entry market cap", value: `${fmtUsd(e.entryMcUsd.min)}–${fmtUsd(e.entryMcUsd.max)}`, path: "entry.entryMcUsd" },
        {
          label: "Token age at entry",
          value: `${fmtDuration(e.entryDelaySec.min)}–${fmtDuration(e.entryDelaySec.max)}`,
          path: "entry.entryDelaySec",
        },
        { label: "Momentum gate", value: momentum, path: "entry.momentum" },
        {
          label: "Demand gate",
          value: e.demand
            ? `curve: net inflow ≥ ${e.demand.minNetInflowSol} SOL / ${fmtDuration(e.demand.windowSec)} · graduated: buys/sells ≥ ${e.demand.minBuySellRatio}`
            : "off",
          path: "entry.demand",
        },
        { label: "Safety", value: safety },
        { label: "Swarm confirmation", value: e.minSwarmMembers > 0 ? `≥ ${e.minSwarmMembers} tracked brains` : "off", path: "entry.minSwarmMembers" },
      ],
    },
    {
      group: "Sizing",
      items: [
        { label: "Style", value: s.sizing.style, path: "sizing.style" },
        { label: "Per entry", value: `${pct(s.sizing.baseFraction)}–${pct(s.sizing.maxFraction)} of free SOL`, path: "sizing.baseFraction" },
        { label: "Max per position", value: solOf(s.sizing.maxPositionLamports), path: "sizing.maxPositionLamports" },
        { label: "Max open positions", value: s.sizing.maxOpenPositions, path: "sizing.maxOpenPositions" },
      ],
    },
    {
      group: "Exit",
      items: [
        { label: "Time stop", value: fmtDuration(s.exit.timeStopSec), path: "exit.timeStopSec" },
        { label: "Stop loss", value: `${s.exit.stopLossPct}%`, path: "exit.stopLossPct" },
        { label: "Take-profit ladder", value: ladder, path: "exit.ladder" },
        { label: "Initials out", value: s.exit.initialsOutPct != null ? `at +${s.exit.initialsOutPct}%` : "off", path: "exit.initialsOutPct" },
        {
          label: "Trailing stop",
          value: s.exit.trailingStopPct != null ? `${s.exit.trailingStopPct}% from peak` : "off",
          path: "exit.trailingStopPct",
        },
      ],
    },
    {
      group: "Risk",
      items: [
        { label: "Daily loss limit", value: solOf(s.risk.dailyLossLimitLamports), path: "risk.dailyLossLimitLamports" },
        { label: "Max trades / hour", value: s.risk.maxTradesPerHour, path: "risk.maxTradesPerHour" },
        { label: "Slippage", value: `${s.risk.slippageBps / 100}%`, path: "risk.slippageBps" },
      ],
    },
  ];
}

/** Read-only rule list with the profile statistic behind each rule. */
export function StrategyRules({ strategy, compact = false }: { strategy: StrategySpec; compact?: boolean }) {
  return (
    <div className={`grid gap-x-8 gap-y-6 ${compact ? "" : "md:grid-cols-2"}`}>
      {rules(strategy).map((g) => (
        <div key={g.group} className="min-w-0">
          <h4 className="eyebrow mb-2">{g.group}</h4>
          <dl className="divide-y divide-line">
            {g.items.map((r) => (
              <div key={r.label} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <dt className="shrink-0 text-xs text-mute">{r.label}</dt>
                <dd className="flex min-w-0 flex-col gap-1 sm:items-end sm:text-right">
                  <span className="num break-words text-sm text-ink">{r.value}</span>
                  {r.path && <Provenance text={strategy.provenance[r.path]} />}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
