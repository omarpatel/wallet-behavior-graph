import Link from "next/link";
import { fmtDuration } from "@/lib/format";
import type { SwarmDTO } from "@/server/signals/types";

/** "In a live swarm" chip for a brain that is a member of an active swarm (links to the swarm on /swarms). */
export function SwarmBadge({ swarm, now, className = "" }: { swarm: SwarmDTO; now: number; className?: string }) {
  const big = swarm.stage !== "forming";
  return (
    <Link
      href={`/swarms#swarm-${swarm.id}`}
      className={`chip relative z-10 gap-1.5 transition-colors ${big ? "border-warn/50 bg-warn/[0.06] text-warn hover:bg-warn/[0.1]" : "border-accent/40 text-accent hover:bg-accent/[0.06]"} ${className}`}
      title={`${swarm.members} tracked wallets first-bought the same token within 10 minutes; started ${fmtDuration(now - swarm.startedAt)} ago`}
    >
      <span className="live-dot size-1.5 rounded-full bg-current" aria-hidden="true" />
      In a live swarm · {swarm.members} wallets
      {swarm.token?.symbol ? <span className="num opacity-80">${swarm.token.symbol}</span> : null}
    </Link>
  );
}
