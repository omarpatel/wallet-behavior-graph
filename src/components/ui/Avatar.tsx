"use client";

import { useState } from "react";
import type { BrainTier } from "@/db/schema";
import { avatarPx, monogram } from "@/lib/avatar";
import { brainAvatar, brainTitle, TIER_RING, type IdentityFields } from "@/lib/identity";

export type AvatarSize = 20 | 24 | 28 | 32 | 40 | 48 | 56 | 64 | 80 | 96 | 128;

const MONO_BG = ["#1d2a14", "#14222d", "#251a2e", "#2b2112", "#132826", "#2c1626", "#1a1f2e", "#2a2414"];
const MONO_INK = ["#c6ff3a", "#7cc4ff", "#c792ff", "#ffb648", "#4fe3d0", "#ff8ad8", "#8fa8ff", "#ffd36e"];

/**
 * Round avatar with a monogram underlay. `src` is a brain's cached pfp route (`brainAvatar()`, served same-origin and
 * already resized by src/app/api/avatar/[brainId]/route.ts, so a plain lazy <img> at the matching size), or with
 * `external` a third-party image URL used as is (token icons); the image fades in over the monogram and is dropped on
 * a load error, so a dead host leaves the monogram. `tier` adds the tier-coloured ring.
 */
export function Avatar({
  src,
  name,
  size = 32,
  tier,
  className = "",
  priority = false,
  plain = false,
  external = false,
}: {
  src: string | null | undefined;
  name: string;
  size?: AvatarSize;
  tier?: BrainTier;
  className?: string;
  priority?: boolean;
  /** No default ring (caller supplies its own ring classes). */
  plain?: boolean;
  /** `src` is a third-party URL (no resize parameter). */
  external?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const showImage = !!src && failed !== src;
  const ring = plain
    ? ""
    : tier
      ? size <= 24
        ? `ring-1 ${TIER_RING[tier]}`
        : `ring-2 ${TIER_RING[tier]} ring-offset-2 ring-offset-bg`
      : "ring-1 ring-line-2";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const slot = h % MONO_BG.length;

  return (
    <span
      className={`relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-panel-2 ${ring} ${className}`}
      style={{ width: size, height: size }}
      title={name}
    >
      <span
        aria-hidden="true"
        className="num flex size-full items-center justify-center font-semibold"
        style={{ background: MONO_BG[slot], color: MONO_INK[slot], fontSize: Math.max(8, Math.round(size * 0.38)) }}
      >
        {monogram(name)}
      </span>
      {showImage && (
        // eslint-disable-next-line @next/next/no-img-element -- resized route / arbitrary third-party hosts
        <img
          src={external ? src : `${src}&s=${avatarPx(size)}`}
          alt=""
          width={size}
          height={size}
          decoding="async"
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          referrerPolicy={external ? "no-referrer" : undefined}
          className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${loaded === src ? "opacity-100" : "opacity-0"}`}
          // Cached images can finish before hydration attaches onLoad: check on mount too.
          ref={(el) => {
            if (el?.complete && el.naturalWidth > 0 && loaded !== src) setLoaded(src);
          }}
          onLoad={() => setLoaded(src)}
          onError={() => setFailed(src)}
        />
      )}
    </span>
  );
}

export type AvatarBrain = Pick<IdentityFields, "brainId" | "codename" | "displayName" | "xHandle" | "provenance" | "status" | "avatarUrl" | "publicAvatarUrl"> & {
  tier?: BrainTier;
};

/** Avatar for a brain: applies the identity rules (claimed / platform-attributed pfp, else monogram of the codename). */
export function BrainAvatar({
  brain,
  size = 32,
  className,
  priority,
  plain,
}: {
  brain: AvatarBrain;
  size?: AvatarSize;
  className?: string;
  priority?: boolean;
  plain?: boolean;
}) {
  return (
    <Avatar
      src={brainAvatar(brain)}
      name={brainTitle(brain)}
      size={size}
      tier={brain.tier}
      className={className}
      priority={priority}
      plain={plain}
    />
  );
}

/** Overlapping avatar stack (order preserved), with a "+N" chip when truncated. */
export function AvatarStack({ brains, size = 28, max = 8 }: { brains: (AvatarBrain & { id: string })[]; size?: AvatarSize; max?: number }) {
  const shown = brains.slice(0, max);
  const extra = brains.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((b, i) => (
        <span key={`${b.id}-${i}`} className={`relative ${i > 0 ? "-ml-2" : ""}`} style={{ zIndex: shown.length - i }}>
          <BrainAvatar brain={{ ...b, tier: undefined }} size={size} plain className="ring-2 ring-bg" />
        </span>
      ))}
      {extra > 0 && (
        <span
          className="num relative -ml-2 inline-flex items-center justify-center rounded-full border border-line-2 bg-panel-2 text-[10px] text-ink-2 ring-2 ring-bg"
          style={{ width: size, height: size }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
