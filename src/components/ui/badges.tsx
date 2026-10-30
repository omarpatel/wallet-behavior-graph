import type { BrainTier, Provenance } from "@/db/schema";

const TIER_STYLE: Record<BrainTier, string> = {
  S: "border-accent/60 bg-accent/10 text-accent",
  A: "border-info/50 bg-info/10 text-info",
  B: "border-ink-2/40 bg-white/[0.04] text-ink",
  C: "border-line-2 text-ink-2",
  unrated: "border-line-2 border-dashed text-mute",
};

export function TierBadge({ tier, size = "md" }: { tier: BrainTier; size?: "sm" | "md" | "lg" }) {
  const dims = size === "lg" ? "h-10 min-w-10 text-lg" : size === "sm" ? "h-6 min-w-6 text-[11px]" : "h-7 min-w-7 text-xs";
  return (
    <span
      className={`num inline-flex items-center justify-center rounded-md border px-1.5 font-semibold ${dims} ${TIER_STYLE[tier]}`}
      title={tier === "unrated" ? "Unrated — sample too thin for a tier" : `Tier ${tier}`}
      aria-label={tier === "unrated" ? "Unrated" : `Tier ${tier}`}
    >
      {tier === "unrated" ? "—" : tier}
    </span>
  );
}

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  self_verified: "Self-verified",
  platform_attributed: "Platform-attributed",
  community_attributed: "Community-attributed",
  unattributed: "Unattributed",
};

const PROVENANCE_HINT: Record<Provenance, string> = {
  self_verified: "The owner signed in with this wallet and claimed the brain.",
  platform_attributed: "Attribution published by a third-party platform (the wallet directory). Not confirmed by the person here.",
  community_attributed: "Attribution circulated publicly by the community. Not confirmed.",
  unattributed: "No person is attached to this wallet.",
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const tone =
    provenance === "self_verified"
      ? "border-up/40 text-up"
      : provenance === "platform_attributed"
        ? "border-info/40 text-info"
        : provenance === "community_attributed"
          ? "border-warn/40 text-warn"
          : "border-line-2 text-mute";
  return (
    <span className={`chip ${tone}`} title={PROVENANCE_HINT[provenance]}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

export function VerifiedBadge() {
  return (
    <span className="chip border-up/40 bg-up/[0.06] text-up" title="Claimed by the wallet owner (signed in with this wallet)">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Verified owner
    </span>
  );
}

export function ArchetypeChip({ label, title }: { label: string; title?: string }) {
  return (
    <span className="chip border-accent/25 text-ink" title={title}>
      <span className="size-1.5 rotate-45 bg-accent" aria-hidden="true" />
      {label}
    </span>
  );
}

export function StatusPill({ tone, children }: { tone: "up" | "down" | "warn" | "mute" | "accent"; children: React.ReactNode }) {
  const cls = {
    up: "border-up/40 text-up",
    down: "border-down/40 text-down",
    warn: "border-warn/40 text-warn",
    mute: "border-line-2 text-mute",
    accent: "border-accent/40 text-accent",
  }[tone];
  return <span className={`chip ${cls}`}>{children}</span>;
}
