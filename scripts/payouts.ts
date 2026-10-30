// Sends pending KOL payouts (revenue accrued before claim, or while revenue was held) from the treasury.
// Skips brains with revenueHeld. Queues newly-accrued amounts for claimed, non-held brains first.
//   pnpm payouts            # send
//   pnpm payouts --dry-run  # show what would be sent
import { transferSol } from "@metaplex-foundation/mpl-toolbox";
import { lamports, publicKey, transactionBuilder } from "@metaplex-foundation/umi";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { queueKolPayout } from "@/server/solana/claim";
import { explorerTx, getTreasurySigner, getUmi, rentExemptMinimum, signatureToString } from "@/server/solana/umi";

const dryRun = process.argv.includes("--dry-run");
const db = getDb();
const { brains, kolPayouts } = schema;

const claimed = await db
  .select({ id: brains.id })
  .from(brains)
  .where(and(eq(brains.status, "claimed"), eq(brains.revenueHeld, false)));
for (const b of claimed) {
  const queued = dryRun ? 0 : await queueKolPayout(b.id);
  if (queued) console.log(`queued ${queued} lamports for ${b.id}`);
}

const pending = await db
  .select({ p: kolPayouts, held: brains.revenueHeld, heldReason: brains.revenueHeldReason })
  .from(kolPayouts)
  .innerJoin(brains, eq(brains.id, kolPayouts.brainId))
  .where(eq(kolPayouts.status, "pending"));

if (!pending.length) {
  console.log("No pending payouts.");
  process.exit(0);
}

const umi = getUmi();
const treasury = getTreasurySigner();
const rentMin = await rentExemptMinimum();
let sent = 0;
for (const { p, held, heldReason } of pending) {
  if (held) {
    console.log(`skip #${p.id} ${p.brainId}: revenue held (${heldReason ?? "no reason"})`);
    continue;
  }
  const amount = BigInt(p.amountLamports);
  const dest = await umi.rpc.getAccount(publicKey(p.wallet));
  if (amount < rentMin && !(dest.exists && dest.lamports.basisPoints > 0n)) {
    console.log(`skip #${p.id} ${p.brainId}: ${amount} lamports < rent-exempt minimum for unfunded ${p.wallet}`);
    continue;
  }
  if (dryRun) {
    console.log(`would send #${p.id}: ${amount} lamports → ${p.wallet} (${p.brainId})`);
    continue;
  }
  try {
    const res = await transactionBuilder()
      .add(transferSol(umi, { source: treasury, destination: publicKey(p.wallet), amount: lamports(amount) }))
      .setFeePayer(treasury)
      .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    if (res.result.value.err) throw new Error(JSON.stringify(res.result.value.err));
    const signature = signatureToString(res.signature);
    await db.update(kolPayouts).set({ status: "sent", signature, error: null }).where(eq(kolPayouts.id, p.id));
    console.log(`sent #${p.id}: ${amount} lamports → ${p.wallet} ${explorerTx(signature)}`);
    sent++;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.update(kolPayouts).set({ status: "failed", error }).where(eq(kolPayouts.id, p.id));
    console.error(`failed #${p.id}: ${error}`);
  }
}
console.log(`${sent} payout(s) sent.`);
