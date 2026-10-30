"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useSession } from "@/components/wallet";

/** Re-renders server components when the wallet session changes (sign in / sign out / switch). */
export function RefreshOnSession() {
  const router = useRouter();
  const { session, loading } = useSession();
  const wallet = session?.wallet ?? null;
  const last = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (loading) return;
    if (last.current !== undefined && last.current !== wallet) router.refresh();
    last.current = wallet;
  }, [wallet, loading, router]);

  return null;
}
