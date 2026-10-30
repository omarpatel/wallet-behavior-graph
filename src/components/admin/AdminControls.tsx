"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { lamportsToSol, solToLamports } from "@/lib/format";

async function post(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const b = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `HTTP ${r.status}`);
  }
}

function useAdminPost() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await post(url, body);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export interface AdminBrainControlsProps {
  id: string;
  listed: boolean;
  priceOverride: boolean;
  seatSupply: number;
  seatsMinted: number;
  seatPriceLamports: number;
  renewalPriceLamports: number;
  alertDelaySec: number;
  revenueHeld: boolean;
}

export function AdminBrainControls(p: AdminBrainControlsProps) {
  const url = `/api/admin/brains/${encodeURIComponent(p.id)}`;
  const { busy, error, run } = useAdminPost();
  const [supply, setSupply] = useState(String(p.seatSupply));
  const [price, setPrice] = useState(String(lamportsToSol(p.seatPriceLamports)));
  const [renewal, setRenewal] = useState(String(lamportsToSol(p.renewalPriceLamports)));
  const [delay, setDelay] = useState(String(p.alertDelaySec));

  function savePricing(e: FormEvent) {
    e.preventDefault();
    void run(url, {
      priceOverride: true,
      seatSupply: Number(supply),
      seatPriceLamports: solToLamports(Number(price)),
      renewalPriceLamports: solToLamports(Number(renewal)),
    });
  }

  function saveDelay(e: FormEvent) {
    e.preventDefault();
    void run(url, { alertDelaySec: Number(delay) });
  }

  const num = "field h-8 w-20 px-2 text-xs num";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={p.listed} disabled={busy} onChange={(e) => void run(url, { listed: e.target.checked })} className="accent-[#c6ff3a]" />
          Listed
        </label>
        {p.priceOverride && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(url, { priceOverride: false })}>
            Use tier pricing
          </button>
        )}
        {p.revenueHeld && (
          <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void run(url, { clearRevenueHold: true })}>
            Clear revenue hold
          </button>
        )}
      </div>
      <form onSubmit={savePricing} className="flex flex-wrap items-end gap-2" aria-label={`Pricing override for ${p.id}`}>
        <label className="text-[10px] text-mute">
          Supply (≥{p.seatsMinted})
          <input className={num} type="number" min={Math.max(1, p.seatsMinted)} value={supply} onChange={(e) => setSupply(e.target.value)} />
        </label>
        <label className="text-[10px] text-mute">
          Mint SOL
          <input className={num} type="number" min="0" step="0.001" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="text-[10px] text-mute">
          Renew SOL
          <input className={num} type="number" min="0" step="0.001" value={renewal} onChange={(e) => setRenewal(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-ghost btn-sm" disabled={busy}>
          Override
        </button>
      </form>
      <form onSubmit={saveDelay} className="flex items-end gap-2" aria-label={`Alert delay for ${p.id}`}>
        <label className="text-[10px] text-mute">
          Alert delay s
          <input className={num} type="number" min="0" max="86400" value={delay} onChange={(e) => setDelay(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-ghost btn-sm" disabled={busy}>
          Save
        </button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-down">
          {error}
        </p>
      )}
    </div>
  );
}

export function DisputeStatusButton({ id, status }: { id: number; status: "open" | "resolved" }) {
  const { busy, error, run } = useAdminPost();
  return (
    <div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => void run(`/api/admin/disputes/${id}`, { status: status === "open" ? "resolved" : "open" })}
      >
        {status === "open" ? "Resolve" : "Reopen"}
      </button>
      {error && <p className="mt-1 text-xs text-down">{error}</p>}
    </div>
  );
}
