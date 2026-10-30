import Link from "next/link";
import { BrainAvatar, type AvatarSize } from "@/components/ui/Avatar";
import type { BrainTier } from "@/db/schema";
import { brainTitle, pickFace, showsPublicName, type IdentityFields } from "@/lib/identity";

/** Avatar + display name linking to the brain (tables, lists). Codename shown underneath when the title is a public name. */
export function BrainLink({
  id,
  brain,
  size = 24,
  withCodename = false,
  hash = "",
  className = "",
}: {
  id: string;
  brain: IdentityFields & { tier?: BrainTier };
  size?: AvatarSize;
  withCodename?: boolean;
  hash?: string;
  className?: string;
}) {
  const sub = withCodename && showsPublicName(brain) ? brain.codename : null;
  return (
    <span className={`flex min-w-0 items-center gap-2 ${className}`}>
      <BrainAvatar brain={pickFace(brain)} size={size} />
      <span className="min-w-0">
        <Link href={`/brains/${id}${hash}`} className="block truncate text-ink hover:text-accent">
          {brainTitle(brain)}
        </Link>
        {sub && <span className="num block truncate text-[11px] text-mute">{sub}</span>}
      </span>
    </span>
  );
}
