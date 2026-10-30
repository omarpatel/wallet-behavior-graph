import { connection } from "next/server";
import { z } from "zod";
import { withApi } from "@/server/auth/http";
import { getPickLeaderboard } from "@/server/picks/queries";

const Window = z.enum(["7d", "30d", "all"]).catch("30d");

/** Public PickLeaderboardDTO: brains ranked by the paper outcomes of their picks older than PUBLIC_DELAY_SEC. */
export const GET = withApi(async (req: Request) => {
  await connection();
  const window = Window.parse(new URL(req.url).searchParams.get("window") ?? "30d");
  return Response.json(await getPickLeaderboard(window));
});
