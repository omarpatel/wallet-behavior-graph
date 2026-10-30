"use client";

import { Container } from "@/components/ui/primitives";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const missingConfig = error.name === "MissingConfigError" || error.message.startsWith("Missing configuration");
  return (
    <Container className="max-w-xl py-24 text-center">
      <p className="num text-sm text-down">Error</p>
      <h1 className="mt-3 font-display text-4xl text-ink">{missingConfig ? "Not configured" : "Something broke"}</h1>
      <p className="num mt-4 break-words text-sm text-ink-2">
        {missingConfig ? error.message : "The page failed to load. The error has been logged."}
        {error.digest && <span className="mt-2 block text-xs text-mute">ref {error.digest}</span>}
      </p>
      <button type="button" onClick={reset} className="btn btn-ghost mt-8">
        Try again
      </button>
    </Container>
  );
}
