import { describe, expect, it } from "vitest";
import { revenueSplit, routePayments, saleSplit } from "./splits";

const T = "Treasury1111111111111111111111111111111111";
const K = "Kol11111111111111111111111111111111111111111";
const S = "Seller1111111111111111111111111111111111111";
const RENT = 890_880n;

describe("revenueSplit", () => {
  it("gives the KOL kolShareBps and the remainder to the treasury", () => {
    expect(revenueSplit(250_000_001n, 3000)).toEqual({ kol: 75_000_000n, treasury: 175_000_001n });
  });
});

describe("saleSplit", () => {
  const base = { price: 100_000_000n, feeBps: 250, royaltyBps: 500, seller: S, treasury: T };

  it("pays the claimed KOL its creator share inline", () => {
    const s = saleSplit({
      ...base,
      creators: [
        { address: T, percentage: 50 },
        { address: K, percentage: 50 },
      ],
      kolWallet: K,
      kolInline: true,
    });
    expect(s.sellerProceeds).toBe(92_500_000n);
    expect(s.kolRoyalty).toBe(2_500_000n);
    expect(s.kolRoyaltyInline).toBe(true);
    expect(s.payments).toEqual([
      { to: S, lamports: 92_500_000n, role: "seller" },
      { to: K, lamports: 2_500_000n, role: "kol" },
      { to: T, lamports: 5_000_000n, role: "treasury" },
    ]);
  });

  it("accrues the KOL half to the treasury for unclaimed brains", () => {
    const s = saleSplit({ ...base, creators: [{ address: T, percentage: 100 }], kolWallet: null, kolInline: false });
    expect(s.kolRoyalty).toBe(2_500_000n);
    expect(s.kolRoyaltyInline).toBe(false);
    expect(s.payments.at(-1)).toEqual({ to: T, lamports: 7_500_000n, role: "treasury" });
  });

  it("holds the KOL share in the treasury while revenue is held", () => {
    const s = saleSplit({
      ...base,
      creators: [
        { address: T, percentage: 50 },
        { address: K, percentage: 50 },
      ],
      kolWallet: K,
      kolInline: false,
    });
    expect(s.payments.some((p) => p.role === "kol")).toBe(false);
    expect(s.kolRoyalty).toBe(2_500_000n);
  });
});

describe("routePayments", () => {
  it("routes sub-rent payments to unfunded accounts into the treasury and merges treasury transfers", () => {
    const r = routePayments(
      [
        { to: S, lamports: 5_000_000n, role: "seller" },
        { to: K, lamports: 400_000n, role: "kol" },
        { to: T, lamports: 100_000n, role: "treasury" },
      ],
      T,
      new Set([T]),
      RENT,
    );
    expect(r.transfers).toEqual([
      { to: S, lamports: 5_000_000n },
      { to: T, lamports: 500_000n },
    ]);
    expect(r.rerouted.map((p) => p.role)).toEqual(["kol"]);
  });

  it("keeps sub-rent payments to funded accounts", () => {
    const r = routePayments([{ to: K, lamports: 400_000n, role: "kol" }], T, new Set([K]), RENT);
    expect(r.transfers).toEqual([{ to: K, lamports: 400_000n }]);
  });

  it("throws when the treasury itself is unfunded and the amount is below rent", () => {
    expect(() => routePayments([{ to: T, lamports: 1_000n, role: "treasury" }], T, new Set(), RENT)).toThrow(/unfunded/);
  });
});
