import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AgentLeaderboardTabs } from "@/components/agents/AgentLeaderboard";
import { Container, PageHeader, TableSkeleton } from "@/components/ui/primitives";
import { getAgentLeaderboard } from "@/server/agents/queries";

export const metadata: Metadata = {
  title: "Agent leaderboard",
  description: "Brain agents ranked by PnL — paper (simulated) and live ranked separately. Not advice.",
};

export default function AgentLeaderboardPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Agents"
        title="Agent leaderboard"
        lede="Every agent trades on its own with rules derived from a brain's style statistics. Paper agents use simulated SOL at real prices; live agents trade real SOL. The two are ranked separately."
        actions={
          <Link href="/agents" className="btn btn-ghost btn-sm">
            My agents
          </Link>
        }
      />
      <div className="pb-16">
        <Suspense fallback={<TableSkeleton rows={8} label="Loading agent leaderboard" />}>
          <Board />
        </Suspense>
      </div>
    </Container>
  );
}

async function Board() {
  await connection();
  return <AgentLeaderboardTabs data={await getAgentLeaderboard({})} />;
}
