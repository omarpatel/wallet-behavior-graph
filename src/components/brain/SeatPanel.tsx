import Link from "next/link";
import { ChainActionButton } from "@/components/chain/ChainActionButton";
import { Stat } from "@/components/ui/primitives";
import { fmtDuration, fmtSol, lamportsToSol } from "@/lib/format";
import type { BrainAccess } from "@/server/access";
import type { BrainDetail } from "@/server/queries/brains";
import { SeatMeter } from "./BrainCard";

export function SeatPanel({ brain, access }: { brain: BrainDetail; access: BrainAccess }) {
  const left = Math.max(0, brain.seatSupply - brain.seatsMinted);
  const price = fmtSol(lamportsToSol(brain.seatPriceLamports), 3);
  const renewal = fmtSol(lamportsToSol(brain.renewalPriceLamports), 3);
  const lowest = brain.listings[0];

  return (
    <aside id="seat" aria-labelledby="seat-title" className="card scroll-mt-24 space-y-5 p-5">
      <div className="flex items-center justify-between">
        <h2 id="seat-title" className="text-sm font-semibold text-ink">
          Seat
        </h2>
        {access.ok && (
          <span className="chip border-up/40 text-up">
            {access.reason === "seat" ? "You hold a seat" : access.reason === "kol" ? "Owner access" : "Admin access"}
          </span>
        )}
      </div>

      <SeatMeter minted={brain.seatsMinted} supply={brain.seatSupply} />

      <dl className="grid grid-cols-2 gap-4">
        <Stat label="Mint price" value={price} />
        <Stat label={`Renewal / ${brain.termDays}d`} value={renewal} />
        <Stat label="Term" value={`${brain.termDays} days`} />
        <Stat label="Seats left" value={left} tone={left === 0 ? "down" : "neutral"} />
      </dl>

      <ul className="space-y-1.5 text-xs text-mute">
        <li>
          <span className="font-medium text-ink-2">Real-time picks:</span> tokens that match this wallet&apos;s style the
          moment they qualify, with the style&apos;s size and exit plan. Without a seat, picks show 1h later.
        </li>
        <li>Unlocks live alerts, coaching, the full playbook and brain agents.</li>
        <li>Term travels with the seat; renew any time to extend.</li>
        <li>Membership only: no revenue, yield or buybacks for holders.</li>
      </ul>

      {access.reason === "seat" && access.seat ? (
        <div className="space-y-3 rounded-xl border border-line bg-bg-2/60 p-3">
          <p className="text-xs text-ink-2">
            Access for <span className="num text-ink">{fmtDuration(access.seat.expiresAt - brain.now)}</span> more.
          </p>
          <ChainActionButton
            endpoint="/api/seats/renew"
            body={{ asset: access.seat.asset }}
            label={`Renew ${brain.termDays}d · ${renewal}`}
            variant="ghost"
            size="sm"
            confirm={
              <>
                Extend this seat&apos;s access by <strong className="text-ink">{brain.termDays} days</strong> for{" "}
                <strong className="num text-ink">{renewal}</strong>.
              </>
            }
          />
        </div>
      ) : left > 0 ? (
        <ChainActionButton
          endpoint="/api/seats/mint"
          body={{ brainId: brain.id }}
          label={`Mint seat · ${price}`}
          confirm={
            <>
              Mint seat <strong className="text-ink">#{brain.seatsMinted + 1}</strong> of {brain.seatSupply} for{" "}
              <strong className="num text-ink">{price}</strong>, with {brain.termDays} days of access. Renewal is {renewal} per{" "}
              {brain.termDays} days.
            </>
          }
        />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-ink-2">All {brain.seatSupply} seats are minted.</p>
          {lowest ? (
            <Link href="#listings" className="btn btn-ghost btn-sm">
              {brain.listings.length} listed · lowest {fmtSol(lamportsToSol(lowest.priceLamports), 3)}
            </Link>
          ) : (
            <p className="text-xs text-mute">No seats are listed right now.</p>
          )}
        </div>
      )}
      {access.reason === "expired" && <p className="text-xs text-warn">Your seat&apos;s term has expired. Renew it from My seats.</p>}
    </aside>
  );
}
