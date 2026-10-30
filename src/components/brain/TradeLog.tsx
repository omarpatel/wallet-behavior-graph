import { ExternalLink, EmptyState } from "@/components/ui/primitives";
import { dexscreenerToken, solscan } from "@/components/ui/links";
import { fmtDuration, fmtSol, fmtUsd, timeAgo } from "@/lib/format";
import type { PublicTrade } from "@/server/queries/brains";

export function TradeLog({ trades, now, delayLabel }: { trades: PublicTrade[]; now: number; delayLabel: string }) {
  if (trades.length === 0) {
    return (
      <EmptyState title="No public trades yet">
        Trades appear here {delayLabel} after they happen. Seat holders see them live.
      </EmptyState>
    );
  }
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <caption className="sr-only">Trades older than {delayLabel}</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Side</th>
            <th scope="col">Token</th>
            <th scope="col" className="text-right">
              SOL
            </th>
            <th scope="col" className="text-right">
              USD
            </th>
            <th scope="col" className="text-right">
              MC
            </th>
            <th scope="col" className="text-right" title="Buys: time since token creation">
              Entry delay
            </th>
            <th scope="col">
              <span className="sr-only">Transaction</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td className="num whitespace-nowrap text-mute">{timeAgo(t.blockTime, now)}</td>
              <td>
                <span className={`num text-xs font-semibold uppercase ${t.side === "buy" ? "text-up" : "text-down"}`}>{t.side}</span>
              </td>
              <td className="max-w-[12rem]">
                <ExternalLink href={dexscreenerToken(t.mint)} className="truncate text-ink">
                  {t.symbol ?? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`}
                </ExternalLink>
                {t.venue && <span className="ml-2 text-[10px] text-mute">{t.venue}</span>}
              </td>
              <td className="num text-right text-ink-2">{fmtSol(t.solValue, 3)}</td>
              <td className="num text-right text-ink-2">{fmtUsd(t.usdValue)}</td>
              <td className="num text-right text-ink-2">{fmtUsd(t.mcUsd)}</td>
              <td className="num text-right text-ink-2">{t.side === "buy" ? fmtDuration(t.entryDelaySec) : "—"}</td>
              <td className="text-right">
                <ExternalLink href={solscan("tx", t.signature)} className="text-xs text-mute">
                  tx
                </ExternalLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
