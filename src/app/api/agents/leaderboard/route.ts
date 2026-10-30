import { connection } from "next/server";
import { getAgentLeaderboard } from "@/server/agents/queries";
import { withApi } from "@/server/auth/http";

/** Public AgentLeaderboardDTO `{ paper, live }` (never ranked together), optional `?brainId=`. */
export const GET = withApi(async (req: Request) => {
  await connection();
  const brainId = new URL(req.url).searchParams.get("brainId");
  return Response.json(await getAgentLeaderboard({ brainId }));
});
