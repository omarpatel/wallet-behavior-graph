"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { BrainPicksDTO, PickDTO } from "@/server/picks/types";
import { agentApi, archetypeLabel, fmtSignedPct } from "@/components/agents/lib";
import { CLOSE_LABEL, CLOSE_TITLE, ExitPlanChips, fmtBankroll, PickStatsGrid, SignedPct } from "@/components/picks/PickParts";
import { CopyButton } from "@/components/ui/CopyButton";
import { dexscreenerToken, solscan } from "@/components/ui/links";
import { EmptyState, ExternalLink } from "@/components/ui/primitives";
import { fmtDuration, fmtUsd, shortAddr, timeAgo } from "@/lib/format";

type Conn = "connecting" | "live" | "reconnecting" | "denied";

const REFRESH_MS = 60_000;

const newestFirst = (a: PickDTO, b: PickDTO) => b.createdAt - a.createdAt || b.id - a.id;

/** Insert or replace picks by id, newest first. */
function upsertAll(list: PickDTO[], incoming: PickDTO[]): PickDTO[] {
  const byId = new Map(list.map((p) => [p.id, p]));
  for (const p of incoming) byId.set(p.id, p);
  return [...byId.values()].sort(newestFirst);
}

/**
 * Brain Picks tab: tokens that match this wallet's style right now, each tracked on paper by the style's exit plan.
 * Realtime viewers (seat / owner / admin) follow the SSE `/api/brains/[id]/picks/stream` (one `pick` event per new or
 * changed pick); everyone else refreshes `/api/brains/[id]/picks` every minute and sees tokens after the public delay.
 */
export function BrainPicks({ brainId, initial, serverNow }: { brainId: string; initial: BrainPicksDTO; serverNow: number }) {
  const [picks, setPicks] = useState(() => [...initial.picks].sort(newestFirst));
  const [stats, setStats] = useState(initial.stats);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Record<number, true>>({});
  const [conn, setConn] = useState<Conn>("connecting");
  const [denied, setDenied] = useState<string | null>(null);
  const [now, setNow] = useState(serverNow);
  const known = useRef(new Set(initial.picks.map((p) => p.id)));
  const base = `/api/brains/${encodeURIComponent(brainId)}/picks`;
  const { realtime, delaySec, style } = initial;

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);

  // Track record + newest page every minute (public: reveals picks as their delay passes; realtime: refreshes stats).
  useEffect(() => {
    if (!initial.generating) return;
    const ctl = new AbortController();
    const t = setInterval(() => {
      agentApi<BrainPicksDTO>(base, { signal: ctl.signal })
        .then((page) => {
          setStats(page.stats);
          setPicks((list) => upsertAll(list, page.picks));
        })
        .catch(() => {
          // transient: the next refresh retries
        });
    }, REFRESH_MS);
    return () => {
      clearInterval(t);
      ctl.abort();
    };
  }, [base, initial.generating]);

  useEffect(() => {
    if (!realtime || !initial.generating) return;
    const url = `${base}/stream`;
    const es = new EventSource(url);
    es.addEventListener("open", () => setConn("live"));
    es.addEventListener("pick", (ev: MessageEvent<string>) => {
      try {
        const p = JSON.parse(ev.data) as PickDTO;
        if (!known.current.has(p.id)) {
          known.current.add(p.id);
          setFresh((f) => ({ ...f, [p.id]: true }));
        }
        setPicks((list) => upsertAll(list, [p]));
      } catch {
        // malformed frame: ignore, the next event or refresh resyncs
      }
    });
    const probe = new AbortController();
    es.addEventListener("error", () => {
      if (es.readyState !== EventSource.CLOSED) {
        setConn("reconnecting");
        return;
      }
      // Pre-stream errors (401/403/404) close the stream; ask the route why.
      fetch(url, { signal: probe.signal })
        .then(async (r) => {
          if (r.ok) return null;
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          return body?.error ?? `HTTP ${r.status}`;
        })
        .catch(() => null)
        .then((reason) => {
          probe.abort();
          setConn("denied");
          setDenied(reason ?? "The live pick stream closed. Reload the page to reconnect.");
        });
    });
    return () => {
      probe.abort();
      es.close();
    };
  }, [base, realtime, initial.generating]);

  async function loadOlder() {
    if (!cursor) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await agentApi<BrainPicksDTO>(`${base}?cursor=${encodeURIComponent(cursor)}`);
      setPicks((list) => upsertAll(list, page.picks));
      setCursor(page.nextCursor);
    } catch (e) {
      setOlderError(e instanceof Error ? e.message : "Could not load older picks.");
    } finally {
      setLoadingOlder(false);
    }
  }

  const delay = fmtDuration(delaySec);

  return (
    <section aria-labelledby="picks-title" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="picks-title" className="text-lg font-semibold text-ink">
            Brain Picks
          </h2>
          <p className="mt-1 text-xs text-mute">
            Tokens that match this wallet&apos;s style right now, found by the same rules its agents use. Tracked on paper by the
            style&apos;s exit plan. Not financial advice.
          </p>
        </div>
        {realtime ? (
          <span
            className={`chip ${conn === "live" ? "border-up/40 text-up" : conn === "denied" ? "border-down/40 text-down" : "text-mute"}`}
            role="status"
            aria-live="polite"
          >
            <span className={`size-1.5 rounded-full bg-current ${conn === "live" ? "live-dot" : ""}`} aria-hidden="true" />
            {!initial.generating
              ? "Real-time access"
              : conn === "live"
                ? "Live — seat"
                : conn === "connecting"
                  ? "Connecting…"
                  : conn === "reconnecting"
                    ? "Reconnecting…"
                    : "Disconnected"}
          </span>
        ) : (
          <span className="chip text-mute" title={`Picks younger than ${delay} are hidden for viewers without a seat`}>
            Delayed {delay}
          </span>
        )}
      </div>

      {!realtime && (
        <p role="note" className="rounded-xl border border-line-2 bg-panel px-4 py-3 text-sm text-ink-2">
          Delayed view: picks from the last {delay} are hidden. Seat holders get every pick in real time.{" "}
          <a href="#seat" className="text-ink underline decoration-line-2 hover:text-accent">
            Get a seat
          </a>
        </p>
      )}
      {denied && (
        <p role="alert" className="rounded-lg border border-down/30 bg-down/[0.05] px-3 py-2 text-sm text-down">
          {denied}
        </p>
      )}

      {!initial.generating ? (
        <EmptyState title="No picks yet">
          Picks start once this brain has a seat holder or an agent. From then on, every token that matches its style is
          published here and tracked on paper.
        </EmptyState>
      ) : (
        <>
          <div className="card p-5">
            <h3 className="eyebrow mb-4">Track record · paper outcomes{realtime ? "" : ` · picks older than ${delay}`}</h3>
            <PickStatsGrid stats={stats} />
          </div>

          {style ? (
            <div className="card space-y-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="eyebrow">The style picks follow</h3>
                <span className="chip text-[11px] text-ink-2">{archetypeLabel(style.archetype)}</span>
              </div>
              <p className="text-sm text-ink-2">{style.summary}</p>
              <p className="num text-xs text-mute">
                Style size{" "}
                <span className="text-ink">
                  {style.sizing.baseFraction === style.sizing.maxFraction
                    ? fmtBankroll(style.sizing.baseFraction)
                    : `${fmtBankroll(style.sizing.baseFraction)}–${fmtBankroll(style.sizing.maxFraction)}`}{" "}
                  of bankroll
                </span>{" "}
                ({style.sizing.style}
                {style.sizing.style === "conviction" ? ", larger with conviction" : ""})
              </p>
              <div>
                <p className="mb-1.5 text-[11px] text-mute">The style&apos;s exit plan</p>
                <ExitPlanChips plan={style.exit} />
              </div>
            </div>
          ) : (
            <EmptyState title="No style to follow">
              {initial.untradableReason ?? "This wallet's profile is too thin to derive a trading style."}
            </EmptyState>
          )}

          {picks.length === 0 ? (
            <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
              <span className="live-dot size-2 rounded-full bg-accent" aria-hidden="true" />
              <p className="text-sm text-ink">Waiting for a token that matches this wallet&apos;s style</p>
              <p className="max-w-sm text-xs text-mute">
                {realtime ? "New picks appear here the moment they qualify." : `Picks appear here ${delay} after they qualify.`}
              </p>
            </div>
          ) : (
            <ol className="space-y-3" aria-live={realtime ? "polite" : undefined} aria-relevant="additions">
              {picks.map((p) => (
                <li key={p.id}>
                  <PickCard pick={p} now={now} isNew={!!fresh[p.id]} />
                </li>
              ))}
            </ol>
          )}

          {cursor && (
            <div className="flex flex-col items-center gap-2">
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? "Loading…" : "Load older picks"}
              </button>
              {olderError && (
                <p role="alert" className="text-xs text-down">
                  {olderError}
                </p>
              )}
            </div>
          )}
        </>
      )}

      <p className="border-t border-line pt-4 text-[11px] text-mute">
        Not financial advice. Picks are paper-tracked; past paper outcomes don&apos;t predict future results.{" "}
        <Link href="/methodology#picks" className="text-ink-2 hover:text-accent">
          How picks work
        </Link>
        {" · "}
        <Link href="/picks" className="text-ink-2 hover:text-accent">
          Picks leaderboard
        </Link>
      </p>
    </section>
  );
}

function HiddenPick({ pick, now }: { pick: PickDTO; now: number }) {
  const left = pick.revealAt - now;
  const at = new Date(pick.revealAt * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  return (
    <article className="card flex flex-wrap items-center justify-between gap-3 border-dashed p-4" aria-label="Hidden pick">
      <span className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line-2 text-mute" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 16 16">
            <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink-2" suppressHydrationWarning>
            Token hidden until {at}
          </span>
          <span className="num block text-[11px] text-mute">
            {left > 0 ? `public in ${fmtDuration(left)}` : "revealing…"} · seat holders see it now
          </span>
        </span>
      </span>
      <span className="num text-[11px] text-mute">picked {timeAgo(pick.createdAt, now)}</span>
    </article>
  );
}

function StatusChip({ pick }: { pick: PickDTO }) {
  if (pick.status === "open") {
    return (
      <span className="chip num border-info/40 text-info" title="Still tracked on paper by the style's exit plan">
        <span className="live-dot size-1.5 rounded-full bg-current" aria-hidden="true" />
        open
      </span>
    );
  }
  const reason = pick.closeReason;
  const tone = pick.outcomePct == null || pick.outcomePct === 0 ? "border-line-2 text-ink-2" : pick.outcomePct > 0 ? "border-up/40 text-up" : "border-down/40 text-down";
  return (
    <span className={`chip num ${tone}`} title={reason ? CLOSE_TITLE[reason] : "Closed on paper"}>
      closed{reason ? ` · ${CLOSE_LABEL[reason]}` : ""} · {fmtSignedPct(pick.outcomePct)}
    </span>
  );
}

function PickCard({ pick, now, isNew }: { pick: PickDTO; now: number; isNew: boolean }) {
  if (pick.hidden || !pick.token) return <HiddenPick pick={pick} now={now} />;
  const t = pick.token;
  const label = t.symbol ? `$${t.symbol}` : shortAddr(t.mint);
  return (
    <article
      className={`card space-y-3 p-4 transition-shadow ${isNew ? "shadow-[0_0_0_1px_rgb(198_255_58/0.35)]" : ""}`}
      aria-label={`Pick ${label}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-panel-2 text-[10px] text-mute" aria-hidden="true">
            {(t.symbol ?? "?").slice(0, 3)}
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <ExternalLink href={dexscreenerToken(t.mint)} className="num font-semibold text-ink">
                {label}
              </ExternalLink>
              {t.name && <span className="truncate text-xs text-ink-2">{t.name}</span>}
            </p>
            <p className="num flex flex-wrap items-center gap-x-2 text-[11px] text-mute">
              <ExternalLink href={solscan("token", t.mint)}>{shortAddr(t.mint)}</ExternalLink>
              {t.launchpad && <span>{t.launchpad}</span>}
              {t.phase !== "unknown" && <span>{t.phase === "curve" ? "on curve" : "graduated"}</span>}
              <span>picked {timeAgo(pick.createdAt, now)}</span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip pick={pick} />
          <CopyButton text={t.mint} label="Copy mint" className="h-7 px-2 text-[11px]" />
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div>
          <dt className="eyebrow">Entry MC</dt>
          <dd className="num mt-1 text-sm text-ink">{fmtUsd(pick.entryMcUsd)}</dd>
        </div>
        <div>
          <dt className="eyebrow">Style size</dt>
          <dd className="num mt-1 text-sm text-ink" title="The style's position size for this pick, as a share of a bankroll">
            {fmtBankroll(pick.suggestedFraction)} of bankroll
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Since pick</dt>
          <dd className="mt-1 text-sm" title={pick.lastPriceAt ? `Price as of ${timeAgo(pick.lastPriceAt, now)}` : undefined}>
            <SignedPct pct={pick.lastGainPct} />
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Max gain</dt>
          <dd className="mt-1 text-sm">
            <SignedPct pct={pick.maxGainPct} />
          </dd>
        </div>
        <div>
          <dt className="eyebrow">{pick.status === "open" ? "Paper outcome so far" : "Paper outcome"}</dt>
          <dd className="mt-1 text-sm">
            <SignedPct pct={pick.outcomePct} />
            {pick.soldPct > 0 && <span className="num ml-1.5 text-[11px] text-mute">{Math.round(pick.soldPct)}% sold</span>}
          </dd>
        </div>
      </dl>

      {pick.chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Council">
          {pick.chips.map((c) => (
            <span key={c} className="chip num border-accent/30 text-[11px] text-accent">
              {c}
            </span>
          ))}
        </div>
      )}

      {pick.llm && (
        <p className="rounded-lg border border-line bg-bg-2/60 px-3 py-2 text-sm text-ink-2">
          {pick.llm.text} <span className="num text-[10px] text-mute">— {pick.llm.model}</span>
        </p>
      )}

      <details className="group text-sm">
        <summary className="cursor-pointer list-none text-xs text-ink-2 hover:text-accent [&::-webkit-details-marker]:hidden">
          <span className="inline-block transition-transform group-open:rotate-90" aria-hidden="true">
            ›
          </span>{" "}
          Why it matches this wallet&apos;s style
        </summary>
        <div className="mt-2 space-y-2">
          {pick.reason && <p className="text-xs text-ink-2">{pick.reason}</p>}
          <div>
            <p className="mb-1 text-[11px] text-mute">The style&apos;s exit plan for this pick</p>
            <ExitPlanChips plan={pick.exitPlan} small />
          </div>
        </div>
      </details>
    </article>
  );
}
