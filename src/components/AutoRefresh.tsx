"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server tree periodically (e.g. while a backfill is running). */
export function AutoRefresh({ everyMs = 10_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
