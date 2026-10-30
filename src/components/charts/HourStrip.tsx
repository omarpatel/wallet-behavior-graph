/** 24-cell UTC activity heat strip. */
export function HourStrip({ hours, sessionWindow }: { hours: number[]; sessionWindow: string | null }) {
  const counts = Array.from({ length: 24 }, (_, h) => hours[h] ?? 0);
  const total = counts.reduce((s, c) => s + c, 0);
  const max = Math.max(1, ...counts);
  const busiest = counts
    .map((c, h) => ({ c, h }))
    .sort((a, b) => b.c - a.c)
    .slice(0, 3)
    .filter((x) => x.c > 0)
    .map((x) => `${String(x.h).padStart(2, "0")}:00`);
  const label = total
    ? `Trading activity by UTC hour. Busiest hours: ${busiest.join(", ")}.${sessionWindow ? ` Session window ${sessionWindow}.` : ""}`
    : "Trading activity by UTC hour: no data.";

  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 flex items-baseline justify-between gap-2">
        <span className="eyebrow">24h activity (UTC)</span>
        <span className="num text-[11px] text-mute">{sessionWindow ?? "no single session"}</span>
      </figcaption>
      <svg role="img" aria-label={label} viewBox="0 0 240 28" preserveAspectRatio="none" className="block h-9 w-full">
        {counts.map((c, h) => (
          <rect
            key={h}
            x={h * 10 + 0.5}
            y="0"
            width="9"
            height="28"
            rx="1.5"
            fill={c === 0 ? "var(--color-panel-2)" : "var(--color-accent)"}
            fillOpacity={c === 0 ? 1 : 0.12 + 0.88 * (c / max)}
          >
            <title>{`${String(h).padStart(2, "0")}:00 UTC — ${c} trades`}</title>
          </rect>
        ))}
      </svg>
      <div className="num mt-1.5 flex justify-between text-[10px] text-mute" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </figure>
  );
}
