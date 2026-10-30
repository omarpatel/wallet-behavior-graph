import Link from "next/link";
import { RefreshOnSession } from "@/components/RefreshOnSession";
import { ConnectButton } from "@/components/wallet";
import { Logo } from "./Logo";
import { NavLinks } from "./NavLinks";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-xl">
      <RefreshOnSession />
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" aria-label="Wallet Behavior Graph home" className="shrink-0">
          <Logo />
        </Link>
        <NavLinks />
        <div className="ml-auto flex items-center gap-2">
          <ConnectButton className="[&_button]:whitespace-nowrap" />
        </div>
      </div>
    </header>
  );
}
