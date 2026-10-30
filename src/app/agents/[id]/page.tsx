import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AgentCockpit } from "@/components/agents/AgentCockpit";
import { Container, Skeleton } from "@/components/ui/primitives";
import { getAgentDetail } from "@/server/agents/queries";
import { getSession } from "@/server/auth/session";
import { nowSec } from "@/server/queries/shared";

export async function generateMetadata({ params }: PageProps<"/agents/[id]">): Promise<Metadata> {
  await connection();
  const agent = await getAgentDetail((await params).id, null);
  if (!agent) return { title: "Agent not found" };
  return {
    title: `${agent.name} · agent`,
    description: `Autonomous ${agent.mode} agent trading with rules derived from a brain's style statistics. Not advice.`,
  };
}

export default function AgentPage({ params }: PageProps<"/agents/[id]">) {
  return (
    <Container>
      <Suspense fallback={<CockpitSkeleton />}>
        <Cockpit params={params} />
      </Suspense>
    </Container>
  );
}

function CockpitSkeleton() {
  return (
    <div role="status" aria-label="Loading agent" className="space-y-6 pt-12">
      <Skeleton className="h-16 w-80 max-w-full" />
      <Skeleton className="h-52 rounded-[14px]" />
      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <Skeleton className="h-[480px] rounded-[14px]" />
        <Skeleton className="h-[360px] rounded-[14px]" />
      </div>
    </div>
  );
}

async function Cockpit({ params }: Pick<PageProps<"/agents/[id]">, "params">) {
  await connection();
  const [{ id }, session] = await Promise.all([params, getSession()]);
  const agent = await getAgentDetail(id, session?.wallet ?? null);
  if (!agent) notFound();
  // Keyed by viewer: a sign-in re-renders this server component (RefreshOnSession) and must reseed owner-only state.
  return <AgentCockpit key={session?.wallet ?? "anon"} initial={agent} serverNow={nowSec()} />;
}
