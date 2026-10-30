"use client";

import { useState } from "react";
import { ChainActionButton } from "@/components/chain/ChainActionButton";
import { fmtSol, lamportsToSol, solToLamports } from "@/lib/format";

export function SeatActions({
  asset,
  label,
  renewalLamports,
  termDays,
  listing,
}: {
  asset: string;
  label: string;
  renewalLamports: number;
  termDays: number;
  listing: { id: string; priceLamports: number; status: "pending" | "active" } | null;
}) {
  const [listOpen, setListingOpen] = useState(false);
  const [price, setPrice] = useState("");
  const sol = Number(price);
  const valid = price.trim() !== "" && Number.isFinite(sol) && sol > 0 && sol < 1_000_000;
  const renewal = fmtSol(lamportsToSol(renewalLamports), 3);

  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      <ChainActionButton
        endpoint="/api/seats/renew"
        body={{ asset }}
        label={`Renew · ${renewal}`}
        variant="ghost"
        size="sm"
        confirm={
          <>
            Extend <strong className="text-ink">{label}</strong> by {termDays} days for <strong className="num text-ink">{renewal}</strong>.
          </>
        }
      />
      {listing ? (
        <ChainActionButton
          endpoint="/api/market/delist"
          body={{ listingId: listing.id }}
          label={listing.status === "pending" ? "Cancel pending listing" : `Delist (${fmtSol(lamportsToSol(listing.priceLamports), 3)})`}
          variant="danger"
          size="sm"
        />
      ) : listOpen ? (
        <div className="flex flex-wrap items-start gap-2">
          <label className="flex items-center gap-1.5">
            <span className="sr-only">Listing price in SOL for {label}</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.001"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Price"
              className="field h-8 w-28 text-[13px]"
              autoFocus
            />
            <span className="text-xs text-mute">SOL</span>
          </label>
          <ChainActionButton
            endpoint="/api/market/list"
            body={{ asset, priceLamports: valid ? solToLamports(sol) : 0 }}
            label="List"
            size="sm"
            disabled={!valid}
            onDone={() => setListingOpen(false)}
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setListingOpen(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setListingOpen(true)}>
          List for sale
        </button>
      )}
    </div>
  );
}
