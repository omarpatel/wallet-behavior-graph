"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { SolanaSignInInput } from "@solana/wallet-standard-features";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { shortAddr } from "@/lib/format";
import { bytesToBase64 } from "./base64";
import { apiErrorMessage } from "./http";
import { useSession } from "./session";

/** Connect → SIWS sign-in (wallet `signIn`, or `signMessage` fallback) → session cookie. Dropdown with sign out. */
export function ConnectButton({ className = "" }: { className?: string }) {
  const { publicKey, connected, connecting, signIn, signMessage, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const { session, loading, refresh } = useSession();
  // false during SSR/hydration, true on the client (avoids wallet-state hydration mismatch).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const wantSignIn = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const address = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const doSignIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const inputRes = await fetch("/api/auth/siws", { cache: "no-store" });
      if (!inputRes.ok) throw new Error(await apiErrorMessage(inputRes));
      const input = (await inputRes.json()) as SolanaSignInInput;
      let body: Record<string, string>;
      if (signIn) {
        const out = await signIn(input);
        body = {
          nonce: input.nonce!,
          address: out.account.address,
          signedMessage: bytesToBase64(out.signedMessage),
          signature: bytesToBase64(out.signature),
        };
      } else if (signMessage && address) {
        const text = createSignInMessageText({ ...input, domain: input.domain!, address });
        const signature = await signMessage(new TextEncoder().encode(text));
        body = { nonce: input.nonce!, address, signature: bytesToBase64(signature), mode: "signMessage" };
      } else {
        throw new Error("This wallet cannot sign messages");
      }
      const res = await fetch("/api/auth/siws", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [signIn, signMessage, address, refresh]);

  // Sign in right after a user-initiated connect (not on silent auto-connect).
  useEffect(() => {
    if (connected && address && wantSignIn.current && !loading && session?.wallet !== address) {
      wantSignIn.current = false;
      void doSignIn();
    }
  }, [connected, address, session, loading, doSignIn]);

  const signOut = useCallback(async () => {
    setOpen(false);
    await fetch("/api/auth/logout", { method: "POST" });
    await disconnect().catch(() => undefined);
    await refresh();
  }, [disconnect, refresh]);

  const base =
    "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors disabled:cursor-wait disabled:opacity-60";
  const primary = `${base} border-accent/40 bg-accent text-accent-ink hover:bg-accent-2`;
  const ghost = `${base} border-line-2 bg-panel text-ink hover:border-accent/50`;

  if (!mounted || loading) {
    return (
      <button type="button" disabled className={`${ghost} ${className}`} aria-busy>
        <span className="h-2 w-16 animate-pulse rounded bg-line-2" />
      </button>
    );
  }

  if (session) {
    const mismatch = connected && address !== null && address !== session.wallet;
    return (
      <div ref={menuRef} className={`relative ${className}`}>
        <button type="button" className={ghost} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={`h-2 w-2 rounded-full ${mismatch ? "bg-warn" : "bg-up"}`} />
          <span className="font-mono">
            <span className="sm:hidden">{shortAddr(session.wallet, 3)}</span>
            <span className="hidden sm:inline">{shortAddr(session.wallet)}</span>
          </span>
          {session.isAdmin && <span className="hidden rounded bg-info/20 px-1.5 text-[10px] uppercase text-info sm:inline">admin</span>}
        </button>
        {open && (
          <div className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-[var(--radius-card)] border border-line-2 bg-panel-2 p-1 text-sm shadow-xl">
            <div className="px-3 py-2 text-xs text-mute">
              Signed in as
              <div className="mt-0.5 break-all font-mono text-ink-2">{session.wallet}</div>
            </div>
            {mismatch && (
              <button
                type="button"
                className="w-full rounded-lg px-3 py-2 text-left text-warn hover:bg-panel"
                onClick={() => {
                  setOpen(false);
                  void doSignIn();
                }}
              >
                Connected wallet differs — sign in as {shortAddr(address!)}
              </button>
            )}
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-left text-ink-2 hover:bg-panel hover:text-ink"
              onClick={() => {
                void navigator.clipboard.writeText(session.wallet);
                setOpen(false);
              }}
            >
              Copy address
            </button>
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-left text-down hover:bg-panel"
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`relative inline-flex flex-col items-end ${className}`}>
      {connected ? (
        <button type="button" className={primary} disabled={busy} onClick={() => void doSignIn()}>
          {busy ? (
            "Check your wallet…"
          ) : (
            <>
              <span className="sm:hidden">Sign in</span>
              <span className="hidden sm:inline">Sign in · {shortAddr(address ?? "")}</span>
            </>
          )}
        </button>
      ) : (
        <button
          type="button"
          className={primary}
          disabled={connecting || busy}
          onClick={() => {
            wantSignIn.current = true;
            setError(null);
            setVisible(true);
          }}
        >
          {connecting ? (
            "Connecting…"
          ) : (
            <>
              <span className="sm:hidden">Connect</span>
              <span className="hidden sm:inline">Connect wallet</span>
            </>
          )}
        </button>
      )}
      {error && (
        <p role="alert" className="absolute top-full mt-1 max-w-64 text-right text-xs text-down">
          {error}
        </p>
      )}
    </div>
  );
}
