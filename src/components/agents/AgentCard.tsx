import Link from "next/link";
import type { AgentDTO } from "@/server/agents/types";
import { BrainAvatar } from "@/components/ui/Avatar";
import { Stat, toneFor } from "@/components/ui/primitives";
import { brainTitle } from "@/lib/identity";
import { AgentStatus, ModeBadge } from "./AgentBadges";
import { archetypeLabel, fmtSignedPct, fmtSignedSol, solOf } from "./lib";

export function AgentCard({ agent }: { agent: AgentDTO }) {
  return (
    <article className="card card-hover relative flex min-w-0 flex-col gap-4 p-5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <BrainAvatar brain={agent.brain} size={40} />
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold tracking-tight text-ink">
              <Link href={`/agents/${agent.id}`} className="hover:text-accent after:absolute after:inset-0 after:content-['']">
                {agent.name}
              </Link>
            </h3>
            <p className="truncate text-xs text-mute">in the style of {brainTitle(agent.brain)}</p>
          </div>
        </div>
        <ModeBadge mode={agent.mode} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AgentStatus status={agent.status} />
        <span className="chip max-w-full truncate">{archetypeLabel(agent.strategy.archetype)}</span>
      </div>
      {agent.status === "halted" && agent.haltedReason && <p className="text-xs text-warn">{agent.haltedReason}</p>}
      <dl className="grid grid-cols-2 gap-4">
        <Stat label="Equity" value={solOf(agent.equityLamports)} />
        <Stat
          label="PnL"
          value={fmtSignedPct(agent.pnlPct)}
          tone={toneFor(agent.pnlLamports)}
          hint={fmtSignedSol(agent.pnlLamports)}
        />
        <Stat label="Open positions" value={agent.openPositions} />
        <Stat label="Trades" value={agent.trades} />
      </dl>
    </article>
  );
}
