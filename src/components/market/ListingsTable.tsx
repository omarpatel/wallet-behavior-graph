import { BrainLink } from "@/components/brain/BrainLink";
import { TierBadge } from "@/components/ui/badges";
import type { BrainTier } from "@/db/schema";
import { fmtDuration, fmtSol, lamportsToSol, shortAddr } from "@/lib/format";
import { brainTitle, type IdentityFields } from "@/lib/identity";
import { BuyButton } from "./BuyButton";

export interface ListingView {
  id: string;
  seller: string;
  priceLamports: number;
  seatNumber: number;
  expiresAt: number;
  brain?: IdentityFields & { id: string; tier: BrainTier };
}

export function ListingsTable({ listings, now, codename }: { listings: ListingView[]; now: number; codename?: string }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <caption className="sr-only">Active seat listings</caption>
        <thead>
          <tr>
            {listings.some((l) => l.brain) && <th scope="col">Brain</th>}
            <th scope="col">Seat</th>
            <th scope="col" className="text-right">
              Price
            </th>
            <th scope="col">Term left</th>
            <th scope="col">Seller</th>
            <th scope="col">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => {
            const left = l.expiresAt - now;
            const name = l.brain ? brainTitle(l.brain) : (codename ?? "seat");
            return (
              <tr key={l.id}>
                {l.brain && (
                  <td>
                    <span className="flex items-center gap-2">
                      <TierBadge tier={l.brain.tier} size="sm" />
                      <BrainLink id={l.brain.id} brain={l.brain} />
                    </span>
                  </td>
                )}
                <td className="num text-ink-2">#{l.seatNumber}</td>
                <td className="num text-right font-medium text-ink">{fmtSol(lamportsToSol(l.priceLamports), 3)}</td>
                <td className={`num ${left > 0 ? "text-ink-2" : "text-warn"}`}>{left > 0 ? fmtDuration(left) : "expired — renew after buying"}</td>
                <td className="num text-mute">{shortAddr(l.seller)}</td>
                <td className="text-right">
                  <BuyButton
                    listingId={l.id}
                    seller={l.seller}
                    priceLabel={fmtSol(lamportsToSol(l.priceLamports), 3)}
                    seatLabel={`${name} seat #${l.seatNumber}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
