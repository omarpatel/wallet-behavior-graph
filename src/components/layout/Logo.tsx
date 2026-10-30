/** Mark (a small wallet graph; same geometry as src/app/icon.svg) + wordmark. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width="24" height="24" viewBox="6 4 52 54" aria-hidden="true" className="text-accent">
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.7">
          <line x1="14" y1="20" x2="32" y2="12" />
          <line x1="32" y1="12" x2="50" y2="24" />
          <line x1="14" y1="20" x2="30" y2="34" />
          <line x1="32" y1="12" x2="30" y2="34" />
          <line x1="50" y1="24" x2="30" y2="34" />
          <line x1="30" y1="34" x2="18" y2="50" />
          <line x1="30" y1="34" x2="46" y2="50" />
          <line x1="50" y1="24" x2="46" y2="50" />
        </g>
        <g fill="currentColor">
          <circle cx="14" cy="20" r="4.5" />
          <circle cx="32" cy="12" r="4.5" />
          <circle cx="50" cy="24" r="4.5" />
          <circle cx="30" cy="34" r="7" />
          <circle cx="18" cy="50" r="4.5" />
          <circle cx="46" cy="50" r="4.5" />
        </g>
      </svg>
      {!compact && (
        <span className="font-mono text-[13px] font-semibold tracking-[0.22em] text-ink">
          WALLET<span className="text-accent"> </span>GRAPH
        </span>
      )}
    </span>
  );
}
