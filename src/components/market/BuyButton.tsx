"use client";

import { useSession } from "@/components/wallet";
import { ChainActionButton } from "@/components/chain/ChainActionButton";

export function BuyButton({ listingId, seller, priceLabel, seatLabel }: { listingId: string; seller: string; priceLabel: string; seatLabel: string }) {
  const { session } = useSession();
  if (session?.wallet === seller) return <span className="text-xs text-mute">Your listing</span>;
  return (
    <ChainActionButton
      endpoint="/api/market/buy"
      body={{ listingId }}
      label="Buy"
      size="sm"
      confirm={
        <>
          Buy <strong className="text-ink">{seatLabel}</strong> for <strong className="num text-ink">{priceLabel}</strong>. Access is
          granted for the seat&apos;s remaining term; creator royalty and marketplace fee are included in the transaction.
        </>
      }
    />
  );
}
