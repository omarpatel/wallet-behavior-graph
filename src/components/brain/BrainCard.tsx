import { ArchetypeChip, TierBadge } from "@/components/ui/badges";
import { Stat, toneFor } from "@/components/ui/primitives";
import { fmtDuration, fmtPct, fmtSol, fmtUsd, lamportsToSol } from "@/lib/format";
import type { BrainCard as BrainCardData } from "@/server/queries/brains";
import { BrainTitle } from "./BrainTitle";

export function SeatMeter({ minted, supply }: { minted: number; supply: number }) {
  const pct = supply > 0 ? Math.min(100, (minted / supply) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="eyebrow">Seats</span>
        <span className="num text-ink-2">
          {minted}/{supply}
        </span>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]"
        role="meter"
        aria-label="Seats minted"
        aria-valuemin={0}
        aria-valuemax={supply}
        aria-valuenow={minted}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function BrainCard({ brain }: { brain: BrainCardData }) {
  const pending = brain.backfillStatus !== "done" && brain.sampleTokens == null;
  return (
    <article className="card card-hover relative flex flex-col gap-5 p-5">
      <div className="flex items-start justify-between gap-3">
        <BrainTitle brain={brain} href={`/brains/${brain.id}`} avatar={48} />
        <div className="flex shrink-0 flex-col items-end gap-1">
          <TierBadge tier={brain.tier} />
          <span className="num text-[11px] text-mute" title="Track-record score (0–100)">
            {brain.trackScore != null ? brain.trackScore.toFixed(0) : "—"}
          </span>
        </div>
      </div>

      <div className="flex min-h-6 flex-wrap gap-2">
        {brain.archetype ? (
          <ArchetypeChip label={brain.archetype.label} title={brain.archetype.reason} />
        ) : (
          <span className="chip border-dashed text-mute">{pending ? `Backfill ${brain.backfillStatus}` : "No profile yet"}</span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Stat label="Realized PnL 90d" value={fmtUsd(brain.realizedUsd)} tone={toneFor(brain.realizedUsd)} />
        <Stat label="Win rate" value={fmtPct(brain.winRate)} />
        <Stat label="Median hold" value={fmtDuration(brain.medianHoldSec)} />
        <Stat label="Median entry MC" value={fmtUsd(brain.medianEntryMcUsd)} />
      </dl>

      <div className="mt-auto grid grid-cols-[1fr_auto] items-end gap-4 border-t border-line pt-4">
        <SeatMeter minted={brain.seatsMinted} supply={brain.seatSupply} />
        <div className="text-right">
          <div className="eyebrow">Mint</div>
          <div className="num text-sm font-medium text-ink">{fmtSol(lamportsToSol(brain.seatPriceLamports))}</div>
        </div>
      </div>
    </article>
  );
}
