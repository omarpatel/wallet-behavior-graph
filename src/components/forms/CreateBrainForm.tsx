"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ConnectButton, useSession } from "@/components/wallet";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function CreateBrainForm() {
  const router = useRouter();
  const { session, loading } = useSession();
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = wallet.trim();
  const valid = BASE58.test(trimmed);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/brains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: trimmed }),
      });
      const body = (await r.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!r.ok || !body?.id) throw new Error(body?.error ?? `Request failed (HTTP ${r.status})`);
      router.push(`/brains/${encodeURIComponent(body.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <div className="card flex flex-col items-start gap-3 p-6">
        <p className="text-sm text-ink">{loading ? "Checking session…" : "Sign in with your wallet to add a brain."}</p>
        <p className="text-xs text-mute">Signing in is a one-time message signature — no transaction, no fee.</p>
        <ConnectButton />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6" noValidate>
      <div>
        <label htmlFor="wallet" className="mb-2 block text-sm font-medium text-ink">
          Solana wallet address
        </label>
        <input
          id="wallet"
          name="wallet"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="e.g. 7xKX…"
          className="field num"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={trimmed !== "" && !valid}
          aria-describedby="wallet-help"
          required
        />
        <p id="wallet-help" className={`mt-2 text-xs ${trimmed !== "" && !valid ? "text-down" : "text-mute"}`}>
          {trimmed !== "" && !valid
            ? "That doesn't look like a base58 Solana address."
            : "The brain gets a neutral codename. A name is shown only if the owner claims it or the configured wallet directory lists it with a public label."}
        </p>
      </div>
      <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
        {busy ? "Creating…" : "Create brain"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
    </form>
  );
}
