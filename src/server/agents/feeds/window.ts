/**
 * Per-token rolling sample window (sniper tracker.rs): price and, for bonding curves, real SOL reserves.
 * Every derived number returns null when the history does not cover the window — callers must treat that as
 * "unknown", never as zero.
 */
export interface Sample {
  t: number; // unix s
  priceUsd: number;
  /** Real SOL in the bonding curve (lamports); null for pools. */
  reserveLamports: number | null;
}

const MAX_SAMPLES = 240;
/** Samples closer than this replace the previous one (keeps the window bounded under fast sweeps). */
const MIN_GAP_SEC = 2;
/** A base sample may be this much younger than the window start and still count as covering it. */
const COVERAGE = 0.8;

export class RollingWindow {
  private samples: Sample[] = [];

  push(s: Sample): void {
    const last = this.samples.at(-1);
    if (last && s.t < last.t) return;
    if (last && s.t - last.t < MIN_GAP_SEC && this.samples.length > 1) this.samples[this.samples.length - 1] = s;
    else this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  get size(): number {
    return this.samples.length;
  }

  get last(): Sample | null {
    return this.samples.at(-1) ?? null;
  }

  get first(): Sample | null {
    return this.samples[0] ?? null;
  }

  /**
   * The sample to measure from for a trailing window ending at the newest sample: the latest one at or before the
   * window start, or the oldest one when it is at least COVERAGE × window old. Null without coverage.
   */
  private base(windowSec: number): Sample | null {
    const last = this.samples.at(-1);
    if (!last || this.samples.length < 2) return null;
    const start = last.t - windowSec;
    let base: Sample | null = null;
    for (const s of this.samples) {
      if (s.t <= start) base = s;
      else break;
    }
    if (base) return last.t - base.t <= windowSec * 2 ? base : null;
    const oldest = this.samples[0];
    return last.t - oldest.t >= windowSec * COVERAGE ? oldest : null;
  }

  /** % price change over the trailing window, or null (unknown). */
  changePct(windowSec: number): number | null {
    const b = this.base(windowSec);
    const last = this.samples.at(-1);
    if (!b || !last || b.priceUsd <= 0) return null;
    return (last.priceUsd / b.priceUsd - 1) * 100;
  }

  /** Net lamports into the curve over the trailing window, or null (unknown / not a curve). */
  netInflowLamports(windowSec: number): number | null {
    const b = this.base(windowSec);
    const last = this.samples.at(-1);
    if (!b || !last || b.reserveLamports == null || last.reserveLamports == null) return null;
    return last.reserveLamports - b.reserveLamports;
  }

  /** Highest price since `sinceT` (inclusive), or null. */
  peakSince(sinceT: number): number | null {
    let peak: number | null = null;
    for (const s of this.samples) if (s.t >= sinceT && (peak == null || s.priceUsd > peak)) peak = s.priceUsd;
    return peak;
  }

  /** Seconds since the reserves last changed (curve idleness), or null. */
  idleSec(now: number): number | null {
    const last = this.samples.at(-1);
    if (!last || last.reserveLamports == null) return null;
    for (let i = this.samples.length - 1; i > 0; i--) {
      if (this.samples[i].reserveLamports !== this.samples[i - 1].reserveLamports) return now - this.samples[i].t;
    }
    return now - this.samples[0].t;
  }
}
