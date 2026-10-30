import type { AgentOrderDTO, AgentPositionDTO } from "@/server/agents/types";
import { dexscreenerToken, solscan } from "@/components/ui/links";
import { EmptyState, ExternalLink } from "@/components/ui/primitives";
import { fmtDuration, fmtUsd, shortAddr, timeAgo } from "@/lib/format";
import { fmtPrice, fmtSignedPct, fmtSignedSol, signClass, solOf } from "./lib";

function Token({ mint, symbol }: { mint: string; symbol: string | null }) {
  return (
    <ExternalLink href={dexscreenerToken(mint)} className="num font-medium text-ink">
      {symbol ? `$${symbol}` : shortAddr(mint)}
    </ExternalLink>
  );
}

/** Exit-plan progress: time stop countdown, ladder steps hit, initials-out and the stop-loss price. */
function ExitProgress({ p, now }: { p: AgentPositionDTO; now: number }) {
  const left = p.timeStopAt - now;
  const total = Math.max(1, p.timeStopAt - p.openedAt);
  const elapsed = Math.min(1, Math.max(0, (now - p.openedAt) / total));
  const steps = p.exitPlan.ladder;
  const stopPrice = p.entryPriceUsd != null ? p.entryPriceUsd * (1 + p.exitPlan.stopLossPct / 100) : null;
  return (
    <div className="min-w-[11rem] space-y-1.5">
      <div>
        <div className="flex justify-between text-[11px] text-mute">
          <span>time stop</span>
          <span className="num">{left > 0 ? `in ${fmtDuration(left)}` : "due"}</span>
        </div>
        <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
          <div className={`h-full ${left > 0 ? "bg-info/70" : "bg-warn"}`} style={{ width: `${elapsed * 100}%` }} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {steps.map((s, i) => (
          <span
            key={`${s.pct}-${i}`}
            className={`chip h-5 px-1.5 text-[10px] ${i < p.tpStepsHit ? "border-up/40 text-up" : "text-mute"}`}
            title={`At +${s.pct}% sell ${Math.round(s.fraction * 100)}% of the remainder${i < p.tpStepsHit ? " — done" : ""}`}
          >
            +{s.pct}%
          </span>
        ))}
        {p.exitPlan.initialsOutPct != null && (
          <span className={`chip h-5 px-1.5 text-[10px] ${p.initialsOutDone ? "border-up/40 text-up" : "text-mute"}`} title="Sell enough to recover the cost basis">
            initials +{p.exitPlan.initialsOutPct}%
          </span>
        )}
        <span className="chip h-5 px-1.5 text-[10px] text-mute" title={stopPrice != null ? `Stop price ≈ ${fmtPrice(stopPrice)}` : undefined}>
          SL {p.exitPlan.stopLossPct}%
        </span>
      </div>
    </div>
  );
}

export function OpenPositions({ positions, now }: { positions: AgentPositionDTO[]; now: number }) {
  if (positions.length === 0) return <EmptyState title="No open positions">Positions the agent opens appear here with their exit plan.</EmptyState>;
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Token</th>
            <th className="text-right">Entry</th>
            <th className="text-right">Current</th>
            <th className="text-right">Value</th>
            <th className="text-right">PnL</th>
            <th>Exit plan</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const stale = p.lastPriceAt == null || now - p.lastPriceAt > 120;
            return (
              <tr key={`${p.mint}:${p.openedAt}`}>
                <td>
                  <Token mint={p.mint} symbol={p.symbol} />
                  <span className="num block text-[11px] text-mute">opened {timeAgo(p.openedAt, now)}</span>
                </td>
                <td className="num whitespace-nowrap text-right text-ink-2">
                  {fmtPrice(p.entryPriceUsd)}
                  <span className="block text-[11px] text-mute">MC {fmtUsd(p.entryMcUsd)}</span>
                </td>
                <td className="num whitespace-nowrap text-right text-ink-2">
                  {fmtPrice(p.lastPriceUsd)}
                  {stale && <span className="block text-[11px] text-warn">{p.lastPriceAt == null ? "no price" : `stale ${fmtDuration(now - p.lastPriceAt)}`}</span>}
                </td>
                <td className="num whitespace-nowrap text-right text-ink-2">
                  {solOf(p.valueLamports)}
                  <span className="block text-[11px] text-mute">cost {solOf(p.costLamports)}</span>
                </td>
                <td className="num whitespace-nowrap text-right">
                  <span className={signClass(p.pnlPct)}>{fmtSignedPct(p.pnlPct)}</span>
                  <span className="block text-[11px] text-mute">{fmtSignedSol(p.unrealizedLamports)}</span>
                </td>
                <td>
                  <ExitProgress p={p} now={now} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ClosedPositions({ positions, now }: { positions: AgentPositionDTO[]; now: number }) {
  if (positions.length === 0) return null;
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Token</th>
            <th className="text-right">Held</th>
            <th className="text-right">Realised</th>
            <th className="text-right">Closed</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={`${p.mint}:${p.openedAt}`}>
              <td>
                <Token mint={p.mint} symbol={p.symbol} />
              </td>
              <td className="num text-right text-ink-2">{fmtDuration((p.closedAt ?? now) - p.openedAt)}</td>
              <td className={`num text-right ${signClass(p.realizedLamports)}`}>{fmtSignedSol(p.realizedLamports)}</td>
              <td className="num whitespace-nowrap text-right text-mute">{p.closedAt ? timeAgo(p.closedAt, now) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Order history; live fills link to Solscan. */
export function TradesTable({ orders, now }: { orders: AgentOrderDTO[]; now: number }) {
  if (orders.length === 0) return <EmptyState title="No trades yet">Every buy and sell the agent places is listed here.</EmptyState>;
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>When</th>
            <th>Side</th>
            <th>Token</th>
            <th className="text-right">SOL</th>
            <th className="text-right">Price</th>
            <th className="text-right">MC</th>
            <th>Reason</th>
            <th>Status</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="num whitespace-nowrap text-mute">{timeAgo(o.filledAt ?? o.createdAt, now)}</td>
              <td className={`num uppercase ${o.side === "buy" ? "text-up" : "text-info"}`}>{o.side}</td>
              <td>
                <Token mint={o.mint} symbol={o.symbol} />
              </td>
              <td className="num whitespace-nowrap text-right text-ink">{solOf(o.lamports)}</td>
              <td className="num whitespace-nowrap text-right text-ink-2">{fmtPrice(o.priceUsd)}</td>
              <td className="num whitespace-nowrap text-right text-ink-2">{fmtUsd(o.mcUsd)}</td>
              <td className="max-w-[14rem] truncate text-xs text-ink-2" title={o.error ?? o.reason}>
                {o.reason}
              </td>
              <td className={`text-xs ${o.status === "failed" ? "text-down" : o.status === "filled" ? "text-up" : "text-mute"}`} title={o.error ?? undefined}>
                {o.status}
              </td>
              <td className="text-xs">
                {o.signature ? (
                  <ExternalLink href={solscan("tx", o.signature)} className="num text-mute">
                    {shortAddr(o.signature, 4)}
                  </ExternalLink>
                ) : (
                  <span className="text-faint">{o.paper ? "paper" : "—"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
