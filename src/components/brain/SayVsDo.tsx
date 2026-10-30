import { ExternalLink, EmptyState, SectionTitle, Stat } from "@/components/ui/primitives";
import { solscan, xStatusUrl } from "@/components/ui/links";
import { fmtDuration, fmtPct, fmtUsd } from "@/lib/format";
import type { BrainProfile } from "@/server/profile/types";
import type { ShillEvidence } from "@/server/queries/brains";

/** Claimed + X-linked brains only: posts vs on-chain trades, with receipts and neutral wording. */
export function SayVsDo({ events, summary }: { events: ShillEvidence[]; summary: BrainProfile["promoteThenSell"] }) {
  return (
    <section aria-labelledby="say-vs-do" className="space-y-4">
      <SectionTitle id="say-vs-do" eyebrow="Claimed brain · X linked by the owner">
        Say vs do
      </SectionTitle>
      <p className="max-w-3xl text-sm text-mute">
        Bullish posts by the owner that mention a token, matched with this wallet&apos;s trades in that token. An event is
        recorded when the wallet held a position before the post and sold at least half of it within 24 hours. Facts
        only; context is in the methodology.
      </p>
      {summary && (
        <dl className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-5">
          <Stat label="Bullish mentions" value={summary.bullishMentions} />
          <Stat label="Events" value={summary.events} />
          <Stat label="Strong events" value={summary.strongEvents} />
          <Stat label="Event rate" value={fmtPct(summary.rate)} />
          <Stat label="Lift vs baseline" value={summary.lift == null ? "—" : `${summary.lift.toFixed(1)}×`} />
        </dl>
      )}
      {events.length === 0 ? (
        <EmptyState title="No post-then-sell events recorded">Posts and trades are compared as they come in.</EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {events.map((e) => (
            <li key={e.id} className="card space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{e.symbol ?? `${e.mint.slice(0, 4)}…`}</span>
                <span className={`chip ${e.strong ? "border-warn/40 text-warn" : "text-mute"}`}>{e.strong ? "Fast exit" : "Exit within 24h"}</span>
              </div>
              {e.tweetText && (
                <blockquote className="border-l-2 border-line-2 pl-3 text-xs leading-relaxed text-ink-2">{e.tweetText}</blockquote>
              )}
              <p className="num text-xs text-ink-2">
                Sold {fmtPct(e.soldFrac1h)} within 1h and {fmtPct(e.soldFrac24h)} within 24h after posting
                {e.firstSellAfterSec != null && `; first sell ${fmtDuration(e.firstSellAfterSec)} after the post`}.
              </p>
              <dl className="grid grid-cols-3 gap-2">
                <Stat size="sm" label="Position at post" value={fmtUsd(e.prePositionUsd)} />
                <Stat size="sm" label="Held before post" value={fmtDuration(e.leadTimeSec)} />
                <Stat size="sm" label="MC vs entry" value={e.entryDiscount == null ? "—" : `${e.entryDiscount.toFixed(1)}×`} />
              </dl>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-mute">
                <ExternalLink href={xStatusUrl(e.tweetId)}>post</ExternalLink>
                {e.signatures.slice(0, 4).map((s) => (
                  <ExternalLink key={s} href={solscan("tx", s)} className="num">
                    {s.slice(0, 6)}…
                  </ExternalLink>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
