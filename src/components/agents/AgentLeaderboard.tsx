"use client";

import Link from "next/link";
import { useState } from "react";
import type { AgentLeaderboardDTO, AgentLeaderboardRow } from "@/server/agents/types";
import { BrainAvatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/primitives";
import { fmtDuration, fmtPct } from "@/lib/format";
import { brainTitle } from "@/lib/identity";
import { AgentStatus } from "./AgentBadges";
import { archetypeLabel, fmtSignedPct, fmtSignedSol, signClass } from "./lib";

/** Ranked agent table. `showBrain` = false on a brain's own page. */
export function AgentTable({ rows, showBrain = true }: { rows: AgentLeaderboardRow[]; showBrain?: boolean }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th className="w-8">#</th>
            <th>Agent</th>
            <th className="text-right">PnL</th>
            <th className="text-right">Trades</th>
            <th className="text-right" title="Closed positions with a realised profit">
              Win rate
            </th>
            <th className="text-right">Open</th>
            <th className="text-right">Age</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td className="num text-mute">{i + 1}</td>
              <td className="min-w-[12rem]">
                <div className="flex min-w-0 items-center gap-2.5">
                  {showBrain && <BrainAvatar brain={r.brain} size={28} />}
                  <div className="min-w-0">
                    <Link href={`/agents/${r.id}`} className="block truncate font-medium text-ink hover:text-accent">
                      {r.name}
                    </Link>
                    <p className="truncate text-[11px] text-mute">
                      {showBrain ? `${brainTitle(r.brain)} · ` : ""}
                      {archetypeLabel(r.archetype)}
                    </p>
                  </div>
                </div>
              </td>
              <td className="num whitespace-nowrap text-right">
                <span className={signClass(r.pnlPct)}>{fmtSignedPct(r.pnlPct)}</span>
                <span className="block text-[11px] text-mute">{fmtSignedSol(r.pnlLamports)}</span>
              </td>
              <td className="num text-right text-ink-2">{r.trades}</td>
              <td className="num text-right text-ink-2">{fmtPct(r.winRate)}</td>
              <td className="num text-right text-ink-2">{r.openPositions}</td>
              <td className="num whitespace-nowrap text-right text-mute">{fmtDuration(r.ageSec)}</td>
              <td>
                <AgentStatus status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Paper and live agents are never ranked together: two tabs over the same table. */
export function AgentLeaderboardTabs({ data, showBrain = true }: { data: AgentLeaderboardDTO; showBrain?: boolean }) {
  const [tab, setTab] = useState<"paper" | "live">("paper");
  const rows = data[tab];
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Agent mode" className="inline-flex rounded-lg border border-line-2 p-0.5">
        {(["paper", "live"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={tab === m}
            onClick={() => setTab(m)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${tab === m ? "bg-white/[0.08] text-ink" : "text-mute hover:text-ink-2"}`}
          >
            {m === "paper" ? "Paper" : "Live"} <span className="num text-xs text-mute">{data[m].length}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={tab === "paper" ? "No paper agents yet" : "No live agents yet"}>
          {tab === "paper"
            ? "Seat holders can create an agent from a brain's page; it starts in paper mode."
            : "Live mode is an explicit opt-in by an agent's owner."}
        </EmptyState>
      ) : (
        <AgentTable rows={rows} showBrain={showBrain} />
      )}
      <p className="text-[11px] leading-relaxed text-mute">
        {tab === "paper"
          ? "Paper PnL is simulated at real market prices and leaves out failed transactions, latency and most execution costs."
          : "Live PnL is equity against net deposits, marked at the latest price; open positions may not be sellable at that price."}{" "}
        Past results of an agent say nothing about future results and are not advice.
      </p>
    </div>
  );
}
