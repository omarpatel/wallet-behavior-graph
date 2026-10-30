/**
 * PumpPortal data websocket (keyless): new pump.fun/bonk tokens and pump.fun migrations in real time.
 * Per-token trade streams need a funded PumpPortal API key, so trades/prices come from on-chain curve sweeps instead
 * (hub.ts). Reconnects with exponential backoff (1 s → 60 s, reset after 60 s of healthy connection); a watchdog
 * reconnects when no message arrives for 90 s.
 */
export interface PumpCreate {
  mint: string;
  name: string | null;
  symbol: string | null;
  pool: string; // "pump" | "bonk" | …
  bondingCurveKey: string | null;
  marketCapSol: number | null;
  vSolInBondingCurve: number | null;
  creator: string | null;
  at: number; // unix s (receive time)
}

export interface PumpMigration {
  mint: string;
  pool: string | null; // "pump-amm" | "raydium" …
  at: number;
}

export interface PumpPortalStats {
  connected: boolean;
  connectedSince: number | null;
  connects: number;
  reconnects: number;
  messages: number;
  creates: number;
  migrations: number;
  lastMessageAt: number | null;
  lastError: string | null;
}

const WATCHDOG_MS = 90_000;
const BACKOFF_MAX_MS = 60_000;

export class PumpPortalFeed {
  readonly stats: PumpPortalStats = {
    connected: false,
    connectedSince: null,
    connects: 0,
    reconnects: 0,
    messages: 0,
    creates: 0,
    migrations: 0,
    lastMessageAt: null,
    lastError: null,
  };
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1_000;
  private retryTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;

  constructor(
    private readonly url: string,
    private readonly handlers: { onCreate: (c: PumpCreate) => void; onMigration: (m: PumpMigration) => void; log: (msg: string) => void },
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      const last = this.stats.lastMessageAt ?? 0;
      if (this.ws && this.stats.connected && Date.now() / 1000 - last > WATCHDOG_MS / 1000) {
        this.handlers.log(`pumpportal: no message for ${WATCHDOG_MS / 1000}s, reconnecting`);
        this.ws.close();
      }
    }, 15_000);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let openedAt = 0;
    ws.onopen = () => {
      openedAt = Date.now();
      this.stats.connects++;
      this.stats.connected = true;
      this.stats.connectedSince = Math.floor(openedAt / 1000);
      this.stats.lastMessageAt = Math.floor(openedAt / 1000);
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      this.handlers.log(`pumpportal: connected (${this.stats.connects} connects)`);
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onerror = (ev) => {
      this.stats.lastError = "message" in ev && typeof ev.message === "string" ? ev.message : "websocket error";
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.stats.connected = false;
      this.stats.connectedSince = null;
      this.ws = null;
      if (this.stopped) return;
      if (openedAt && Date.now() - openedAt > 60_000) this.backoffMs = 1_000;
      this.stats.reconnects++;
      this.handlers.log(`pumpportal: closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}); reconnecting in ${this.backoffMs / 1000}s`);
      this.retryTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    };
  }

  private onMessage(raw: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.stats.messages++;
    this.stats.lastMessageAt = now;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
    const num = (k: string) => (typeof m[k] === "number" && Number.isFinite(m[k]) ? (m[k] as number) : null);
    const mint = str("mint");
    if (!mint) return;
    if (m.txType === "create") {
      this.stats.creates++;
      this.handlers.onCreate({
        mint,
        name: str("name"),
        symbol: str("symbol"),
        pool: str("pool") ?? "pump",
        bondingCurveKey: str("bondingCurveKey"),
        marketCapSol: num("marketCapSol"),
        vSolInBondingCurve: num("vSolInBondingCurve"),
        creator: str("traderPublicKey"),
        at: now,
      });
    } else if (m.txType === "migrate") {
      this.stats.migrations++;
      this.handlers.onMigration({ mint, pool: str("pool"), at: now });
    }
  }
}
