// Pure lamport math for primary / renewal / secondary sales. Integer-only; remainders go to the treasury.

/** KOL share of secondary royalties once claimed (collection creators: treasury 50 / KOL 50). */
export const KOL_ROYALTY_PERCENT = 50;

export type PaymentRole = "treasury" | "kol" | "seller" | "creator";
export interface Payment {
  to: string;
  lamports: bigint;
  role: PaymentRole;
}

/** Primary mint / renewal: KOL gets kolShareBps of the price, the treasury gets the rest. */
export function revenueSplit(price: bigint, kolShareBps: number): { kol: bigint; treasury: bigint } {
  const kol = (price * BigInt(kolShareBps)) / 10_000n;
  return { kol, treasury: price - kol };
}

export interface SaleSplitInput {
  price: bigint;
  feeBps: number;
  royaltyBps: number;
  creators: { address: string; percentage: number }[];
  seller: string;
  treasury: string;
  /** Claimed brain's payout wallet (null when unclaimed). */
  kolWallet: string | null;
  /** Pay the KOL creator share inline (claimed && !revenueHeld). Otherwise it goes to the treasury, accrued. */
  kolInline: boolean;
}

export interface SaleSplit {
  fee: bigint;
  royaltyTotal: bigint;
  /** KOL portion of the royalty (inline or accrued). */
  kolRoyalty: bigint;
  /** The KOL creator share is a payment in this split (still subject to rent routing). */
  kolRoyaltyInline: boolean;
  sellerProceeds: bigint;
  payments: Payment[];
}

/** Secondary sale: buyer pays `price`; seller gets price − royalty − fee. */
export function saleSplit(i: SaleSplitInput): SaleSplit {
  const fee = (i.price * BigInt(i.feeBps)) / 10_000n;
  const royaltyTotal = (i.price * BigInt(i.royaltyBps)) / 10_000n;
  const sellerProceeds = i.price - fee - royaltyTotal;
  if (sellerProceeds <= 0n) throw new Error("Price too low to cover royalty and market fee");

  const payments: Payment[] = [{ to: i.seller, lamports: sellerProceeds, role: "seller" }];
  let treasury = fee;
  let kolRoyalty = 0n;
  let kolFound = false;
  let distributed = 0n;
  for (const c of i.creators) {
    const amt = (royaltyTotal * BigInt(c.percentage)) / 100n;
    distributed += amt;
    if (c.address === i.treasury) treasury += amt;
    else if (i.kolWallet && c.address === i.kolWallet) {
      kolFound = true;
      kolRoyalty += amt;
      if (i.kolInline) payments.push({ to: c.address, lamports: amt, role: "kol" });
      else treasury += amt;
    } else payments.push({ to: c.address, lamports: amt, role: "creator" });
  }
  // Rounding remainder (or royalties with no creators) → treasury.
  treasury += royaltyTotal - distributed;
  // Unclaimed brains (or royalties not yet updated after a claim): the treasury collects the whole
  // royalty on-chain and the KOL half accrues in the ledger.
  if (!kolFound) kolRoyalty = (royaltyTotal * BigInt(KOL_ROYALTY_PERCENT)) / 100n;
  payments.push({ to: i.treasury, lamports: treasury, role: "treasury" });
  return { fee, royaltyTotal, kolRoyalty, kolRoyaltyInline: kolFound && i.kolInline, sellerProceeds, payments };
}

/**
 * Rent-exempt pitfall: a transfer below the rent-exempt minimum to an unfunded (0-lamport) account
 * fails the whole transaction. Such payments are routed to the treasury instead. Treasury payments are
 * merged into one transfer; zero-lamport payments are dropped.
 */
export function routePayments(
  payments: Payment[],
  treasury: string,
  funded: ReadonlySet<string>,
  rentMin: bigint,
): { transfers: { to: string; lamports: bigint }[]; rerouted: Payment[] } {
  const out = new Map<string, bigint>();
  const rerouted: Payment[] = [];
  for (const p of payments) {
    if (p.lamports <= 0n) continue;
    let to = p.to;
    if (to !== treasury && p.lamports < rentMin && !funded.has(to)) {
      rerouted.push(p);
      to = treasury;
    }
    out.set(to, (out.get(to) ?? 0n) + p.lamports);
  }
  const t = out.get(treasury);
  if (t !== undefined && t < rentMin && !funded.has(treasury)) {
    throw new Error(`Treasury ${treasury} is unfunded; fund it with at least ${rentMin} lamports`);
  }
  return { transfers: [...out].map(([to, lamports]) => ({ to, lamports })), rerouted };
}
