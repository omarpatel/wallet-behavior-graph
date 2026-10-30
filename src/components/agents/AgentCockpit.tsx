"use client";

import Link from "next/link";
import { useState } from "react";
import type { AgentDetailDTO } from "@/server/agents/types";
import { useNow } from "@/components/swarms/useSwarmStream";
import { BrainAvatar } from "@/components/ui/Avatar";
import { SectionTitle, Stat, toneFor } from "@/components/ui/primitives";
import { timeAgo } from "@/lib/format";
import { brainTitle } from "@/lib/identity";
import { AgentControls } from "./AgentControls";
import { AgentRiskNote } from "./AgentRiskNote";
import { AgentStatus, ModeBadge } from "./AgentBadges";
import { EquityChart } from "./EquityChart";
import { FundsPanel } from "./FundsPanel";
import { LiveTape } from "./LiveTape";
import { fmtSignedPct, fmtSignedSol, solOf } from "./lib";
import { ClosedPositions, OpenPositions, TradesTable } from "./PositionsTables";
import { StrategyPanel } from "./StrategyPanel";
import { useAgentStream } from "./useAgentStream";

/** Agent cockpit: owners get controls and funds; everyone else sees the same agent read-only. */
export function AgentCockpit({ initial, serverNow }: { initial: AgentDetailDTO; serverNow: number }) {
  const { detail: a, state, fresh, setAgent } = useAgentStream(initial);
  const now = useNow(serverNow);
  const [showSkips, setShowSkips] = useState(true);
  const open = a.positions.filter((p) => p.status === "open");
  const closed = a.positions.filter((p) => p.status === "closed");
  const history = [...a.equityHistory, { t: now, equityLamports: a.equityLamports }];

  return (
    <div className="space-y-8 pb-16">
      <header className="flex flex-col gap-6 pt-10 sm:pt-14 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Link href={`/brains/${a.brainId}`} className="shrink-0" aria-label={`Brain ${brainTitle(a.brain)}`}>
            <BrainAvatar brain={a.brain} size={64} priority />
          </Link>
          <div className="min-w-0">
            <p className="eyebrow">{a.isOwner ? "Your agent" : "Agent"}</p>
            <h1 className="mt-1 truncate font-display text-4xl leading-none tracking-tight text-ink sm:text-5xl">{a.name}</h1>
            <p className="mt-2 text-sm text-ink-2">
              Trades in the style of{" "}
              <Link href={`/brains/${a.brainId}`} className="text-ink underline decoration-line-2 hover:text-accent">
                {brainTitle(a.brain)}
              </Link>{" "}
              <span className="text-mute">· does not copy its wallet · created {timeAgo(a.createdAt, now)}</span>
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ModeBadge mode={a.mode} />
              <AgentStatus status={a.status} />
              {a.useLlm && <span className="chip">LLM judge on</span>}
            </div>
          </div>
        </div>
      </header>

      {a.status === "halted" && (
        <div role="alert" className="rounded-xl border border-warn/30 bg-warn/[0.05] px-4 py-3 text-sm">
          <p className="font-medium text-warn">Agent halted</p>
          <p className="mt-1 text-xs text-ink-2">{a.haltedReason ?? "A safety limit stopped the agent."}</p>
        </div>
      )}

      <section aria-label="Performance" className="card p-5">
        <dl className="grid grid-cols-2 gap-5 sm:grid-cols-5">
          <Stat label="Equity" value={solOf(a.equityLamports)} size="lg" />
          <Stat label="PnL" value={fmtSignedPct(a.pnlPct)} tone={toneFor(a.pnlLamports)} hint={fmtSignedSol(a.pnlLamports)} size="lg" />
          <Stat label={a.mode === "live" ? "Free SOL" : "Free SOL (sim)"} value={solOf(a.balanceLamports)} />
          <Stat label="Open positions" value={a.openPositions} />
          <Stat label="Trades" value={a.trades} />
        </dl>
        <div className="mt-5 text-mute">
          <EquityChart points={history} baseLamports={a.capitalLamports} />
          <p className="mt-1 text-[11px] text-mute">Equity, last 7 days · dashed line = starting capital</p>
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-10">
          <section aria-labelledby="tape" className="space-y-3">
            <SectionTitle
              id="tape"
              eyebrow="Every candidate and order, as it happens"
              aside={
                <label className="flex cursor-pointer items-center gap-2 text-xs text-mute">
                  <input type="checkbox" className="accent-[var(--color-accent)]" checked={showSkips} onChange={(e) => setShowSkips(e.target.checked)} />
                  show skips
                </label>
              }
            >
              Live tape
            </SectionTitle>
            <LiveTape decisions={a.decisions} orders={a.orders} fresh={fresh} state={state} now={now} showSkips={showSkips} />
          </section>

          <section aria-labelledby="positions" className="space-y-3">
            <SectionTitle id="positions" eyebrow={`${open.length} open`}>
              Positions
            </SectionTitle>
            <OpenPositions positions={open} now={now} />
            {closed.length > 0 && (
              <div className="pt-2">
                <h3 className="eyebrow mb-3">Recently closed</h3>
                <ClosedPositions positions={closed} now={now} />
              </div>
            )}
          </section>

          <section aria-labelledby="trades" className="space-y-3">
            <SectionTitle id="trades" eyebrow={a.mode === "live" ? "Live fills link to Solscan" : "Simulated fills at real prices"}>
              Trades
            </SectionTitle>
            <TradesTable orders={a.orders} now={now} />
          </section>

          <StrategyPanel agent={a} isOwner={a.isOwner} onChange={setAgent} />
        </div>

        <aside className="order-first min-w-0 space-y-4 lg:sticky lg:top-20 lg:order-none lg:self-start">
          {a.isOwner && <AgentControls agent={a} onChange={setAgent} />}
          <FundsPanel agent={a} now={now} />
          <AgentRiskNote />
        </aside>
      </div>
    </div>
  );
}
