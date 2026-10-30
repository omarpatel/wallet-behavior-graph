export const LAMPORTS_PER_SOL = 1_000_000_000;

export const lamportsToSol = (l: number | bigint) => Number(l) / LAMPORTS_PER_SOL;
export const solToLamports = (s: number) => Math.round(s * LAMPORTS_PER_SOL);

export function fmtSol(sol: number | null | undefined, digits = 2): string {
  if (sol == null || !Number.isFinite(sol)) return "—";
  return `${sol.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 })} SOL`;
}

export function fmtUsd(usd: number | null | undefined, compact = true): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  const sign = usd < 0 ? "-" : "";
  const a = Math.abs(usd);
  if (compact && a >= 1_000) {
    return `${sign}$${a.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })}`;
  }
  return `${sign}$${a.toLocaleString("en-US", { maximumFractionDigits: a < 1 ? 4 : 2 })}`;
}

export function fmtPct(ratio: number | null | undefined, digits = 0): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 13s, 4m, 2.5h, 3d */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.abs(sec);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${+(s / 3600).toFixed(1)}h`;
  return `${+(s / 86_400).toFixed(1)}d`;
}

export function shortAddr(a: string, n = 4): string {
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function timeAgo(unixSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  return `${fmtDuration(nowSec - unixSec)} ago`;
}

/** Short name of an attribution source URL ("pump.fun", "X", else the host). */
export function sourceName(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const known: Record<string, string> = {
      "pump.fun": "pump.fun",
      "x.com": "X",
      "twitter.com": "X",
    };
    return known[host] ?? host;
  } catch {
    return null;
  }
}
