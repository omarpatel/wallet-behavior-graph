import type { Metadata } from "next";
import Link from "next/link";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { Prose, TableWrap } from "@/components/ui/Prose";
import { Container, PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Methodology",
  description: "How every Wallet Behavior Graph metric, archetype, flag, score and tier is computed from public on-chain data.",
};

const TOC = [
  ["data", "Data & accounting"],
  ["metrics", "Metrics"],
  ["archetypes", "Archetypes"],
  ["flags", "Flags"],
  ["copyability", "Copyability"],
  ["score", "Track score & tiers"],
  ["alerts", "Live alerts"],
  ["say-vs-do", "Say vs do"],
  ["swarms", "Swarms"],
  ["connectome", "Connectome"],
  ["agents", "Agents"],
  ["picks", "Brain Picks"],
  ["limits", "Limitations"],
] as const;

const METRICS: [string, string, string][] = [
  ["Realized PnL", "Average-cost basis per token; USD at block-time SOL price; DEX, network and priority fees included.", "Unrealized PnL is never used for labels or tiers."],
  ["ROI", "Realized profit ÷ bought cost (ratio).", "High-frequency wallets show deflated ROI; the absolute $ is always shown next to it."],
  ["Win rate", "Share of closed token positions with realized PnL > 0.", "Always shown with the PnL buckets: >5x, 2–5x, 0–2x, −50–0%, < −50%. Scores use the shrunk win rate (see Track score)."],
  ["Profit factor", "Σ wins ÷ |Σ losses|.", ""],
  ["Entry delay", "First buy time − token creation time.", "Buckets: same block, ≤10s, <1m, 1–5m, 5–60m, 1–24h, >24h."],
  ["Entry market cap", "Price × total supply at the buy (pump.fun supply = 1B).", "Buckets: <$10k, $10–30k, $30–100k, $100k–1M, $1–10M, $10–100M, ≥$100M."],
  ["On-curve share", "Share of pump.fun entries made before bonding-curve graduation.", "Separates curve apes from post-graduation momentum buyers."],
  ["Hold (copy window)", "Per token: first buy → first sell after it; the median across tokens.", "Average holding period is not used: unsold positions inflate it by orders of magnitude."],
  ["Flash-flip share", "Positions bought and sold within 5 seconds.", "≥30% → bot / flash flipper."],
  ["Sizing", "Median and average buy; CV = σ/μ of per-token total buy USD.", "CV <0.5 fixed size; 0.5–1.0 variable; >1.0 conviction-scaled."],
  ["Exit pattern", "Per position: full dump (≥90% sold in one tx), ladder (≥3 sells), initials out (first sell recovers ≥100% of cost), stop-out (first sell at ≤ −30%).", "Reported as a mix across positions."],
  ["Trade frequency", "(buys + sells) ÷ active days.", ">50/day is treated as machine-like."],
  ["Session window", "≥70% of activity in one 6-hour UTC window (≥20 trades).", "Shown on the 24h activity strip."],
];

const ARCHETYPES: [string, string][] = [
  ["Deployer / Dev-linked", "Created more than half of the tokens it traded, or ≥20% of entries came via the launch bundle. Scores are discounted ×0.45."],
  ["Bot / Flash Flipper", ">50 trades/day, or ≥30% of positions round-tripped within 5s, or ≥2,000 trades in 7 days."],
  ["Sniper", "≥50% of entries within the first ~3 blocks (≈1.2s) of launch across ≥10 distinct deployers; median copy window <10 min."],
  ["Early Ape (curve ape)", "Median entry MC <$100k; ≥60% of entries before graduation; median entry delay after the first blocks and ≤60 min; median copy window <6h."],
  ["Momentum Chaser", "Median entry MC $100k–$20M; most entries after a strong move up; median copy window 5 min–24h."],
  ["Intraday Trader", "Median copy window 60s–24h without meeting the rules above."],
  ["Swing Holder", "Median copy window 24h–7d; 1–10 trades/day."],
  ["Diamond Hands", "Median copy window ≥7d or ≥50% of positions still open after 30 days; ≤2 sells per token on average."],
];

const FLAGS: [string, string][] = [
  ["Lottery", "Win rate <35% and at least one token ≥5x."],
  ["Disciplined", "≤5% of tokens below −50% and realized PnL > 0."],
  ["Bag holder", "≥30% of tokens below −50% and realized PnL < 0."],
  ["Scaler-in / Partial TP", "Average buys (or sells) per token ≥3."],
  ["Concentrated", "Top-3 tokens ≥70% of buy USD (≥5 tokens)."],
  ["Whale", "Average buy ≥$5,000."],
  ["Accumulating / Distributing", "Buys ÷ sells ≥3, or sells ÷ buys ≥3."],
  ["Collapse-exposed", "≥30% of the wallet's tokens (min 5) either closed ≥80% down, or are still held after the token's liquidity fell below $4k."],
  ["Session trader", "≥70% of activity in one 6-hour UTC window (≥20 trades)."],
  ["Hard to copy", "Copyability <35 with track score ≥65: “learn the discipline, don't copy the entries”."],
  ["Promote-then-sell pattern", "Claimed + X-linked brains only. See Say vs do."],
];

const TIERS: [string, string, string, string, string][] = [
  ["S", "≥ 80", "50", "2.0 SOL", "0.6 SOL"],
  ["A", "≥ 65", "100", "1.0 SOL", "0.3 SOL"],
  ["B", "≥ 50", "150", "0.5 SOL", "0.15 SOL"],
  ["C / unrated", "< 50 or thin sample", "200", "0.25 SOL", "0.08 SOL"],
];

export default function MethodologyPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Methodology"
        title="How a brain is computed"
        lede="Every label on Wallet Behavior Graph comes from a deterministic, versioned rule over public on-chain data, and shows the numbers that triggered it. The AI layer only explains facts it is given; it never originates a label or an accusation."
      />
      <div className="grid gap-10 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-24 space-y-1.5 text-sm">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-mute hover:text-accent">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <Prose>
          <h2 id="data">Data & accounting</h2>
          <p>
            Wallet history comes from Solana mainnet (Helius when configured, otherwise standard RPC). Each transaction is
            normalised from the wallet&apos;s own balance changes into buys and sells; tokens are enriched with launch time,
            launchpad, supply and market data (Jupiter / DexScreener), and SOL is priced at the minute of the trade.
          </p>
          <ul>
            <li>
              <strong>Window:</strong> statistics cover the trailing 90 days.
            </li>
            <li>
              <strong>Unit of analysis:</strong> a position = one wallet × one token, from first buy until the balance returns to
              ~0.
            </li>
            <li>
              <strong>Transfers are excluded</strong> from trade stats (airdrops, internal moves, phishing airdrops).
            </li>
            <li>
              <strong>Minimum sample:</strong> no archetype, score or tier below <strong>20 trades</strong> and{" "}
              <strong>5 distinct tokens</strong> — the brain is shown as “Unrated — thin sample”.
            </li>
          </ul>

          <h2 id="metrics">Metrics</h2>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Definition</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map(([m, d, n]) => (
                  <tr key={m}>
                    <td className="whitespace-nowrap font-medium !text-ink">{m}</td>
                    <td>{d}</td>
                    <td>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <h2 id="archetypes">Archetypes</h2>
          <p>
            One primary archetype per brain: the first row that matches, top to bottom. The triggering numbers are shown next
            to the label.
          </p>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Archetype</th>
                  <th>Rule</th>
                </tr>
              </thead>
              <tbody>
                {ARCHETYPES.map(([a, r], i) => (
                  <tr key={a}>
                    <td className="num">{i + 1}</td>
                    <td className="whitespace-nowrap font-medium !text-ink">{a}</td>
                    <td>{r}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <h2 id="flags">Flags</h2>
          <p>Overlay flags are added for every rule that applies.</p>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Flag</th>
                  <th>Rule</th>
                </tr>
              </thead>
              <tbody>
                {FLAGS.map(([f, r]) => (
                  <tr key={f}>
                    <td className="whitespace-nowrap font-medium !text-ink">{f}</td>
                    <td>{r}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <h2 id="copyability">Copyability</h2>
          <p>
            A 0–100 estimate of how much of the wallet&apos;s edge survives being followed with realistic latency (≈3 seconds)
            and slippage (≈5%). A weighted quality score — entry market cap (20%), profit per position (20%, thin profits are
            eaten by slippage), hold time versus latency (18%), execution pace (14%, bot-like volume scores low), edge type (16%)
            and shrunk win rate versus the population (12%) — is multiplied by a fidelity gate of 0.25 + 0.75 × f, where f is
            the worse of the hold-time and pace scores (0.7 when neither is known). The gate encodes a simple constraint: a
            wallet a follower physically cannot mirror cannot score well, however much it earns, while a
            wallet holding ≥10 minutes at a manual pace keeps its full quality score. Many top wallets hold for seconds: a low
            score is the honest result, not a criticism.
          </p>

          <h2 id="score">Track score & tiers</h2>
          <p>
            <code>trackScore</code> (0–100) = stop-loss discipline 34% (1 − share of tokens below −50%) + profit share 28% + ROI
            16% (−5% → 0, +30% → 100) + win rate 10% + sample size 12% (20 → 320 tokens). Dev-linked
            wallets are multiplied by 0.45. Unrealized PnL is never used. Tiers set the default seat supply and price; an admin
            can override pricing per brain, and supply never drops below seats already minted.
          </p>
          <p id="scoring-shrinkage">
            The win rate in both scores is shrunk toward the population before it is used: (wins + p × 20) ÷ (closed positions +
            20), where p is the pooled win rate of every closed position across tracked brains. This is the posterior mean of a
            Beta prior worth 20 positions, so a wallet needs about 20 closed positions before its own record outweighs the
            assumption that it is average: 3 wins out of 3 stays close to p, while 120 out of 200 stays close to 60%. The
            shrunk rate is scored as lift over the population (p − 20 points → 0, p → half, p + 20 points → full weight). The
            raw win rate is still what the brain page shows.
          </p>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Track score</th>
                  <th>Seat supply</th>
                  <th>Mint price</th>
                  <th>Renewal / 30d</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map(([t, s, n, p, r]) => (
                  <tr key={t}>
                    <td className="font-medium !text-ink">{t}</td>
                    <td className="num">{s}</td>
                    <td className="num">{n}</td>
                    <td className="num">{p}</td>
                    <td className="num">{r}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p>
            Supply caps exist for capacity and fairness — alert fan-out, front-running and coaching load — not to create
            scarcity value. Seats are term-limited memberships with no revenue share, yield or buyback for holders.
          </p>

          <h2 id="alerts">Live alerts</h2>
          <p>Every new trade produces an alert with deterministic facts only:</p>
          <ul>
            <li>side, size in SOL/USD, market cap, entry delay after launch, launchpad and venue;</li>
            <li>position context: first buy or add, share of the peak position sold, realized result on sells, time held;</li>
            <li>
              in-character comparison against this wallet&apos;s own medians (e.g. “4.1× usual size”, “entered much later than
              usual”);
            </li>
            <li>
              safety context from token data: pool liquidity, top-holder concentration, mint/freeze authority, and the RugCheck
              summary (risk 0–100 where higher is riskier — ≤30 low, ≤60 medium, above that high — share of LP locked, and
              named risks). RugCheck results are cached for 6 hours; where RugCheck&apos;s risk wording contradicts the token&apos;s
              on-chain mint/freeze authority, the on-chain authority wins. LP lock is not shown for tokens still on a launchpad
              bonding curve, which have no LP yet;
            </li>
            <li>swarm context when the buy is one of several tracked brains entering the same token (below).</li>
          </ul>
          <p>
            A short AI explanation then describes what the trade means within the wallet&apos;s pattern. It is constrained to the
            facts above and never recommends buying or selling. Claimed brains may have an alert delay; the public trade log
            on each brain page shows trades only after one hour.
          </p>

          <h2 id="say-vs-do">Say vs do (claimed brains only)</h2>
          <p>
            Tweet-to-trade correlation runs only for brains claimed by the wallet owner who also linked their X account, via the
            official X API. For each bullish post mentioning a token, an event is recorded when all hold: position ≥$500 at the
            post, first buy ≤72h before it, market cap ≥1.5× the average entry, and ≥50% of the position sold within 24h. It is
            marked as a fast exit if ≥80% was sold within 1h or the first sell came within 15 minutes. The “Promote-then-sell
            pattern” flag needs ≥3 events in 90 days, an event rate ≥40% of pre-positioned bullish mentions and a lift ≥2.0 versus
            the wallet&apos;s own exits after comparable price moves without a post. Each event links the post and transaction
            signatures.
          </p>
          <p>
            Anti-scalping: if a claimed owner sells ≥50% of an alerted position within 60 minutes after the alert published,
            their revenue share is held pending review and a notice is shown on the brain page.
          </p>

          <h2 id="swarms">Swarms</h2>
          <p>
            A swarm is three or more tracked brains making their <em>first</em> buy of the same token within 10 minutes of the
            first of them. It is “forming” at 3–4 brains, a “swarm” at 5–9 and “large” at 10 or more. Each brain counts once; a
            later, separate wave into the same token forms its own swarm. Entries that land in the same Solana slot are kept
            but marked, because near-simultaneous entries may be one operator or a bundle rather than independent decisions;
            the count of distinct slots is shown next to the member count. Swarms are detected the moment a tracked trade is
            ingested and rebuilt from full trade history every 10 minutes, so newly tracked wallets add to past swarms too.
          </p>
          <p>
            For context we show external reference base rates (an Aug–Oct 2026 study of pump.fun wallet clusters): ≥5
            tracked wallets in 10 minutes preceded a runner (≥$100K market cap, farm launches excluded) in about 15% of cases,
            ≥10 in about 50%. These are external figures, not ours.
          </p>
          <p>
            Our own outcome for each swarm uses only prices we observe: the highest market cap in any tracked brain&apos;s
            trade of the token in the 24 hours after the swarm started, against the market cap at its first entry, and
            separately against the market cap when the swarm became detectable (the third entry) counting only trades after
            it. Because we only see a price when a tracked wallet trades, the peak is a lower bound. Aggregate rates use swarms
            whose 24-hour window has closed. Neither our figures nor the study&apos;s are a prediction or advice.
          </p>
          <p>
            The token in a swarm is hidden from the public for one hour after the last member joined; holders of an active
            seat on any member brain see it in real time. Member brains and timing are always shown.
          </p>

          <h2 id="connectome">Connectome</h2>
          <p>
            The <Link href="/connectome">connectome</Link> maps how tracked wallets tend to enter the same tokens, borrowing the
            vocabulary of brain wiring diagrams (FlyWire, neuPrint). It describes historical co-movement among tracked wallets
            only; it does not show who knows, follows or trades on information from whom. Recomputed every 10 minutes over the
            last 30 days.
          </p>
          <ul>
            <li>
              <strong>Neuron</strong>: one brain (wallet). An <strong>entry</strong> is the wallet&apos;s first-ever buy of a
              token, counted when it falls in the 30-day window.
            </li>
            <li>
              <strong>Synapse A → B</strong> (“B tends to enter after A”): for every token both entered, with B&apos;s entry
              0–60 minutes after A&apos;s, add idf(token) × e<sup>−Δt/15 min</sup>. Entries in the same second or within 2
              slots (~1 s) are treated as near-simultaneous (bots, bundles, a shared trigger) and carry no direction.
              idf(token) = ln((N + 1) / (n + 1)), with N the wallets active in the window and n the wallets that entered that
              token, so a token everyone bought adds nothing and a rarely shared token adds most.
            </li>
            <li>
              <strong>Significance</strong>: the same weight is recomputed under 100 shuffles that permute entry times within
              each token among its entrants (keeping token popularity and each wallet&apos;s activity, breaking the order). A
              synapse is kept only when A→B shares ≥3 tokens and its weight is ≥3 standard deviations above the shuffled mean.
              Each synapse shows its co-entry count, median lag and example tokens older than one hour.
            </li>
            <li>
              <strong>Region</strong>: Louvain communities on the undirected graph (A→B and B→A weights summed), with a fixed
              random seed so regions are stable between runs. A region is named after its hub (the member with the highest
              influence) plus its dominant trait: “fast-entry cortex” when members&apos; median entry delay after launch is under
              60 s, otherwise “lead nucleus” when their median lead share is ≥0.6, otherwise “cluster”. Wallets without
              significant synapses form their own one-neuron region, shown as “Unwired · name”.
            </li>
            <li>
              <strong>Influence (PageRank)</strong>: weighted PageRank (damping 0.85) on the reversed graph, so rank flows
              from wallets that enter later to the wallets they entered after; scaled so the top neuron is 1.{" "}
              <strong>Lead share</strong> = outgoing ÷ (incoming + outgoing) synapse weight.
            </li>
            <li>
              <strong>Input share</strong> of A→B = its weight ÷ all synapse weight into B. The{" "}
              <strong>signal cascade</strong> from a wallet follows the FlyWire information-flow model: starting from that
              wallet, any wallet whose summed input share from already-reached wallets is ≥0.3 is reached at the next step;
              the arrival time adds up median lags. The <strong>strongest path</strong> between two wallets minimises Σ
              −ln(input share), i.e. the chain where each step explains the largest part of the next wallet&apos;s entries.
            </li>
            <li>
              <strong>Firing</strong>: live trades as they are ingested, shown per wallet as buy/sell and a size bucket
              (&lt;1, 1–10, &gt;10 SOL), without the token. Token replays and synapse examples use trades older than one hour.
            </li>
            <li>
              <strong>Token wiring</strong> on a brain page: its top 120 tokens by bought USD in 30 days, and capital
              rotations — a sell of token A followed by the wallet&apos;s next buy of a different token within 3 minutes.
            </li>
          </ul>
          <p>
            Two wallets reacting to the same post, call or listing look like a synapse when one is merely faster; reciprocal
            pairs (both directions of similar weight) usually mean a shared external trigger.
          </p>

          <h2 id="agents">Agents</h2>
          <p>
            Seat holders can run an <strong>agent</strong>: an automated trader that trades memecoins{" "}
            <em>in the style</em> of a brain. It never copies the brain&apos;s wallet or its trades; it hunts its own
            entries with rules derived from the brain&apos;s profile, deterministically, with every rule linked to the
            statistic it came from:
          </p>
          <ul>
            <li>
              <strong>Entries</strong>: launchpad (pump.fun when ≥60% of the brain&apos;s tokens were pump.fun launches),
              phase (bonding curve when ≥60% of its pump.fun entries were on the curve, pools when ≤20%), market-cap band
              (25th–75th percentile of its entry market caps), age band (25th–75th percentile of its entry delay after
              launch), a momentum gate for momentum styles, and a demand gate: net SOL into the curve (on-chain reserves) or
              5-minute buys/sells for pool tokens. A number we can&apos;t measure yet is unknown, never zero, and blocks the
              entry.
            </li>
            <li>
              <strong>Safety</strong>: mint and freeze authority revoked (read on-chain), top-10 holders excluding the curve
              or pool, RugCheck score. A brain flagged rug-exposed gets a stricter RugCheck limit.
            </li>
            <li>
              <strong>Sizing</strong>: a share of free SOL per entry from the brain&apos;s sizing style (fixed, variable,
              conviction), capped at 1 SOL per position and a number of open positions.
            </li>
            <li>
              <strong>Exits</strong>: time stop at the brain&apos;s 75th-percentile hold, a stop-loss tightened or widened by
              how often the brain cut losses, a take-profit (laddered when the brain usually sold in steps), initials-out and
              a trailing stop where its exits show them. Exits never act on a price older than 30 seconds; a token without a
              price for 15 minutes is valued at zero and sold if any route exists.
            </li>
            <li>
              <strong>Judge</strong> (optional): when the rules pass, a fast language model reads the brain&apos;s playbook,
              the rules and the candidate&apos;s numbers and answers buy or skip in at most 30 words. It has an hourly budget;
              without it the rules decide alone.
            </li>
          </ul>
          <p>
            <strong>Paper mode</strong> (default) fills at a real Jupiter quote, less a latency haircut (1.5% on the curve,
            0.5% in pools), the network and priority fee and token-account rent, so paper results are not flattered.{" "}
            <strong>Live mode</strong> is opt-in: the server holds the agent&apos;s key (encrypted at rest), signs Jupiter
            swaps and records the actual amounts from the confirmed transaction. Every order is keyed so it can never be
            sent twice. Risk limits: trades per hour, open positions, a daily loss limit that halts the agent, a per-agent
            deposit limit (excess deposits halt the agent until withdrawn) and platform kill switches. The owner can
            withdraw to their own wallet at any time.
          </p>
          <p>
            Every candidate an agent evaluates is recorded on its public tape with the reason: all buys and sells, every
            near miss (one rule short) and a 1-in-30 sample of far misses. Decisions informed by a fresh swarm are shown to
            the public one hour later, like the swarm itself. Leaderboards rank paper and live agents separately, by return
            on starting capital. Agents are an experiment: memecoins are extremely risky, most lose money, and an
            agent&apos;s results say nothing about the brain&apos;s own wallet.
          </p>

          <h2 id="picks">Brain Picks</h2>
          <p>
            A <strong>pick</strong> is a token that matches a brain&apos;s trading style right now, found by the same
            rules the brain&apos;s agents use. Picks never place orders: each one is tracked on paper against live prices
            and closed by the style&apos;s exit plan, and that paper outcome is the brain&apos;s public pick track record. A
            pick says a token matches this wallet&apos;s style; it is not a recommendation and not financial advice.
          </p>
          <ul>
            <li>
              <strong>Universe</strong>: picks are generated for brains with at least one active seat or at least one
              agent, and only when the profile is rich enough to derive a style.
            </li>
            <li>
              <strong>Market rules</strong>: the same deterministic entry rules as the brain&apos;s agents (see{" "}
              <a href="#agents">Agents</a>): launchpad, phase (curve or pools), entry market cap within the brain&apos;s
              25th–75th percentile, entry delay after launch, liquidity, momentum, the demand / flow gate and swarm
              confirmation where the style asks for it.
            </li>
            <li>
              <strong>Safety rules</strong>: mint and freeze authority revoked, top-10 holders limit, RugCheck score —
              again identical to the agents&apos; checks.
            </li>
            <li>
              <strong>Council</strong>: cross-brain context from every tracked brain — an active swarm on the token,
              tracked-wallet buys and sells in the last 30 minutes, and connectome leaders among the buyers, shown as chips
              on the pick. A token is vetoed when two or more tracked brains sold it and none bought.
            </li>
            <li>
              <strong>One-liner</strong> (optional): a language model may add one line on why the token matches the style,
              labelled with the model. It runs on an hourly budget and never decides whether a pick is made.
            </li>
            <li>
              <strong>Limits</strong>: one pick per brain and token per 24 hours, at most 6 picks per brain per hour.
            </li>
            <li>
              <strong>Style size</strong>: the style&apos;s position size as a share of a bankroll, from its sizing rules
              (base size, up to the maximum by conviction).
            </li>
          </ul>
          <p>
            <strong>Paper outcome</strong>: from the price at the pick, the style&apos;s exit plan is simulated on live
            prices — stop-loss, partial sells on the take-profit ladder, initials-out, a trailing stop after the first
            take-profit and the time stop. A token with no price for 15 minutes is closed as dead with its remaining value
            at zero. Fees and slippage are not modelled, so real fills would do worse. The outcome is the result as a share
            of the paper stake.
          </p>
          <p>
            Seat holders (and the brain&apos;s owner) see every pick the moment it qualifies. Everyone else sees picks one
            hour later; until then the token is hidden, and the public track record counts only picks older than one hour.
            The <Link href="/picks">Brain Picks leaderboard</Link> ranks brains by average paper outcome per closed pick,
            with at least five closed picks. Past paper outcomes don&apos;t predict future results; memecoins are extremely
            risky.
          </p>

          <h2 id="limits">Limitations</h2>
          <ul>
            <li>Only wallets that are tracked are analysed; positions held in other wallets are invisible.</li>
            <li>Sells into DCA or limit orders, airdropped tokens and wallet-to-wallet moves can distort individual positions.</li>
            <li>Market caps and prices for very new tokens can be missing or approximate at the moment of trade.</li>
            <li>Past behaviour does not predict future results. Survivorship bias applies to any leaderboard.</li>
          </ul>
          <p>
            Spotted an error? Use the <Link href="/disputes">disputes form</Link>.
          </p>
        </Prose>
      </div>
      <Disclaimer className="mt-12 max-w-3xl lg:ml-[240px]" />
    </Container>
  );
}
