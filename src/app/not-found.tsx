import Link from "next/link";
import { Container } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <Container className="max-w-xl py-24 text-center">
      <p className="num text-sm text-accent">404</p>
      <h1 className="mt-3 font-display text-4xl text-ink">Nothing here</h1>
      <p className="mt-4 text-sm text-ink-2">This brain or page doesn&apos;t exist. It may have been removed after an opt-out request.</p>
      <div className="mt-8 flex justify-center gap-3">
        <Link href="/brains" className="btn btn-primary">
          Explore brains
        </Link>
        <Link href="/" className="btn btn-ghost">
          Home
        </Link>
      </div>
    </Container>
  );
}
