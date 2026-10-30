"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface ClientSession {
  wallet: string;
  isAdmin: boolean;
}

interface SessionState {
  session: ClientSession | null;
  loading: boolean;
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

async function fetchSession(): Promise<ClientSession | null> {
  try {
    const res = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
    return res.ok ? ((await res.json()) as ClientSession | null) : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ClientSession | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setSession(await fetchSession());
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchSession().then((s) => {
      if (cancelled) return;
      setSession(s);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ session, loading, refresh }), [session, loading, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** SIWS session shared across the app (cookie-backed; `/api/auth/me`). */
export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <WalletProviders>");
  return ctx;
}
