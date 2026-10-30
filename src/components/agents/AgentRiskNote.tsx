import Link from "next/link";

export const AGENT_RISK =
  "Agents are automated programs, not advice: no recommendation, no guarantee of any result. Paper results are simulated. Live agents are custodial — our server holds the agent wallet's key — and you can lose everything you deposit. You can withdraw the agent's SOL to your wallet at any time.";

/** Agent-specific risk note (custodial keys, total-loss risk, not advice, withdraw any time). */
export function AgentRiskNote({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  return (
    <p
      role="note"
      className={`flex gap-2 rounded-lg border border-warn/20 bg-warn/[0.04] text-warn/90 ${
        compact ? "px-2.5 py-1.5 text-[11px] leading-snug" : "px-3 py-2.5 text-xs leading-relaxed"
      } ${className}`}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="mt-px shrink-0">
        <path d="M8 1.5 15 14H1L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 6v3.6M8 11.4v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span>
        {AGENT_RISK}{" "}
        <Link href="/disclaimer#agents" className="underline decoration-warn/40 hover:text-warn">
          Details
        </Link>
      </span>
    </p>
  );
}
