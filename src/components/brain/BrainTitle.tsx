import Link from "next/link";
import { BrainAvatar, type AvatarSize } from "@/components/ui/Avatar";
import { ProvenanceBadge, VerifiedBadge } from "@/components/ui/badges";
import { ExternalLink } from "@/components/ui/primitives";
import type { BrainTier } from "@/db/schema";
import { sourceName } from "@/lib/format";
import { brainTitle, pickFace, showsPublicName } from "@/lib/identity";
import type { BrainIdentity } from "@/server/queries/shared";

/**
 * Brain title + attribution line (see src/lib/identity.ts):
 * - claimed → the owner's chosen name + verified badge;
 * - platform-attributed → the KOL's public name, "via <source>" and the codename as secondary label;
 * - otherwise → neutral codename; a community attribution only as a labelled attribution with provenance + source.
 */
export function BrainTitle({
  brain,
  as = "h3",
  href,
  size = "md",
  avatar,
}: {
  brain: BrainIdentity & { tier?: BrainTier };
  as?: "h1" | "h2" | "h3";
  href?: string;
  size?: "md" | "lg";
  /** Render the avatar to the left of the title at this size. */
  avatar?: AvatarSize;
}) {
  const H = as;
  const claimed = brain.status === "claimed";
  const publicName = showsPublicName(brain);
  const title = brainTitle(brain);
  const titleCls = size === "lg" ? "font-display text-4xl leading-none tracking-tight sm:text-5xl" : "text-base font-semibold tracking-tight";
  const src = sourceName(brain.provenanceSource);
  const communityAttributed = !claimed && !publicName && (brain.displayName || brain.xHandle) && brain.provenance !== "unattributed";
  const sourceLink = (label: string) =>
    brain.provenanceSource ? (
      <ExternalLink href={brain.provenanceSource} className="relative z-10 text-ink-2 underline decoration-line-2">
        {label}
      </ExternalLink>
    ) : (
      label
    );

  const body = (
    <div className="min-w-0">
      <H className={`${titleCls} truncate text-ink`}>
        {href ? (
          <Link href={href} className="hover:text-accent after:absolute after:inset-0 after:content-['']">
            {title}
          </Link>
        ) : (
          title
        )}
      </H>
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${size === "lg" ? "mt-3" : "mt-1"}`}>
        {claimed ? (
          <>
            <VerifiedBadge />
            {brain.xHandle && <span className="text-xs text-mute">@{brain.xHandle}</span>}
          </>
        ) : publicName ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-mute">
            {brain.displayName && brain.xHandle && size !== "lg" && <span className="truncate text-ink-2">@{brain.xHandle}</span>}
            {src && <span>via {sourceLink(src)}</span>}
            <span className="num truncate" title="Neutral codename of this brain">
              codename {brain.codename}
            </span>
          </span>
        ) : communityAttributed ? (
          <>
            <span className="text-xs text-ink-2">
              Publicly attributed to <span className="text-ink">{brain.displayName ?? `@${brain.xHandle}`}</span>
              {src && (
                <>
                  {" · source "}
                  {sourceLink(src)}
                </>
              )}
            </span>
            <ProvenanceBadge provenance={brain.provenance} />
          </>
        ) : (
          <ProvenanceBadge provenance="unattributed" />
        )}
      </div>
    </div>
  );

  if (!avatar) return body;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <BrainAvatar brain={pickFace(brain)} size={avatar} />
      {body}
    </div>
  );
}