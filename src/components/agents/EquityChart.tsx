import { fmtSol, lamportsToSol } from "@/lib/format";

const W = 600;

/** Equity line (5-min samples) against the starting capital as a dashed baseline. Full-width SVG, server-renderable. */
export function EquityChart({
  points,
  baseLamports,
  height: H = 120,
}: {
  points: { t: number; equityLamports: number }[];
  baseLamports: number;
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <p className="flex items-center justify-center text-xs text-mute" style={{ height: H }}>
        Equity history appears after the first samples.
      </p>
    );
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const values = points.map((p) => p.equityLamports);
  const lo = Math.min(baseLamports, ...values);
  const hi = Math.max(baseLamports, ...values);
  const span = Math.max(1, hi - lo);
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - 4 - ((v - lo) / span) * (H - 8);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.equityLamports).toFixed(1)}`).join("");
  const last = values[values.length - 1];
  const up = last >= baseLamports;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height: H }}
      role="img"
      aria-label={`Equity from ${fmtSol(lamportsToSol(values[0]), 3)} to ${fmtSol(lamportsToSol(last), 3)} over ${points.length} samples`}
    >
      <line x1={0} x2={W} y1={y(baseLamports)} y2={y(baseLamports)} stroke="currentColor" strokeOpacity={0.18} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <path d={`${d}L${W} ${H}L0 ${H}Z`} className={up ? "fill-up/10" : "fill-down/10"} />
      <path d={d} fill="none" className={up ? "stroke-up" : "stroke-down"} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
