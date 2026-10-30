"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fmtSol, lamportsToSol } from "@/lib/format";

export interface RevenueView {
  accruedLamports: number;
  paidInlineLamports: number;
  paidOutLamports: number;
  pendingPayoutLamports: number;
}

/** Shown only when the signed-in wallet is this brain's wallet. */
export function ClaimPanel({
  brainId,
  status,
  xLinked,
  revenue,
}: {
  brainId: string;
  status: "unclaimed" | "claimed";
  xLinked: boolean;
  revenue: RevenueView | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accrued, setAccrued] = useState<number | null>(null);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/claim/${encodeURIComponent(brainId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await r.json().catch(() => null)) as { ok?: boolean; accruedLamports?: number; error?: string } | null;
      if (!r.ok || !body?.ok) throw new Error(body?.error ?? `Claim failed (HTTP ${r.status})`);
      setAccrued(body.accruedLamports ?? 0);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (status === "unclaimed") {
    return (
      <section aria-labelledby="claim-title" className="card space-y-3 border-accent/30 p-5">
        <h2 id="claim-title" className="text-sm font-semibold text-ink">
          This is your wallet — claim this brain
        </h2>
        <p className="text-xs leading-relaxed text-ink-2">
          You are signed in with the brain&apos;s wallet. Claiming marks the brain as owner-verified and lets you link X to
          enable the say-vs-do ledger.
        </p>
        <button type="button" className="btn btn-primary" onClick={claim} disabled={busy}>
          {busy ? "Claiming…" : "Claim brain"}
        </button>
        {accrued != null && (
          <p className="text-xs text-up" role="status">
            Claimed. {accrued > 0 ? `${fmtSol(lamportsToSol(accrued), 4)} accrued revenue is queued for payout.` : ""}
          </p>
        )}
        {error && (
          <p className="text-xs text-down" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="owner-title" className="card space-y-4 p-5">
      <h2 id="owner-title" className="text-sm font-semibold text-ink">
        Owner panel
      </h2>
      {revenue && (
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="eyebrow">Paid at sale</dt>
            <dd className="num mt-1 text-sm text-ink">{fmtSol(lamportsToSol(revenue.paidInlineLamports), 4)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Accrued</dt>
            <dd className="num mt-1 text-sm text-ink">{fmtSol(lamportsToSol(revenue.accruedLamports), 4)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Paid out</dt>
            <dd className="num mt-1 text-sm text-ink">{fmtSol(lamportsToSol(revenue.paidOutLamports), 4)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Payout pending</dt>
            <dd className="num mt-1 text-sm text-ink">{fmtSol(lamportsToSol(revenue.pendingPayoutLamports), 4)}</dd>
          </div>
        </dl>
      )}
      {xLinked ? (
        <p className="text-xs text-up">X account linked — say-vs-do ledger is active.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-ink-2">
            Link your X account to show tweet-to-trade receipts on this page (opt-in; uses the official X API).
          </p>
          <a href={`/api/claim/x/start?brainId=${encodeURIComponent(brainId)}`} className="btn btn-ghost btn-sm">
            Link X account
          </a>
        </div>
      )}
      <p className="text-[11px] text-mute">
        Selling ≥50% of an alerted position within 60 minutes flags this brain for review.
      </p>
    </section>
  );
}
