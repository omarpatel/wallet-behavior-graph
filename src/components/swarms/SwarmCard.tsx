import { AvatarStack } from "@/components/ui/Avatar";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { fmtDuration, fmtUsd } from "@/lib/format";
import type { SwarmDTO, SwarmMemberDTO } from "@/server/signals/types";

/** Swarm members carry their resolved avatar; map them onto the identity rules (claimed = self-verified). */
export function memberFace(m: SwarmMemberDTO) {
  const claimed = m.provenance === "self_verified";
  return {
    id: m.brainId,
    brainId: m.brainId,
    codename: m.codename,
    displayName: m.displayName,
    xHandle: m.xHandle,
    provenance: m.provenance,
    status: claimed ? ("claimed" as const) : ("unclaimed" as const),
    avatarUrl: claimed ? m.avatarUrl : null,
    publicAvatarUrl: m.avatarUrl,
    tier: m.tier,
  };
}

export const STAGE_LABEL: Record<SwarmDTO["stage"], string> = { forming: "Forming", swarm: "Swarm", large: "Large swarm" };
const STAGE_TONE: Record<SwarmDTO["stage"], string> = {
  forming: "border-line-2 text-ink-2",
  swarm: "border-warn/50 bg-warn/[0.06] text-warn",
  large: "border-down/50 bg-down/[0.07] text-down",
};

export function StageBadge({ stage }: { stage: SwarmDTO["stage"] }) {
  return <span className={`chip num ${STAGE_TONE[stage]}`}>{STAGE_LABEL[stage]}</span>;
}

/** "3m 12s" style elapsed time for live timers. */
export function elapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return fmtDuration(s);
}

function TokenMark({ swarm, now }: { swarm: SwarmDTO; now: number }) {
  if (swarm.hidden || !swarm.token) {
    const left = swarm.revealAt - now;
    return (
      <span className="flex items-center gap-2" title="Token identity is shown to seat holders of a member in real time and to everyone after the public delay">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line-2 text-mute" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 16 16">
            <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink-2">Token hidden</span>
          <span className="num block text-[11px] text-mute">{left > 0 ? `public in ${fmtDuration(left)}` : "revealing…"}</span>
        </span>
      </span>
    );
  }
  const t = swarm.token;
  return (
    <a
      href={`https://dexscreener.com/solana/${t.mint}`}
      target="_blank"
      rel="noopener noreferrer"
      className="relative z-10 flex min-w-0 items-center gap-2 hover:text-accent"
    >
      <TokenIcon icon={t.icon} symbol={t.symbol ?? t.mint} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">${t.symbol ?? `${t.mint.slice(0, 4)}…`}</span>
        <span className="num block truncate text-[11px] text-mute">
          {t.launchpad ?? "token"}
          {t.mcapUsd != null && ` · now ${fmtUsd(t.mcapUsd)}`}
        </span>
      </span>
      <span className="sr-only">(opens DexScreener in new tab)</span>
    </a>
  );
}

export function OutcomeBadges({ swarm }: { swarm: SwarmDTO }) {
  const o = swarm.outcome;
  if (!o) return null;
  const chips: { label: string; tone: string; title: string }[] = [];
  if (o.multiple != null) {
    chips.push({
      label: `peak ${o.multiple.toFixed(1)}×`,
      tone: o.multiple >= 2 ? "border-up/40 text-up" : "border-line-2 text-ink-2",
      title: `Highest market cap seen in tracked trades within 24 h of the start (${fmtUsd(o.peakMcUsd)}), vs ${fmtUsd(o.mcAtStartUsd)} at the first entry. A lower bound of the true peak.`,
    });
  }
  if (o.multipleFromPublish != null) {
    chips.push({
      label: `${o.multipleFromPublish.toFixed(1)}× after detection`,
      tone: o.multipleFromPublish >= 2 ? "border-up/40 text-up" : o.multipleFromPublish < 1 ? "border-down/40 text-down" : "border-line-2 text-ink-2",
      title: `From ${fmtUsd(o.mcAtPublishUsd)} when the swarm became detectable to ${fmtUsd(o.peakAfterPublishMcUsd)} afterwards.`,
    });
  }
  if (o.peakMcUsd != null && o.peakMcUsd >= 100_000 && (o.mcAtStartUsd ?? 0) < 100_000) {
    chips.push({ label: "reached $100K", tone: "border-accent/40 text-accent", title: "Peak market cap crossed $100K within 24 h." });
  }
  if (!o.windowComplete) chips.push({ label: "24h window open", tone: "border-dashed border-line-2 text-mute", title: "Outcome still being measured." });
  if (chips.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c.label} className={`chip num text-[11px] ${c.tone}`} title={c.title}>
          {c.label}
        </span>
      ))}
    </span>
  );
}

export function SwarmCard({ swarm, now, fresh = false }: { swarm: SwarmDTO; now: number; fresh?: boolean }) {
  const ordered = [...swarm.memberList].sort((a, b) => a.at - b.at);
  const sinceStart = now - swarm.startedAt;
  const bundled = swarm.members - swarm.independentMembers;
  return (
    <article
      id={`swarm-${swarm.id}`}
      className={`card scroll-mt-24 space-y-4 p-4 transition-shadow ${fresh ? "shadow-[0_0_0_1px_rgb(198_255_58/0.45),0_0_40px_-12px_rgb(198_255_58/0.5)]" : ""} ${swarm.active ? "border-warn/25" : ""}`}
    >
      <header className="flex items-start justify-between gap-3">
        <TokenMark swarm={swarm} now={now} />
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StageBadge stage={swarm.stage} />
          {swarm.active ? (
            <span className="num flex items-center gap-1.5 text-[11px] text-warn" title="Time since the first member entered">
              <span className="live-dot size-1.5 rounded-full bg-warn" aria-hidden="true" />
              {elapsed(sinceStart)}
            </span>
          ) : (
            <span className="num text-[11px] text-mute">{fmtDuration(sinceStart)} ago</span>
          )}
        </div>
      </header>
      <div className="flex items-center justify-between gap-3">
        <AvatarStack brains={ordered.map(memberFace)} size={32} max={8} />
        <span className="num shrink-0 text-right text-xs text-ink-2">
          {swarm.members} wallets
          <span className="block text-[10px] text-mute">in {fmtDuration(swarm.lastJoinAt - swarm.startedAt)}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <span className="num text-[11px] text-mute">
          MC at start <span className="text-ink-2">{swarm.outcome ? fmtUsd(swarm.outcome.mcAtStartUsd) : "hidden"}</span>
          {bundled > 0 && <span title="Members that landed in the same slot as another member (near-simultaneous)"> · {bundled} same-slot</span>}
        </span>
        <OutcomeBadges swarm={swarm} />
      </div>
    </article>
  );
}
