import Link from "next/link";
import { DISCLAIMER } from "@/components/ui/Disclaimer";
import { Logo } from "./Logo";

const LEGAL = [
  { href: "/create", label: "Add a wallet" },
  { href: "/methodology", label: "Methodology" },
  { href: "/disclaimer", label: "Disclaimer" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/disputes", label: "Disputes & opt-out" },
];

export function SiteFooter() {
  return (
    <footer className="relative z-10 mt-24 border-t border-line">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_1fr]">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xl text-xs leading-relaxed text-mute">{DISCLAIMER}</p>
          <p className="max-w-xl text-xs leading-relaxed text-faint">
            Seats are term-limited access memberships to analysis. They carry no revenue share, yield or claim on
            any income. Unclaimed brains are unaffiliated analyses of public wallets and are not endorsed by the
            people publicly attributed to them.
          </p>
        </div>
        <nav aria-label="Legal" className="md:justify-self-end">
          <ul className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            {LEGAL.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="text-ink-2 hover:text-accent">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
