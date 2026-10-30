"use client";

import { EmptyState } from "@/components/ui/primitives";
import { fmtDuration } from "@/lib/format";
import type { SwarmDTO } from "@/server/signals/types";
import { SwarmCard } from "./SwarmCard";
import { useNow, useSwarmStream, type StreamState } from "./useSwarmStream";

function StreamPill({ state }: { state: StreamState }) {
  const live = state === "live";
  return (
    <span className={`chip ${live ? "border-up/40 text-up" : "border-line-2 text-mute"}`} role="status">
      <span className={`size-1.5 rounded-full ${live ? "live-dot bg-up" : "bg-mute"}`} aria-hidden="true" />
      {live ? "streaming" : state === "connecting" ? "connecting…" : "reconnecting…"}
    </span>
  );
}

/** /swarms body: active swarms on top (live timers), recent ones below; updated from the SSE stream. */
export function SwarmsLive({ initial, serverNow }: { initial: SwarmDTO[]; serverNow: number }) {
  const { swarms, state, freshIds } = useSwarmStream(initial, 80);
  const now = useNow(serverNow);
  const active = swarms.filter((s) => s.active || now - s.lastJoinAt < 1800);
  const recent = swarms.filter((s) => !active.includes(s));
  const last = swarms[0];

  return (
    <div className="space-y-12">
      <section aria-labelledby="active-swarms" className="space-y-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="eyebrow mb-1.5">Last member within 30 minutes</p>
            <h2 id="active-swarms" className="text-lg font-semibold tracking-tight text-ink">
              Active now
            </h2>
          </div>
          <StreamPill state={state} />
        </div>
        {active.length === 0 ? (
          <EmptyState title="No active swarm right now">
            {last
              ? `The last one started ${fmtDuration(now - last.startedAt)} ago. New swarms appear here the moment a third tracked wallet buys in.`
              : "New swarms appear here the moment a third tracked wallet buys the same token within 10 minutes."}
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {active.map((s) => (
              <SwarmCard key={s.id} swarm={s} now={now} fresh={freshIds.has(s.id)} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="recent-swarms" className="space-y-4">
        <div>
          <p className="eyebrow mb-1.5">Newest first</p>
          <h2 id="recent-swarms" className="text-lg font-semibold tracking-tight text-ink">
            Recent swarms
          </h2>
        </div>
        {recent.length === 0 ? (
          <EmptyState title="No past swarms yet">Swarms are detected from first buys across every tracked wallet.</EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {recent.map((s) => (
              <SwarmCard key={s.id} swarm={s} now={now} fresh={freshIds.has(s.id)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
