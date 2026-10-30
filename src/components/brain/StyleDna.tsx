import { BucketBars, type BarTone } from "@/components/charts/BucketBars";
import { HourStrip } from "@/components/charts/HourStrip";
import { MixBar } from "@/components/charts/MixBar";
import { ArchetypeChip } from "@/components/ui/badges";
import { dexscreenerToken } from "@/components/ui/links";
import { ExternalLink, SectionTitle, Stat, toneFor } from "@/components/ui/primitives";
import { fmtDuration, fmtPct, fmtSol, fmtUsd } from "@/lib/format";
import type { BrainProfile, TokenResult } from "@/server/profile/types";

const fmtX = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(d)}`);

function pnlTones(labels: string[]): BarTone[] {
  // Loss buckets start with a minus sign or "<"; gains use en-dash ranges ("2–5x").
  return labels.map((l) => (/^[<−-]|<\s*[−-]/.test(l.trim()) ? "down" : "up"));
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
}

function CopyabilityGauge({ score }: { score: number | null }) {
  const v = score == null ? 0 : Math.max(0, Math.min(100, score));
  const r = 34;
  const c = Math.PI * r;
  return (
    <svg viewBox="0 0 84 48" className="h-[66px] w-[116px] shrink-0" role="img" aria-label={`Copyability score ${score == null ? "not available" : `${Math.round(v)} of 100`}`}>
      <path d={`M8 44 A${r} ${r} 0 0 1 76 44`} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="7" strokeLinecap="round" />
      {score != null && (
        <path
          d={`M8 44 A${r} ${r} 0 0 1 76 44`}
          fill="none"
          stroke={v >= 60 ? "var(--color-up)" : v >= 35 ? "var(--color-warn)" : "var(--color-down)"}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
        />
      )}
      <text x="42" y="42" textAnchor="middle" className="num" fontSize="15" fill="var(--color-ink)">
        {score == null ? "—" : Math.round(v)}
      </text>
    </svg>
  );
}

function TokenTable({ title, rows, empty }: { title: string; rows: TokenResult[]; empty: string }) {
  return (
    <div className="min-w-0">
      <h4 className="eyebrow mb-2">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-mute">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col" className="text-right">
                  Cost
                </th>
                <th scope="col" className="text-right">
                  Realized
                </th>
                <th scope="col" className="text-right">
                  ROI
                </th>
                <th scope="col" className="text-right">
                  Hold
                </th>
                <th scope="col" className="text-right">
                  Entry MC
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.mint}>
                  <td className="max-w-[9rem]">
                    <ExternalLink href={dexscreenerToken(t.mint)} className="truncate text-ink">
                      {t.symbol ?? `${t.mint.slice(0, 4)}…`}
                    </ExternalLink>
                    {t.open && <span className="ml-1.5 text-[10px] text-mute">open</span>}
                  </td>
                  <td className="num text-right text-ink-2">{fmtUsd(t.buyUsd)}</td>
                  <td className={`num text-right ${t.realizedUsd >= 0 ? "text-up" : "text-down"}`}>{fmtUsd(t.realizedUsd)}</td>
                  <td className={`num text-right ${toneFor(t.roi) === "down" ? "text-down" : "text-ink-2"}`}>{fmtPct(t.roi)}</td>
                  <td className="num text-right text-ink-2">{fmtDuration(t.holdSec)}</td>
                  <td className="num text-right text-ink-2">{fmtUsd(t.entryMcUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StyleDna({ profile }: { profile: BrainProfile }) {
  const p = profile;
  return (
    <section aria-labelledby="dna" className="space-y-4">
      <SectionTitle id="dna" eyebrow={`Trailing ${p.windowDays} days · ${p.sample.trades} trades · ${p.sample.tokens} tokens`}>
        Style DNA
      </SectionTitle>

      <Panel>
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <p className="eyebrow mb-2">Primary archetype</p>
            <p className="font-display text-3xl leading-tight text-ink">{p.archetype.label}</p>
            <p className="num mt-2 text-xs leading-relaxed text-ink-2">{p.archetype.reason}</p>
            {!p.rated && (
              <p className="mt-3 text-xs text-warn">Thin sample (needs ≥20 trades and ≥5 tokens): no archetype or tier is assigned.</p>
            )}
          </div>
          <div>
            <p className="eyebrow mb-2">Flags · deterministic rules, numbers shown</p>
            {p.flags.length === 0 ? (
              <p className="text-xs text-mute">No overlay flag thresholds met.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {p.flags.map((f) => (
                  <li key={f.id} className="rounded-lg border border-line bg-bg-2/60 p-2.5">
                    <ArchetypeChip label={f.label} />
                    <p className="num mt-1.5 text-[11px] leading-snug text-mute">{f.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <BucketBars title="PnL by token (ROI bucket)" buckets={p.pnl.buckets} tones={pnlTones(p.pnl.buckets.map((b) => b.label))} />
          <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
            <Stat size="sm" label="Realized" value={fmtUsd(p.pnl.realizedUsd)} tone={toneFor(p.pnl.realizedUsd)} hint={fmtSol(p.pnl.realizedSol)} />
            <Stat size="sm" label="ROI" value={fmtPct(p.pnl.roi, 1)} tone={toneFor(p.pnl.roi)} hint={`cost ${fmtUsd(p.pnl.costUsd)}`} />
            <Stat
              size="sm"
              label="Win rate"
              value={fmtPct(p.pnl.winRate)}
              hint={`${p.pnl.closedPositions} closed · PF ${fmtX(p.pnl.profitFactor, 2)}`}
            />
          </dl>
        </Panel>
        <Panel>
          <BucketBars title="Entry delay after token launch" buckets={p.timing.buckets} />
          <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
            <Stat size="sm" label="Median" value={fmtDuration(p.timing.medianEntryDelaySec)} hint={`IQR ${fmtDuration(p.timing.p25EntryDelaySec)}–${fmtDuration(p.timing.p75EntryDelaySec)}`} />
            <Stat size="sm" label="On curve" value={fmtPct(p.timing.preGraduationShare)} hint="pump.fun pre-graduation" />
            <Stat size="sm" label="First minute" value={fmtPct(p.timing.firstMinuteShare)} />
          </dl>
        </Panel>
        <Panel>
          <BucketBars title="Entry market cap" buckets={p.entryMc.buckets} />
          <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
            <Stat size="sm" label="Median MC" value={fmtUsd(p.entryMc.medianUsd)} />
            <Stat size="sm" label="Median buy" value={fmtUsd(p.sizing.medianBuyUsd)} hint={fmtSol(p.sizing.medianBuySol, 3)} />
            <Stat size="sm" label="Avg buy" value={fmtUsd(p.sizing.avgBuyUsd)} />
          </dl>
        </Panel>
        <Panel>
          <BucketBars title="Hold time (first buy → first sell)" buckets={p.hold.buckets} />
          <dl className="mt-5 grid grid-cols-4 gap-3 border-t border-line pt-4">
            <Stat size="sm" label="Median" value={fmtDuration(p.hold.medianHoldSec)} />
            <Stat size="sm" label="≤5s flips" value={fmtPct(p.hold.flashFlipShare)} />
            <Stat size="sm" label="Out <5m" value={fmtPct(p.hold.soldWithin5mShare)} />
            <Stat size="sm" label="Out <24h" value={fmtPct(p.hold.soldWithin24hShare)} />
          </dl>
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel className="md:col-span-2">
          <HourStrip hours={p.activity.hourHistogramUtc} sessionWindow={p.activity.sessionWindowUtc} />
          <div className="mt-6 grid gap-6 sm:grid-cols-2">
            <MixBar title="Launchpad mix" buckets={p.coinMix.launchpads} />
            <MixBar title="Venue mix" buckets={p.coinMix.venues} />
          </div>
        </Panel>
        <Panel>
          <p className="eyebrow">Copyability</p>
          <div className="mt-3 flex flex-col gap-3">
            <CopyabilityGauge score={p.copyability.score} />
            <p className="text-xs leading-relaxed text-ink-2">{p.copyability.reason}</p>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4">
            <Stat size="sm" label="Trades / day" value={fmtX(p.activity.tradesPerDay)} />
            <Stat size="sm" label="Active days" value={p.sample.activeDays} />
          </dl>
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <p className="eyebrow mb-3">Sizing</p>
          <dl className="grid grid-cols-3 gap-3">
            <Stat size="sm" label="Style" value={p.sizing.style ?? "—"} />
            <Stat size="sm" label="CV σ/μ" value={fmtX(p.sizing.cv, 2)} hint="<0.5 fixed · >1 conviction" />
            <Stat size="sm" label="Buys / token" value={fmtX(p.exits.avgBuysPerToken)} />
          </dl>
        </Panel>
        <Panel>
          <p className="eyebrow mb-3">Exits (share of positions)</p>
          <dl className="grid grid-cols-4 gap-3">
            <Stat size="sm" label="Full dump" value={fmtPct(p.exits.fullDumpShare)} hint="≥90% in 1 tx" />
            <Stat size="sm" label="Ladder" value={fmtPct(p.exits.ladderShare)} hint="≥3 sells" />
            <Stat size="sm" label="Initials" value={fmtPct(p.exits.initialsOutShare)} hint="cost back" />
            <Stat size="sm" label="Stop-out" value={fmtPct(p.exits.stopOutShare)} hint="first sell ≤ −30%" />
          </dl>
        </Panel>
      </div>

      <Panel>
        <div className="grid gap-8">
          <TokenTable title="Top wins" rows={p.topWins} empty="No realized wins in window." />
          <TokenTable title="Top losses" rows={p.topLosses} empty="No realized losses in window." />
        </div>
      </Panel>
    </section>
  );
}
