import type { Metadata } from "next";
import Link from "next/link";
import { MyAgents } from "@/components/agents/MyAgents";
import { AgentRiskNote } from "@/components/agents/AgentRiskNote";
import { Container, PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "My agents",
  description: "Autonomous trading agents configured from a brain's style statistics. Paper mode by default.",
};

export default function AgentsPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Agents"
        title="My agents"
        lede="An agent trades on its own, with entry, sizing and exit rules derived from a brain's style statistics. It does not copy that brain's wallet. Agents start in paper mode with simulated SOL."
        actions={
          <Link href="/agents/leaderboard" className="btn btn-ghost btn-sm">
            Agent leaderboard
          </Link>
        }
      />
      <div className="space-y-8 pb-16">
        <MyAgents />
        <AgentRiskNote />
      </div>
    </Container>
  );
}
