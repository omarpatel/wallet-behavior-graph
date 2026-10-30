import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AdminBrainControls, DisputeStatusButton } from "@/components/admin/AdminControls";
import { PROVENANCE_LABEL, StatusPill, TierBadge } from "@/components/ui/badges";
import { Container, EmptyState, PageHeader, SectionTitle, TableSkeleton } from "@/components/ui/primitives";
import { fmtSol, lamportsToSol, shortAddr, timeAgo } from "@/lib/format";
import { getSession } from "@/server/auth/session";
import { getAdmin } from "@/server/queries/admin";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default function AdminPage() {
  return (
    <Container>
      <PageHeader eyebrow="Operations" title="Admin" />
      <Suspense fallback={<TableSkeleton rows={8} label="Loading admin" />}>
        <AdminBody />
      </Suspense>
    </Container>
  );
}

async function AdminBody() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return (
      <EmptyState title={session ? "Admins only" : "Sign in required"}>
        {session ? "This wallet is not in ADMIN_WALLETS." : "Sign in with an admin wallet to manage brains and disputes."}
      </EmptyState>
    );
  }
  const { brains, disputes, now } = await getAdmin();
  const open = disputes.filter((d) => d.status === "open").length;

  return (
    <div className="space-y-14">
      <section aria-labelledby="admin-brains">
        <SectionTitle id="admin-brains" eyebrow={`${brains.length} total · ${brains.filter((b) => b.revenueHeld).length} held`}>
          Brains
        </SectionTitle>
        {brains.length === 0 ? (
          <EmptyState title="No brains">Run the seed script or add a wallet.</EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="tbl">
              <caption className="sr-only">All brains with admin controls</caption>
              <thead>
                <tr>
                  <th scope="col">Brain</th>
                  <th scope="col">Status</th>
                  <th scope="col">Seats / price</th>
                  <th scope="col">Controls</th>
                </tr>
              </thead>
              <tbody>
                {brains.map((b) => (
                  <tr key={b.id} className="align-top">
                    <td className="min-w-[14rem] align-top">
                      <div className="flex items-center gap-2">
                        <TierBadge tier={b.tier} size="sm" />
                        <Link href={`/brains/${b.id}`} className="font-medium text-ink hover:text-accent">
                          {b.codename}
                        </Link>
                      </div>
                      <p className="num mt-1 text-[11px] text-mute">
                        {shortAddr(b.wallet)} · {b.displayName ? `${b.displayName} (${PROVENANCE_LABEL[b.provenance]})` : PROVENANCE_LABEL[b.provenance]}
                      </p>
                      <p className="num text-[11px] text-mute">score {b.trackScore?.toFixed(0) ?? "—"}</p>
                    </td>
                    <td className="align-top">
                      <div className="flex flex-col items-start gap-1">
                        <StatusPill tone={b.status === "claimed" ? "up" : "mute"}>{b.status}</StatusPill>
                        <StatusPill tone={b.backfillStatus === "done" ? "mute" : b.backfillStatus === "error" ? "down" : "accent"}>
                          backfill {b.backfillStatus}
                        </StatusPill>
                        {!b.listed && <StatusPill tone="warn">unlisted</StatusPill>}
                        {b.revenueHeld && <StatusPill tone="warn">revenue held</StatusPill>}
                      </div>
                      {b.revenueHeldReason && <p className="mt-1 max-w-[16rem] text-[11px] text-warn">{b.revenueHeldReason}</p>}
                      {b.backfillError && <p className="num mt-1 max-w-[16rem] text-[11px] text-down">{b.backfillError}</p>}
                    </td>
                    <td className="num align-top text-xs text-ink-2">
                      <p>
                        {b.seatsMinted}/{b.seatSupply} seats
                      </p>
                      <p>mint {fmtSol(lamportsToSol(b.seatPriceLamports), 3)}</p>
                      <p>renew {fmtSol(lamportsToSol(b.renewalPriceLamports), 3)}</p>
                      <p className="text-mute">{b.priceOverride ? "override" : "tier pricing"}</p>
                    </td>
                    <td className="align-top">
                      <AdminBrainControls
                        id={b.id}
                        listed={b.listed}
                        priceOverride={b.priceOverride}
                        seatSupply={b.seatSupply}
                        seatsMinted={b.seatsMinted}
                        seatPriceLamports={b.seatPriceLamports}
                        renewalPriceLamports={b.renewalPriceLamports}
                        alertDelaySec={b.alertDelaySec}
                        revenueHeld={b.revenueHeld}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="admin-disputes">
        <SectionTitle id="admin-disputes" eyebrow={`${open} open`}>
          Disputes
        </SectionTitle>
        {disputes.length === 0 ? (
          <EmptyState title="No disputes" />
        ) : (
          <ul className="space-y-3">
            {disputes.map((d) => (
              <li key={d.id} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusPill tone={d.status === "open" ? "warn" : "mute"}>{d.status}</StatusPill>
                    <StatusPill tone="accent">{d.kind.replace("_", "-")}</StatusPill>
                    {d.brainId && (
                      <Link href={`/brains/${d.brainId}`} className="text-ink-2 hover:text-accent">
                        {d.brainId}
                      </Link>
                    )}
                    <span className="num text-mute">{timeAgo(d.createdAt, now)}</span>
                  </div>
                  <p className="text-xs text-ink-2">Contact: {d.contact}</p>
                  <p className="whitespace-pre-wrap text-sm text-ink">{d.message}</p>
                </div>
                <DisputeStatusButton id={d.id} status={d.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
