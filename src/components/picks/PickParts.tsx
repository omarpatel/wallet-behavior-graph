import type { ExitPlan } from "@/server/agents/types";
import type { PickCloseReason, PickStatsDTO } from "@/server/picks/types";
import { fmtSignedPct, signClass } from "@/components/agents/lib";
import { Stat, toneFor } from "@/components/ui/primitives";
import { fmtDuration, fmtPct } from "@/lib/format";

/** Share of a bankroll (0–1) as "4%" / "2.5%". */
export const fmtBankroll = (fraction: number) => `${+(fraction * 100).toFixed(1)}%`;

export const CLOSE_LABEL: Record<PickCloseReason, string> = {
  tp: "Take-profit",
  sl: "Stop-loss",
  trail: "Trailing stop",
  time: "Time stop",
  dead: "Dead",
};

export const CLOSE_TITLE: Record<PickCloseReason, string> = {
  tp: "Closed on paper by the style's take-profit ladder",
  sl: "Closed on paper by the style's stop-loss",
  trail: "Closed on paper by the style's trailing stop (after the first take-profit)",
  time: "Closed on paper by the style's time stop",
  dead: "No price for 15 minutes: closed on paper with the remaining value at zero",
};

/** The style's exit plan as compact chips: stop-loss, take-profit ladder, initials-out, trailing stop, time stop. */
export function ExitPlanChips({ plan, small = false }: { plan: ExitPlan; small?: boolean }) {
  const cls = `chip num ${small ? "h-5 px-1.5 text-[10px]" : "text-[11px]"}`;
  return (
    <span className="flex flex-wrap gap-1.5">
      <span className={`${cls} border-down/30 text-down`} title="Sell everything at this loss from the pick price">
        stop-loss {fmtSignedPct(plan.stopLossPct, 0)}
      </span>
      {plan.ladder.map((s, i) => (
        <span key={`${s.pct}-${i}`} className={`${cls} border-up/30 text-up`} title={`At +${s.pct}% sell ${Math.round(s.fraction * 100)}% of the remainder`}>
          +{s.pct}% → sell {Math.round(s.fraction * 100)}%
        </span>
      ))}
      {plan.initialsOutPct != null && (
        <span className={`${cls} text-ink-2`} title="Sell enough to recover the stake">
          initials out at +{plan.initialsOutPct}%
        </span>
      )}
      {plan.trailingStopPct != null && (
        <span className={`${cls} text-ink-2`} title="From the peak, after the first take-profit">
          trailing {plan.trailingStopPct}% after 1st TP
        </span>
      )}
      <span className={`${cls} text-mute`} title="Sell whatever is left after this long">
        time stop {fmtDuration(plan.timeStopSec)}
      </span>
    </span>
  );
}

/** Track record of paper outcomes (closed picks), plus open and total counts. */
export function PickStatsGrid({ stats }: { stats: PickStatsDTO }) {
  return (
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Stat label="Picks" value={stats.picks.toLocaleString("en-US")} hint={`${stats.open} open on paper`} />
      <Stat label="Closed" value={stats.closed.toLocaleString("en-US")} hint={`${stats.wins} with a positive outcome`} />
      <Stat label="Win rate" value={fmtPct(stats.winRate)} hint="closed picks, outcome > 0" />
      <Stat label="Median outcome" value={fmtSignedPct(stats.medianOutcomePct)} tone={toneFor(stats.medianOutcomePct)} hint="per closed pick" />
      <Stat label="Avg outcome" value={fmtSignedPct(stats.avgOutcomePct)} tone={toneFor(stats.avgOutcomePct)} hint="per closed pick" />
      <Stat label="Best" value={fmtSignedPct(stats.bestOutcomePct)} tone={toneFor(stats.bestOutcomePct)} />
      <Stat label="Worst" value={fmtSignedPct(stats.worstOutcomePct)} tone={toneFor(stats.worstOutcomePct)} />
      <Stat label="Open" value={stats.open.toLocaleString("en-US")} hint="tracked live" />
    </dl>
  );
}

/** Signed % with up/down colour. */
export function SignedPct({ pct, className = "" }: { pct: number | null | undefined; className?: string }) {
  return <span className={`num ${signClass(pct)} ${className}`}>{fmtSignedPct(pct)}</span>;
}
