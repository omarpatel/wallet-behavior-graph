import { fmtUsd } from "@/lib/format";

/**
 * Daily bars around a zero baseline (green up / red down), e.g. realized PnL per day. Pure SVG, server-rendered.
 * `start` = unix s of the first bar's UTC day (for the accessible summary). Bars are drawn as one path per colour:
 * per-bar <rect>s (+ titles) made a 100-row leaderboard ~1.4 MB because RSC sends the markup twice.
 */
export function Sparkline({
  values,
  start,
  width = 96,
  height = 28,
  label = "Daily realized PnL",
}: {
  values: number[];
  start: number;
  width?: number;
  height?: number;
  label?: string;
}) {
  const max = Math.max(1e-9, ...values.map((v) => Math.abs(v)));
  const n = values.length;
  const gap = 1;
  const bw = Math.max(1, (width - gap * (n - 1)) / n);
  const mid = height / 2;
  const active = values.filter((v) => v !== 0).length;
  const total = values.reduce((a, b) => a + b, 0);
  const firstDay = new Date(start * 1000).toISOString().slice(5, 10);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  let up = "";
  let down = "";
  values.forEach((v, i) => {
    if (v === 0) return;
    const h = Math.max(1, (Math.abs(v) / max) * (mid - 1));
    const bar = `M${r1(i * (bw + gap))} ${r1(v > 0 ? mid - h : mid)}h${r1(bw)}v${r1(h)}h${r1(-bw)}z`;
    if (v > 0) up += bar;
    else down += bar;
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}: ${active} active days, net ${fmtUsd(total)} over ${n} days from ${firstDay}`}
      className="block overflow-visible"
    >
      <line x1={0} x2={width} y1={mid} y2={mid} stroke="currentColor" strokeOpacity={0.12} strokeWidth={1} />
      {up && <path d={up} className="fill-up" />}
      {down && <path d={down} className="fill-down" />}
    </svg>
  );
}
