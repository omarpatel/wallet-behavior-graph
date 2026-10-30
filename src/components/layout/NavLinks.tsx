"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { useSession } from "@/components/wallet";

const LINKS = [
  { href: "/leaderboard", label: "Leaderboard", menuOnly: false },
  { href: "/brains", label: "Explore", menuOnly: false },
  { href: "/squads", label: "Squads", menuOnly: false },
  { href: "/swarms", label: "Swarms", menuOnly: false },
  { href: "/connectome", label: "Connectome", menuOnly: false },
  { href: "/agents", label: "Agents", menuOnly: false },
  { href: "/picks", label: "Picks", menuOnly: false },
  { href: "/market", label: "Market", menuOnly: false },
  { href: "/me", label: "My seats", menuOnly: false },
  { href: "/create", label: "Add wallet", menuOnly: true },
  { href: "/methodology", label: "Methodology", menuOnly: true },
] as const;

function isActive(pathname: string | null, href: string) {
  return !!pathname && (pathname === href || pathname.startsWith(`${href}/`));
}

/**
 * Primary navigation. The active-link highlight reads the URL, which is request data under
 * Cache Components, so it streams in behind a Suspense boundary; the fallback is the same nav
 * without highlighting.
 */
export function NavLinks() {
  return (
    <Suspense fallback={<Nav pathname={null} />}>
      <ActiveNav />
    </Suspense>
  );
}

function ActiveNav() {
  return <Nav pathname={usePathname()} />;
}

function Nav({ pathname }: { pathname: string | null }) {
  const { session } = useSession();
  const links = session?.isAdmin ? [...LINKS, { href: "/admin", label: "Admin", menuOnly: false } as const] : LINKS;
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (menuRef.current) menuRef.current.open = false;
  }, [pathname]);

  return (
    <>
      <nav aria-label="Primary" className="hidden lg:block">
        <ul className="flex items-center gap-0.5">
          {links.filter((l) => !l.menuOnly).map((l) => {
            const active = isActive(pathname, l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-lg px-2.5 py-2 text-sm transition-colors xl:px-3 ${
                    active ? "bg-white/[0.06] text-ink" : "text-mute hover:text-ink"
                  }`}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <details ref={menuRef} className="group relative lg:hidden">
        <summary
          className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border border-line-2 px-3 text-sm text-ink-2 [&::-webkit-details-marker]:hidden"
          aria-label="Open menu"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M1 3.5h12M1 7h12M1 10.5h12" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Menu
        </summary>
        <nav
          aria-label="Primary mobile"
          className="absolute left-0 top-11 w-56 rounded-xl border border-line-2 bg-panel p-1.5 shadow-2xl"
        >
          <ul>
            {links.map((l) => {
              const active = isActive(pathname, l.href);
              return (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-lg px-3 py-2.5 text-sm ${active ? "bg-white/[0.06] text-ink" : "text-ink-2"}`}
                  >
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </details>
    </>
  );
}
