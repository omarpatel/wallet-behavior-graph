import { createHash } from "node:crypto";

const ADJECTIVES = [
  "Amber", "Arctic", "Ashen", "Azure", "Basalt", "Blazing", "Bronze", "Cobalt", "Crimson", "Cyber",
  "Dusky", "Ember", "Feral", "Frost", "Gilded", "Granite", "Hollow", "Indigo", "Iron", "Jade",
  "Lunar", "Molten", "Neon", "Nova", "Obsidian", "Onyx", "Phantom", "Quartz", "Rogue", "Ruby",
  "Rusted", "Sable", "Scarlet", "Shadow", "Silent", "Silver", "Solar", "Static", "Storm", "Teal",
  "Thunder", "Titan", "Velvet", "Violet", "Wild", "Zinc",
];

const ANIMALS = [
  "Badger", "Barracuda", "Bison", "Cobra", "Condor", "Coyote", "Falcon", "Ferret", "Gecko", "Hawk",
  "Heron", "Hornet", "Hyena", "Ibis", "Jackal", "Jaguar", "Kestrel", "Lynx", "Mako", "Mamba",
  "Manta", "Marten", "Mantis", "Moth", "Narwhal", "Ocelot", "Orca", "Osprey", "Otter", "Panther",
  "Pike", "Puma", "Raven", "Shrike", "Stingray", "Stoat", "Swift", "Tapir", "Viper", "Vulture",
  "Walrus", "Wasp", "Wolf", "Wolverine", "Yak",
];

const SPACE = ADJECTIVES.length * ANIMALS.length;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** A wallet's probe walk over the adjective×animal space: start pair + a stride coprime to the space size. */
function probe(wallet: string): { start: number; stride: number } {
  const h = createHash("sha256").update(wallet).digest();
  const start = (h.readUInt16BE(0) % ADJECTIVES.length) * ANIMALS.length + (h.readUInt16BE(2) % ANIMALS.length);
  let stride = h.readUInt32BE(4) % SPACE;
  while (stride === 0 || gcd(stride, SPACE) !== 1) stride = (stride + 1) % SPACE;
  return { start, stride };
}

function candidate({ start, stride }: { start: number; stride: number }, k: number): string {
  const i = (start + (k % SPACE) * stride) % SPACE;
  const round = Math.floor(k / SPACE);
  return `${ADJECTIVES[Math.floor(i / ANIMALS.length)]} ${ANIMALS[i % ANIMALS.length]}${round ? ` ${round + 1}` : ""}`;
}

/**
 * The k-th codename candidate for a wallet. k = 0 is `codenameFor(wallet)`; the walk visits every adjective×animal pair
 * exactly once, then repeats it with a numeric suffix ("Cobalt Osprey 2").
 */
export function codenameCandidate(wallet: string, k: number): string {
  return candidate(probe(wallet), k);
}

/** Neutral, deterministic preferred codename for a wallet, e.g. "Cobalt Osprey". Never implies a person. */
export function codenameFor(wallet: string): string {
  return codenameCandidate(wallet, 0);
}

/** First codename on the wallet's probe walk that is not `taken` (codenames are unique across brains). */
export function pickCodename(wallet: string, taken: ReadonlySet<string>): string {
  const p = probe(wallet);
  for (let k = 0; ; k++) {
    const name = candidate(p, k);
    if (!taken.has(name)) return name;
  }
}

/**
 * Deterministic repair of shared codenames: in each group of brains sharing a codename the lowest-sorted wallet keeps
 * it and every other one (in wallet order) takes the first free name on its own probe walk. Unique codenames never
 * change. Returns wallet → new codename for the renamed brains only (empty when already unique).
 */
export function resolveCodenameCollisions(rows: readonly { wallet: string; codename: string }[]): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const r of rows) {
    const group = byName.get(r.codename);
    if (group) group.push(r.wallet);
    else byName.set(r.codename, [r.wallet]);
  }
  const losers: string[] = [];
  for (const wallets of byName.values()) {
    if (wallets.length > 1) losers.push(...wallets.sort().slice(1));
  }
  const taken = new Set(byName.keys());
  const renames = new Map<string, string>();
  for (const wallet of losers.sort()) {
    const name = pickCodename(wallet, taken);
    taken.add(name);
    renames.set(wallet, name);
  }
  return renames;
}

/** URL slug for a brain: attributed handle when known, else codename + wallet prefix. */
export function brainSlug(codename: string, wallet: string, handle?: string | null): string {
  if (handle) return handle.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return `${codename.toLowerCase().replace(/\s+/g, "-")}-${wallet.slice(0, 4).toLowerCase()}`;
}
