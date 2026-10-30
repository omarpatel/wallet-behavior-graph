import Link from "next/link";
import { BrainAvatar } from "@/components/ui/Avatar";
import { brainTitle, pickFace } from "@/lib/identity";
import type { Face } from "@/server/snapshots/landing";

/**
 * Two counter-scrolling rows of tracked wallet faces (claimed avatars / directory pfps), each linking to its brain.
 * Rows are duplicated for a seamless loop; the duplicate is hidden from assistive tech. Static under reduced motion.
 */
export function FaceMarquee({ faces }: { faces: Face[] }) {
  if (faces.length < 6) return null;
  const half = Math.ceil(faces.length / 2);
  const rows = [faces.slice(0, half), faces.slice(half)];
  return (
    <div className="relative space-y-3 [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]" aria-label="Tracked wallets">
      {rows.map((row, r) => (
        <div key={r} className="group flex overflow-hidden">
          {[0, 1].map((copy) => (
            <ul
              key={copy}
              aria-hidden={copy === 1 ? true : undefined}
              className={`marquee-track flex shrink-0 gap-3 pr-3 group-hover:[animation-play-state:paused] ${r === 1 ? "marquee-reverse" : ""}`}
            >
              {row.map((f) => (
                <li key={f.id}>
                  <Link
                    href={`/brains/${f.id}`}
                    tabIndex={copy === 1 ? -1 : undefined}
                    className="flex items-center gap-2.5 rounded-full border border-line bg-white/[0.02] py-1 pl-1 pr-3.5 transition-colors hover:border-white/25 hover:bg-white/[0.05]"
                  >
                    <BrainAvatar brain={pickFace(f)} size={32} />
                    <span className="max-w-[9rem] truncate text-sm text-ink-2">{brainTitle(f)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ))}
        </div>
      ))}
    </div>
  );
}
