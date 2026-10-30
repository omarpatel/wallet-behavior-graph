import { EmptyState, ExternalLink, SectionTitle, Stat, toneFor } from "@/components/ui/primitives";
import { fmtDuration, fmtPct, fmtUsd } from "@/lib/format";
import { SOURCE_LABEL } from "@/lib/identity";
import type { DirectorySource, ExternalStats, SourceStats, StudyRecord } from "@/server/directory/types";
import type { WindowStats } from "@/server/snapshots/leaderboard";

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const signed = (v: number | null) => (v != null && v > 0 ? `+${fmtUsd(v)}` : fmtUsd(v));

/**
 * The wallet directory's own published figures for this wallet (their method, their snapshot), next to our own
 * realized numbers from indexed trades. Nothing here is recomputed: the as-of date is the directory's snapshot.
 */
export function DirectoryListings({
  stats,
  sources,
  ours,
}: {
  stats: ExternalStats;
  sources: DirectorySource[];
  ours: { "7d": WindowStats; "30d": WindowStats } | null;
}) {
  const cards = stats.listing ? [{ id: "directory" as const, s: stats.listing, src: sources.find((x) => x.source === "directory") ?? null }] : [];
  const score = stats.directory;
  if (cards.length === 0 && !score) return null;

  return (
    <section aria-labelledby="directory" className="space-y-4">
      <SectionTitle id="directory" eyebrow="As published by each directory · not recomputed">
        Directory listings
      </SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map(({ id, s, src }) => (
          <SourceCard key={id} label={SOURCE_LABEL[id]} stats={s} source={src} />
        ))}
        {ours && (
          <div className="card border-accent/20 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Wallet Behavior Graph index</h3>
              <span className="eyebrow">our trades</span>
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-3">
              <Stat size="sm" label="PnL 7d" value={signed(ours["7d"].realizedUsd)} tone={toneFor(ours["7d"].realizedUsd)} />
              <Stat size="sm" label="PnL 30d" value={signed(ours["30d"].realizedUsd)} tone={toneFor(ours["30d"].realizedUsd)} />
              <Stat size="sm" label="Win 30d" value={fmtPct(ours["30d"].winRate)} />
              <Stat size="sm" label="W / L 30d" value={`${ours["30d"].wins} / ${ours["30d"].losses}`} />
              <Stat size="sm" label="Trades 30d" value={ours["30d"].trades.toLocaleString("en-US")} />
              <Stat size="sm" label="Med. hold" value={fmtDuration(ours["30d"].medianHoldSec)} />
            </dl>
            <p className="mt-3 text-[11px] text-mute">Realized on average cost from trades we index on-chain; live.</p>
          </div>
        )}
      </div>
      {score && score.value != null && (
        <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div
              className="num flex size-12 items-center justify-center rounded-full border border-line-2 text-lg font-medium text-ink"
              style={{ background: `conic-gradient(var(--color-accent) ${score.value * 3.6}deg, rgb(255 255 255 / 0.05) 0)` }}
              aria-hidden="true"
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-bg">{Math.round(score.value)}</span>
            </div>
            <div>
              <p className="text-sm font-medium text-ink">Directory score {Math.round(score.value)}/100</p>
              <p className="text-[11px] text-mute">Merged from the directories&apos; published stats · {day(score.asOf)}</p>
            </div>
          </div>
          <div className="flex flex-1 flex-wrap gap-1.5 sm:justify-end">
            {score.tags.map((t) => (
              <span key={t} className="chip text-[11px]">
                {t}
              </span>
            ))}
          </div>
          {score.notes.length > 0 && (
            <ul className="text-[11px] text-ink-2 sm:hidden">
              {score.notes.slice(0, 3).map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function SourceCard({ label, stats: s, source }: { label: string; stats: SourceStats; source: DirectorySource | null }) {
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          {source?.url ? (
            <ExternalLink href={source.url} className="text-ink">
              {label}
            </ExternalLink>
          ) : (
            label
          )}
          {source?.rank != null && <span className="num text-xs font-normal text-mute">#{source.rank}</span>}
        </h3>
        <span className="num text-[11px] text-mute" title="Snapshot date of the directory's figures">
          as of {day(s.asOf)}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        <Stat size="sm" label="PnL 1d" value={signed(s.pnl1dUsd)} tone={toneFor(s.pnl1dUsd)} />
        <Stat size="sm" label="PnL 7d" value={signed(s.pnl7dUsd)} tone={toneFor(s.pnl7dUsd)} />
        <Stat size="sm" label="PnL 30d" value={signed(s.pnl30dUsd)} tone={toneFor(s.pnl30dUsd)} />
        <Stat size="sm" label="Win 7d" value={fmtPct(s.winRate7d)} />
        <Stat size="sm" label="Win 30d" value={fmtPct(s.winRate30d)} />
        <Stat
          size="sm"
          label={s.trades30d != null ? "Trades 30d" : "Trades 7d"}
          value={(s.trades30d ?? s.trades7d)?.toLocaleString("en-US") ?? "—"}
          hint={s.avgHoldSecs != null ? `avg hold ${fmtDuration(s.avgHoldSecs)}` : undefined}
        />
      </dl>
    </div>
  );
}

/** Early-entry study record (pump.fun launches) for this wallet, from the directory file. */
export function RunnerRecord({ study }: { study: StudyRecord | undefined }) {
  if (!study) return null;
  const runners = study.earlyRunners ?? 0;
  const mid = study.earlyMidfails ?? 0;
  const fails = study.earlyFails ?? 0;
  const total = runners + mid + fails;
  const seg = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%");

  return (
    <section aria-labelledby="runners" className="space-y-4">
      <SectionTitle id="runners" eyebrow="Early-entry study · pump.fun launches">
        Runner record
      </SectionTitle>
      <div className="card p-5">
        <div className="grid gap-6 sm:grid-cols-[1fr_1.3fr] sm:items-center">
          <div className="flex items-center gap-4">
            <div>
              <p className="eyebrow">Hit rate</p>
              <p className="num mt-1 text-4xl font-medium text-accent">{fmtPct(study.hitRate)}</p>
              <p className="mt-1 text-[11px] text-mute">early entries that became runners</p>
            </div>
          </div>
          <div>
            {total > 0 ? (
              <>
                <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.05]" role="img" aria-label={`${runners} runners, ${mid} mid-fails, ${fails} fails`}>
                  <span className="h-full bg-up" style={{ width: seg(runners) }} />
                  <span className="h-full bg-warn" style={{ width: seg(mid) }} />
                  <span className="h-full bg-down/80" style={{ width: seg(fails) }} />
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <dt className="flex items-center gap-1.5 text-mute">
                      <span className="size-2 rounded-sm bg-up" aria-hidden="true" /> Early runners
                    </dt>
                    <dd className="num mt-0.5 text-base text-ink">{runners}</dd>
                    <dd className="text-[10px] text-faint">ATH ≥ $250K</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-mute">
                      <span className="size-2 rounded-sm bg-warn" aria-hidden="true" /> Mid-fails
                    </dt>
                    <dd className="num mt-0.5 text-base text-ink">{mid}</dd>
                    <dd className="text-[10px] text-faint">ATH $60–200K</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-mute">
                      <span className="size-2 rounded-sm bg-down/80" aria-hidden="true" /> Fails
                    </dt>
                    <dd className="num mt-0.5 text-base text-ink">{fails}</dd>
                    <dd className="text-[10px] text-faint">ATH &lt; $40K</dd>
                  </div>
                </dl>
              </>
            ) : (
              <EmptyState title="No early entries in the study sample" />
            )}
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-3">
          <Stat size="sm" label="Median entry delay" value={study.medianDelayMin != null ? fmtDuration(study.medianDelayMin * 60) : "—"} hint="after mint" />
          <Stat size="sm" label="Median entry MC" value={fmtUsd(study.medianEntryMcapUsd)} />
          <Stat size="sm" label="Runners entered (all)" value={study.runnersAll ?? "—"} />
        </dl>
        {study.notes && <p className="mt-4 text-xs text-ink-2">{study.notes}</p>}
        <p className="mt-4 text-[11px] leading-relaxed text-mute">
          Counts are buys within the study&apos;s early-entry definition over its sample of pump.fun launches, not this
          wallet&apos;s full history. A past hit rate is a description of that sample, not a forecast.
        </p>
      </div>
    </section>
  );
}
