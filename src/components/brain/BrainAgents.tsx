import { connection } from "next/server";
import { AgentLeaderboardTabs } from "@/components/agents/AgentLeaderboard";
import { CreateAgent } from "@/components/agents/CreateAgent";
import { SectionTitle } from "@/components/ui/primitives";
import { getAgentLeaderboard } from "@/server/agents/queries";

/** "Agents that trade like this brain": create flow for seat holders + this brain's public agents. */
export async function BrainAgents({
  brainId,
  brainName,
  canCreate,
  hasProfile,
}: {
  brainId: string;
  brainName: string;
  canCreate: boolean;
  hasProfile: boolean;
}) {
  await connection();
  const board = await getAgentLeaderboard({ brainId });
  const total = board.paper.length + board.live.length;
  return (
    <section aria-labelledby="agents" className="scroll-mt-24 space-y-4">
      <SectionTitle id="agents" eyebrow="Agents · in this brain's style, not copying its wallet">
        Agents that trade like this brain
      </SectionTitle>
      <CreateAgent brainId={brainId} brainName={brainName} canCreate={canCreate} hasProfile={hasProfile} />
      {total > 0 && (
        <div className="pt-2">
          <h3 className="eyebrow mb-3">Public agents of this brain</h3>
          <AgentLeaderboardTabs data={board} showBrain={false} />
        </div>
      )}
    </section>
  );
}
