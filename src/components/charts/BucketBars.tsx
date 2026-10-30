import type { Buckets } from "@/server/profile/types";

export type BarTone = "accent" | "up" | "down" | "mute" | "info";

const FILL: Record<BarTone, string> = {
  accent: "var(--color-accent)",
  up: "var(--color-up)",
  down: "var(--color-down)",
  mute: "var(--color-faint)",
  info: "var(--color-info)",
};

/**
 * Vertical bucket histogram. Bars are SVG (stretched to the container width);
 * labels are HTML so they stay legible at any size.
 */
export function BucketBars({
  title,
  buckets,
  tones,
  highlight,
  height = 112,
  note,
}: {
  title: string;
  buckets: Buckets;
  /** Per-bucket colour; defaults to accent for the largest bucket and muted info for the rest. */
  tones?: BarTone[];
  /** Index of the bucket to emphasise (e.g. where the median falls). */
  highlight?: number;
  height?: number;
  note?: string;
}) {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const peak = buckets.findIndex((b) => b.count === max);
  const n = buckets.length;
  const gap = 6;
  const w = 100;
  const colW = (w - gap * (n - 1)) / n;
  const summary = buckets
    .map((b) => `${b.label}: ${b.count}${total ? ` (${Math.round((b.count / total) * 100)}%)` : ""}`)
    .join(", ");

  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 flex items-baseline justify-between gap-2">
        <span className="eyebrow">{title}</span>
        <span className="num text-[11px] text-mute">n={total}</span>
      </figcaption>
      {total === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-line-2 text-xs text-mute" style={{ height }}>
          No data in window
        </div>
      ) : (
        <>
          <svg
            role="img"
            aria-label={`${title}. ${summary}`}
            viewBox={`0 0 ${w} ${height}`}
            preserveAspectRatio="none"
            className="block w-full overflow-visible"
            style={{ height }}
          >
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1="0" x2={w} y1={height * f} y2={height * f} stroke="var(--color-line)" vectorEffect="non-scaling-stroke" />
            ))}
            <line x1="0" x2={w} y1={height - 0.5} y2={height - 0.5} stroke="var(--color-line-2)" vectorEffect="non-scaling-stroke" />
            {buckets.map((b, i) => {
              const h = b.count === 0 ? 0 : Math.max(2, (b.count / max) * (height - 4));
              const tone = tones?.[i] ?? (i === (highlight ?? peak) ? "accent" : "info");
              const emph = highlight === undefined || i === highlight;
              return (
                <rect
                  key={b.label}
                  x={i * (colW + gap)}
                  y={height - h}
                  width={colW}
                  height={h}
                  fill={FILL[tone]}
                  fillOpacity={tones ? 0.85 : emph ? 0.9 : 0.35}
                >
                  <title>{`${b.label}: ${b.count}`}</title>
                </rect>
              );
            })}
          </svg>
          <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }} aria-hidden="true">
            {buckets.map((b) => (
              <div key={b.label} className="min-w-0 text-center">
                <div className="num text-[11px] text-ink-2">{total ? `${Math.round((b.count / total) * 100)}%` : "—"}</div>
                <div className="truncate text-[10px] leading-tight text-mute" title={b.label}>
                  {b.label}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {note && <p className="mt-3 text-[11px] leading-snug text-mute">{note}</p>}
    </figure>
  );
}
