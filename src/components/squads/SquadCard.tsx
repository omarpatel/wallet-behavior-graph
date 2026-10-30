import Link from "next/link";
import { Sparkline } from "@/components/charts/Sparkline";
import { AvatarStack } from "@/components/ui/Avatar";
import { Stat, toneFor } from "@/components/ui/primitives";
import { fmtPct, fmtUsd } from "@/lib/format";
import { pickFace } from "@/lib/identity";
import type { Squad, SquadKind } from "@/server/snapshots/squads";

export const SQUAD_KIND_LABEL: Record<SquadKind, string> = {
  top5: "Performance",
  sharp: "Accuracy",
  early: "Timing",
  diamond: "Patience",
  circle: "Connectome circle",
};

const KIND_TONE: Record<SquadKind, string> = {
  top5: "border-accent/40 text-accent",
  sharp: "border-info/40 text-info",
  early: "border-warn/40 text-warn",
  diamond: "border-region-1/40 text-region-1",
  circle: "border-region-3/40 text-region-3",
};

export function SquadKindChip({ kind }: { kind: SquadKind }) {
  return <span className={`chip ${KIND_TONE[kind]}`}>{SQUAD_KIND_LABEL[kind]}</span>;
}

export function squadFaces(s: Squad) {
  return s.members.map((m) => ({ ...pickFace(m), id: m.id }));
}

export function SquadCard({ squad, sparkStart }: { squad: Squad; sparkStart: number }) {
  const c = squad.combined;
  return (
    <article className="card card-hover relative flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <SquadKindChip kind={squad.kind} />
          <h3 className="mt-2 truncate text-base font-semibold tracking-tight text-ink">
            <Link href={`/squads/${squad.slug}`} className="after:absolute after:inset-0 hover:text-accent">
              {squad.name}
            </Link>
          </h3>
        </div>
        <span className="num shrink-0 text-xs text-mute">{c.members} wallets</span>
      </div>
      <AvatarStack brains={squadFaces(squad)} size={32} max={7} />
      <p className="line-clamp-2 text-sm leading-relaxed text-mute">{squad.blurb}</p>
      <div className="mt-auto flex items-end justify-between gap-4 border-t border-line pt-4">
        <dl className="grid grid-cols-3 gap-4">
          <Stat size="sm" label="PnL 30d" value={fmtUsd(c.realized30dUsd)} tone={toneFor(c.realized30dUsd)} />
          <Stat size="sm" label="Win 30d" value={fmtPct(c.winRate30d)} />
          <Stat size="sm" label="Trades" value={c.trades30d.toLocaleString("en-US")} />
        </dl>
        <span className="hidden text-ink-2 sm:block">
          <Sparkline values={c.daily} start={sparkStart} width={72} height={26} label="Combined daily realized PnL" />
        </span>
      </div>
    </article>
  );
}
