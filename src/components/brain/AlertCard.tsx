import Link from "next/link";
import { BrainAvatar, type AvatarBrain } from "@/components/ui/Avatar";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { DISCLAIMER } from "@/components/ui/Disclaimer";
import { fmtDuration, fmtPct, fmtSol, fmtUsd } from "@/lib/format";
import type { AlertDTO } from "@/server/alerts/types";
import { safetyChips } from "@/server/signals/safety";

function Chip({ children, tone = "mute" }: { children: React.ReactNode; tone?: "mute" | "accent" | "warn" | "up" | "down" }) {
  const cls = {
    mute: "border-line-2 text-ink-2",
    accent: "border-accent/40 text-accent",
    warn: "border-warn/40 text-warn",
    up: "border-up/40 text-up",
    down: "border-down/40 text-down",
  }[tone];
  return <span className={`chip num ${cls}`}>{children}</span>;
}

const SAFETY_TONE = { good: "up", warn: "warn", bad: "down" } as const;

export function AlertCard({
  alert,
  isNew = false,
  timeLabel,
  brain,
}: {
  alert: AlertDTO;
  isNew?: boolean;
  timeLabel: string;
  /** The alerting brain (small avatar on the token icon). */
  brain?: AvatarBrain;
}) {
  const f = alert.facts;
  const buy = f.side === "buy";
  const token = f.symbol ?? f.name ?? `${f.mint.slice(0, 4)}…${f.mint.slice(-4)}`;
  return (
    <article
      className={`card space-y-3 p-4 transition-shadow ${isNew ? "shadow-[0_0_0_1px_rgb(198_255_58/0.35)]" : ""}`}
      aria-label={`${f.side} ${token}`}
    >
      <header className="flex items-start gap-3">
        <span className="relative shrink-0">
          <TokenIcon icon={f.icon} symbol={token} />
          {brain && (
            <span className="absolute -bottom-1 -right-1.5">
              <BrainAvatar brain={{ ...brain, tier: undefined }} size={20} plain className="ring-2 ring-bg" />
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`num rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${buy ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>{f.side}</span>
            <h3 className="truncate text-sm font-semibold text-ink">{alert.headline}</h3>
          </div>
          <p className="num mt-0.5 text-[11px] text-mute">
            <time dateTime={new Date(f.blockTime * 1000).toISOString()}>{timeLabel}</time>
            {f.launchpad && ` · ${f.launchpad}`}
            {f.venue && ` · ${f.venue}`}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <Chip>{fmtSol(f.solValue, 3)}</Chip>
        <Chip>{fmtUsd(f.usdValue)}</Chip>
        {f.mcUsd != null && <Chip>MC {fmtUsd(f.mcUsd)}</Chip>}
        {buy && f.entryDelaySec != null && <Chip>{fmtDuration(f.entryDelaySec)} after launch</Chip>}
        {f.position.isFirstBuy && buy && <Chip tone="accent">first buy</Chip>}
        {f.swarm && (
          <Link
            href={`/swarms#swarm-${f.swarm.id}`}
            className={`chip num ${f.swarm.stage === "forming" ? "border-accent/40 text-accent" : "border-warn/50 bg-warn/[0.06] text-warn"} hover:bg-white/[0.04]`}
            title={`Entry #${f.swarm.rank} of ${f.swarm.members} tracked wallets, ${fmtDuration(f.swarm.lagSec)} after the first`}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            swarm #{f.swarm.rank}/{f.swarm.members}
          </Link>
        )}
        {!buy && f.position.soldFraction != null && <Chip>sold {fmtPct(f.position.soldFraction)} of peak</Chip>}
        {!buy && f.position.roiOnSell != null && (
          <Chip tone={f.position.roiOnSell >= 0 ? "up" : "down"}>ROI {fmtPct(f.position.roiOnSell)}</Chip>
        )}
        {!buy && f.position.heldSec != null && <Chip>held {fmtDuration(f.position.heldSec)}</Chip>}
        {f.inCharacter.notes.map((n) => (
          <Chip key={n} tone="accent">
            {n}
          </Chip>
        ))}
      </div>

      {(() => {
        const chips = safetyChips(f.safety, { onCurve: f.venue === "pump_curve" });
        if (chips.length === 0 && f.safety.warnings.length === 0) return null;
        return (
          <div className="flex flex-wrap gap-1.5" aria-label="Safety context">
            {chips.map((c) => (
              <Chip key={c.label} tone={SAFETY_TONE[c.tone]}>
                {c.label}
              </Chip>
            ))}
            {f.safety.warnings.map((w) => (
              <Chip key={w} tone="warn">
                ⚠ {w}
              </Chip>
            ))}
          </div>
        );
      })()}

      <div className="rounded-lg border border-line bg-bg-2/60 p-3">
        {alert.explanation ? (
          <p className="text-[13px] leading-relaxed text-ink-2">{alert.explanation}</p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-mute" role="status">
            <span className="live-dot size-1.5 rounded-full bg-accent" aria-hidden="true" />
            Explanation in progress…
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-mute">
        <div className="flex gap-3">
          <a href={f.links.solscanTx} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
            Solscan ↗
          </a>
          <a href={f.links.dexscreener} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
            DexScreener ↗
          </a>
          {f.links.pumpfun && (
            <a href={f.links.pumpfun} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
              pump.fun ↗
            </a>
          )}
        </div>
        <p className="max-w-full text-[10px] leading-snug text-faint">{DISCLAIMER}</p>
      </footer>
    </article>
  );
}
