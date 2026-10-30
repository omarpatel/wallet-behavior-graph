export const DISCLAIMER =
  "Educational analysis of public on-chain activity. Not investment, financial, legal or tax advice. No recommendation to buy or sell. You may lose all funds.";

export function Disclaimer({ className = "", compact = false }: { className?: string; compact?: boolean }) {
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
      <span>{DISCLAIMER}</span>
    </p>
  );
}
