"use client";

import Link from "next/link";
import { AvatarStack } from "@/components/ui/Avatar";
import { fmtDuration } from "@/lib/format";
import type { SwarmDTO } from "@/server/signals/types";
import { elapsed, memberFace, StageBadge } from "./SwarmCard";
import { useNow, useSwarmStream } from "./useSwarmStream";

/** Landing strip: the newest swarms, live from the SSE stream (active ones tick). */
export function SwarmTicker({ initial, serverNow }: { initial: SwarmDTO[]; serverNow: number }) {
  const { swarms, state, freshIds } = useSwarmStream(initial, 12);
  const now = useNow(serverNow);
  const activeCount = swarms.filter((s) => now - s.lastJoinAt < 1800).length;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <p className="flex items-center gap-2 text-xs text-ink-2">
          <span className={`size-1.5 rounded-full ${state === "live" ? "live-dot bg-up" : "bg-mute"}`} aria-hidden="true" />
          <span className="font-medium text-ink">Swarm radar</span>
          <span className="text-mute">
            · {activeCount > 0 ? `${activeCount} active` : "none active"} · 3+ tracked wallets into one token within 10 min
          </span>
        </p>
        <Link href="/swarms" className="shrink-0 text-xs text-ink-2 hover:text-accent">
          All swarms →
        </Link>
      </div>
      {swarms.length === 0 ? (
        <p className="px-4 py-5 text-sm text-mute">No swarms detected yet.</p>
      ) : (
        <ul className="flex snap-x gap-3 overflow-x-auto p-3 [scrollbar-width:thin]" aria-label="Recent swarms">
          {swarms.map((s) => {
            const active = now - s.lastJoinAt < 1800;
            return (
              <li key={s.id} className="snap-start">
                <Link
                  href={`/swarms#swarm-${s.id}`}
                  className={`flex w-64 flex-col gap-3 rounded-xl border p-3 transition-colors hover:border-white/25 ${
                    freshIds.has(s.id) ? "border-accent/50 bg-accent/[0.04]" : active ? "border-warn/30 bg-warn/[0.03]" : "border-line bg-white/[0.015]"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-ink">
                      {s.hidden || !s.token ? <span className="text-ink-2">Token hidden</span> : `$${s.token.symbol ?? s.token.mint.slice(0, 4)}`}
                    </span>
                    <StageBadge stage={s.stage} />
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <AvatarStack brains={[...s.memberList].sort((a, b) => a.at - b.at).map(memberFace)} size={24} max={6} />
                    <span className={`num text-[11px] ${active ? "text-warn" : "text-mute"}`}>
                      {active ? elapsed(now - s.startedAt) : `${fmtDuration(now - s.startedAt)} ago`}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
