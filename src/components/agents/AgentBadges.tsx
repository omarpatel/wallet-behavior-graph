import type { AgentDTO } from "@/server/agents/types";
import { StatusPill } from "@/components/ui/badges";
import { STATUS_LABEL, STATUS_TONE } from "./lib";

export function ModeBadge({ mode }: { mode: AgentDTO["mode"] }) {
  return mode === "live" ? (
    <span className="chip border-warn/50 bg-warn/[0.08] font-medium text-warn" title="Trades real SOL from a server-held wallet">
      Live
    </span>
  ) : (
    <span className="chip border-info/40 text-info" title="Simulated SOL at real market prices">
      Paper
    </span>
  );
}

export function AgentStatus({ status }: { status: AgentDTO["status"] }) {
  return (
    <StatusPill tone={STATUS_TONE[status]}>
      <span className={`size-1.5 rounded-full bg-current ${status === "running" ? "live-dot" : ""}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </StatusPill>
  );
}
