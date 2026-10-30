import type { Buckets } from "@/server/profile/types";

const PALETTE = ["#c6ff3a", "#7cc4ff", "#b48cff", "#ffb648", "#35d48f", "#ff8fa3", "#8a939d", "#4b525b"];

const PRETTY: Record<string, string> = {
  pump_curve: "pump.fun curve",
  pumpswap: "PumpSwap",
  raydium: "Raydium",
  meteora: "Meteora",
  jupiter: "Jupiter",
  orca: "Orca",
  unknown: "Unknown",
};

/** Single stacked horizontal bar + legend (launchpad / venue mix). */
export function MixBar({ title, buckets }: { title: string; buckets: Buckets }) {
  const items = buckets.filter((b) => b.count > 0).sort((a, b) => b.count - a.count);
  const total = items.reduce((s, b) => s + b.count, 0);
  const starts = items.map((_, i) => items.slice(0, i).reduce((s, b) => s + (b.count / total) * 100, 0));
  const summary = items.map((b) => `${PRETTY[b.label] ?? b.label} ${Math.round((b.count / total) * 100)}%`).join(", ");

  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 flex items-baseline justify-between gap-2">
        <span className="eyebrow">{title}</span>
        <span className="num text-[11px] text-mute">n={total}</span>
      </figcaption>
      {total === 0 ? (
        <div className="flex h-3 items-center rounded-full border border-dashed border-line-2" aria-label={`${title}: no data`} />
      ) : (
        <svg role="img" aria-label={`${title}: ${summary}`} viewBox="0 0 100 6" preserveAspectRatio="none" className="block h-3 w-full overflow-hidden rounded-full">
          {items.map((b, i) => (
            <rect
              key={b.label}
              x={starts[i]}
              y="0"
              width={Math.max((b.count / total) * 100 - 0.3, 0.2)}
              height="6"
              fill={PALETTE[i % PALETTE.length]}
            />
          ))}
        </svg>
      )}
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {items.slice(0, 8).map((b, i) => (
          <li key={b.label} className="flex min-w-0 items-center gap-2 text-xs">
            <span className="size-2 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
            <span className="truncate text-ink-2">{PRETTY[b.label] ?? b.label}</span>
            <span className="num ml-auto text-mute">{Math.round((b.count / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
