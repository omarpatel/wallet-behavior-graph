/**
 * pump.fun bonding curve account decoding and pricing. Account sizes seen on mainnet:
 * 115 and 151 bytes; the fields below live in the first 49 bytes after the 8-byte Anchor discriminator.
 */
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MIN_LEN = 49;
/** Raw token units per whole token (pump.fun mints use 6 decimals). */
export const PUMP_DECIMALS = 6;
const INIT_VIRTUAL_SOL = 30_000_000_000n;
const INIT_VIRTUAL_TOKENS = 1_073_000_000_000_000n;
const INIT_REAL_TOKENS = 793_100_000_000_000n;

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export function decodeBondingCurve(data: Uint8Array): BondingCurve | null {
  if (data.length < MIN_LEN) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u = (o: number) => v.getBigUint64(o, true);
  return {
    virtualTokenReserves: u(8),
    virtualSolReserves: u(16),
    realTokenReserves: u(24),
    realSolReserves: u(32),
    tokenTotalSupply: u(40),
    complete: data[48] !== 0,
  };
}

/** `real_sol_reserves` at which the curve completes (derived from the constant product; ≈ 85.005 SOL). */
export function graduationLamports(): bigint {
  const k = INIT_VIRTUAL_SOL * INIT_VIRTUAL_TOKENS;
  return k / (INIT_VIRTUAL_TOKENS - INIT_REAL_TOKENS) - INIT_VIRTUAL_SOL;
}

/** SOL per whole token. */
export function curvePriceSol(c: BondingCurve): number | null {
  if (c.virtualTokenReserves === 0n) return null;
  return Number(c.virtualSolReserves) / 1e9 / (Number(c.virtualTokenReserves) / 10 ** PUMP_DECIMALS);
}

export function curveProgress(c: BondingCurve): number {
  return Math.min(1, Number(c.realSolReserves) / Number(graduationLamports()));
}

/** Whole-token total supply (pump.fun: 1e9). */
export function curveSupply(c: BondingCurve): number {
  return Number(c.tokenTotalSupply) / 10 ** PUMP_DECIMALS;
}
