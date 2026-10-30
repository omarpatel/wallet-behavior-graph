import type { ReactNode } from "react";
import type { AgentDecisionDTO, AgentOrderDTO, CandidateFeatures } from "@/server/agents/types";
import type { StreamState } from "@/components/swarms/useSwarmStream";
import { dexscreenerToken, solscan } from "@/components/ui/links";
import { EmptyState, ExternalLink } from "@/components/ui/primitives";
import { fmtDuration, fmtUsd, shortAddr, timeAgo } from "@/lib/format";
import { fmtPrice, fmtSignedPct, solOf } from "./lib";

type Item = { kind: "decision"; at: number; d: AgentDecisionDTO } | { kind: "order"; at: number; o: AgentOrderDTO };

const ACTION_CLS: Record<AgentDecisionDTO["action"], string> = {
  buy: "border-up/40 text-up",
  sell: "border-info/40 text-info",
  skip: "border-line-2 text-mute",
};

const ORDER_CLS: Record<AgentOrderDTO["status"], string> = {
  queued: "border-line-2 text-mute",
  sent: "border-info/40 text-info",
  filled: "border-up/40 text-up",
  failed: "border-down/40 text-down",
};

function FeatureChips({ f }: { f: CandidateFeatures }) {
  const chips = [
    f.launchpad,
    f.phase !== "unknown" && (f.phase === "curve" ? "on curve" : "graduated"),
    f.mcUsd != null && `MC ${fmtUsd(f.mcUsd)}`,
    f.ageSec != null && `age ${fmtDuration(f.ageSec)}`,
    f.liquidityUsd != null && `liq ${fmtUsd(f.liquidityUsd)}`,
    f.change5mPct != null && `5m ${fmtSignedPct(f.change5mPct, 0)}`,
    f.buys5m != null && f.sells5m != null && `${f.buys5m}/${f.sells5m} buys/sells 5m`,
    f.rugScore != null && `rug ${f.rugScore}`,
    f.mintRevoked === false && "mint not revoked",
    f.freezeRevoked === false && "freeze not revoked",
    f.topHoldersPct != null && `top ${f.topHoldersPct.toFixed(0)}%`,
    f.swarmMembers > 0 && `swarm ×${f.swarmMembers}`,
    f.netInflowSol != null && `net inflow ${f.netInflowSol > 0 ? "+" : ""}${f.netInflowSol.toFixed(1)} SOL`,
    f.curveProgressPct != null && `curve ${f.curveProgressPct.toFixed(0)}%`,
    f.priceAgeSec != null && f.priceAgeSec > 60 && `price ${fmtDuration(f.priceAgeSec)} old`,
    `via ${f.source}`,
  ].filter((c): c is string => typeof c === "string" && c !== "");
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c} className="num chip h-5 px-1.5 text-[10px] text-mute">
          {c}
        </span>
      ))}
    </div>
  );
}

function TokenLabel({ mint, symbol }: { mint: string; symbol: string | null }) {
  return (
    <ExternalLink href={dexscreenerToken(mint)} className="num min-w-0 truncate font-medium text-ink">
      {symbol ? `$${symbol}` : shortAddr(mint)}
    </ExternalLink>
  );
}

/** One decision on a tape (incl. skips with their reason, feature chips and the LLM rationale). `extra` renders under the reason. */
export function DecisionEntry({ d, fresh, now, extra }: { d: AgentDecisionDTO; fresh: boolean; now: number; extra?: ReactNode }) {
  return (
    <li className={`px-4 py-3 transition-colors ${fresh ? "bg-accent/[0.05]" : ""}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={`chip h-5 shrink-0 px-1.5 text-[10px] uppercase ${ACTION_CLS[d.action]}`}>{d.action}</span>
        <TokenLabel mint={d.mint} symbol={d.symbol} />
        <span className="num ml-auto shrink-0 text-[11px] text-mute">{timeAgo(d.createdAt, now)}</span>
      </div>
      <p className="mt-1 break-words text-xs text-ink-2">{d.reason}</p>
      {extra}
      <FeatureChips f={d.features} />
      {d.llmText && (
        <p className="mt-2 border-l-2 border-accent/30 pl-2.5 text-xs italic leading-relaxed text-ink-2">
          {d.llmText}
          {d.llmModel && <span className="num ml-1.5 not-italic text-[10px] text-faint">{d.llmModel}</span>}
        </p>
      )}
    </li>
  );
}

/** One order on a tape; live fills link to Solscan. `extra` renders after the reason line. */
export function OrderEntry({ o, fresh, now, extra }: { o: AgentOrderDTO; fresh: boolean; now: number; extra?: ReactNode }) {
  return (
    <li className={`px-4 py-3 transition-colors ${fresh ? "bg-accent/[0.05]" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={`chip h-5 shrink-0 px-1.5 text-[10px] uppercase ${ORDER_CLS[o.status]}`}>
          {o.side} · {o.status}
        </span>
        <TokenLabel mint={o.mint} symbol={o.symbol} />
        <span className="num text-xs text-ink">{solOf(o.lamports)}</span>
        {o.priceUsd != null && <span className="num text-[11px] text-mute">@ {fmtPrice(o.priceUsd)}</span>}
        <span className="num ml-auto shrink-0 text-[11px] text-mute">{timeAgo(o.filledAt ?? o.createdAt, now)}</span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-2">
        <span>{o.reason}</span>
        {o.paper && <span className="text-mute">paper fill</span>}
        {o.signature && (
          <ExternalLink href={solscan("tx", o.signature)} className="num text-mute">
            {shortAddr(o.signature, 6)}
          </ExternalLink>
        )}
      </p>
      {extra}
      {o.error && <p className="mt-1 break-words text-xs text-down">{o.error}</p>}
    </li>
  );
}

/** Tape header line: counts on the left, SSE connection state on the right. */
export function TapeHeader({ children, state }: { children: ReactNode; state: StreamState }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <p className="num min-w-0 truncate text-xs text-mute">{children}</p>
      <span className={`flex shrink-0 items-center gap-1.5 text-xs ${state === "live" ? "text-up" : "text-mute"}`} role="status">
        <span className={`size-1.5 rounded-full ${state === "live" ? "live-dot bg-up" : "bg-warn"}`} aria-hidden="true" />
        {state === "live" ? "live" : state === "connecting" ? "connecting…" : "reconnecting…"}
      </span>
    </div>
  );
}

/** Merged, newest-first feed of the agent's decisions (incl. skips with reasons) and orders. */
export function LiveTape({
  decisions,
  orders,
  fresh,
  state,
  now,
  showSkips,
}: {
  decisions: AgentDecisionDTO[];
  orders: AgentOrderDTO[];
  fresh: Set<string>;
  state: StreamState;
  now: number;
  showSkips: boolean;
}) {
  const items: Item[] = [
    ...decisions.filter((d) => showSkips || d.action !== "skip").map((d): Item => ({ kind: "decision", at: d.createdAt, d })),
    ...orders.map((o): Item => ({ kind: "order", at: o.filledAt ?? o.createdAt, o })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 80);

  return (
    <div className="card min-w-0">
      <TapeHeader state={state}>
        {decisions.length} decisions · {orders.length} orders · newest first
      </TapeHeader>
      {items.length === 0 ? (
        <div className="p-4">
          <EmptyState title="Nothing on the tape yet">
            Candidates the agent evaluates — including the ones it skips, with the reason — and its orders appear here as they
            happen.
          </EmptyState>
        </div>
      ) : (
        <ol className="max-h-[560px] divide-y divide-line overflow-y-auto" aria-live="polite">
          {items.map((it) =>
            it.kind === "decision" ? (
              <DecisionEntry key={`d${it.d.id}`} d={it.d} fresh={fresh.has(`d${it.d.id}`)} now={now} />
            ) : (
              <OrderEntry key={`o${it.o.id}`} o={it.o} fresh={fresh.has(`o${it.o.id}`)} now={now} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}
