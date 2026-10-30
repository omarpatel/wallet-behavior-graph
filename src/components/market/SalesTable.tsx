import { BrainLink } from "@/components/brain/BrainLink";
import { ExternalLink } from "@/components/ui/primitives";
import { solscan } from "@/components/ui/links";
import { fmtSol, lamportsToSol, shortAddr, timeAgo } from "@/lib/format";
import type { SaleRow } from "@/server/queries/brains";

export function SalesTable({ sales, now, showBrain = true }: { sales: SaleRow[]; now: number; showBrain?: boolean }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <caption className="sr-only">Recent seat sales</caption>
        <thead>
          <tr>
            {showBrain && <th scope="col">Brain</th>}
            <th scope="col">Seat</th>
            <th scope="col" className="text-right">
              Price
            </th>
            <th scope="col">Buyer</th>
            <th scope="col">When</th>
            <th scope="col">
              <span className="sr-only">Transaction</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <tr key={s.id}>
              {showBrain && (
                <td className="max-w-[220px]">
                  <BrainLink id={s.brainId} brain={s} />
                </td>
              )}
              <td className="num text-ink-2">#{s.seatNumber}</td>
              <td className="num text-right text-ink">{fmtSol(lamportsToSol(s.priceLamports), 3)}</td>
              <td className="num text-mute">{s.buyer ? shortAddr(s.buyer) : "—"}</td>
              <td className="num whitespace-nowrap text-mute">{timeAgo(s.soldAt, now)}</td>
              <td className="text-right">
                {s.saleSignature && (
                  <ExternalLink href={solscan("tx", s.saleSignature, "seats")} className="text-xs text-mute">
                    tx
                  </ExternalLink>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
