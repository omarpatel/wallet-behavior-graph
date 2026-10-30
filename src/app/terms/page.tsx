import type { Metadata } from "next";
import Link from "next/link";
import { Prose } from "@/components/ui/Prose";
import { Container, PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Terms of use" };

export default function TermsPage() {
  return (
    <Container>
      <PageHeader eyebrow="Legal" title="Terms of use" lede="Plain-language terms for using Wallet Behavior Graph, holding a seat and running a brain agent." />
      <Prose>
        <h2>1. What the service is</h2>
        <p>
          Wallet Behavior Graph publishes educational analysis of public Solana wallet activity: trading-style profiles, alerts describing
          new trades with factual context, and an AI coach that explains a wallet&apos;s style. It is not a broker, adviser or
          exchange. Outside the optional brain agents described in section 4, we never execute trades for you or hold your funds.
        </p>
        <h2>2. No advice</h2>
        <p>
          Nothing on the service is investment, financial, legal or tax advice, or a recommendation to buy or sell any asset.
          Memecoins are extremely volatile and you may lose all funds. You are solely responsible for your decisions.
        </p>
        <h2>3. Seats</h2>
        <ul>
          <li>
            A seat is a Metaplex Core NFT granting access to one brain&apos;s live alerts, coaching and full playbook while its
            term is active. Default term is 30 days, extendable by paying the renewal fee. The remaining term transfers with the
            seat.
          </li>
          <li>
            Seats are memberships. They carry <strong>no right to revenue, profit share, yield, buybacks or any distribution</strong>,
            and we make no statement about their resale value. Do not buy a seat expecting it to appreciate.
          </li>
          <li>
            Seat supply per brain is capped for capacity and fairness reasons. Pricing follows published tiers and may change for
            future mints; it does not change terms of seats already held.
          </li>
          <li>
            Secondary sales on our marketplace are escrowless and pay a creator royalty and a marketplace fee. Seats listed in
            escrow on third-party marketplaces lose access while listed.
          </li>
          <li>All payments are on-chain and final. Access ends when the term expires or the seat leaves your wallet.</li>
        </ul>
        <h2>4. Brain agents (custodial)</h2>
        <ul>
          <li>
            A seat holder may create a brain agent: an automated program that trades Solana memecoins with rules derived from a
            brain&apos;s published trading-style statistics. It does not copy, mirror or follow the brain&apos;s wallet, and its
            results say nothing about the brain&apos;s or anyone else&apos;s future results.
          </li>
          <li>
            Agents start in <strong>paper mode</strong>: simulated SOL at real market prices, no funds involved. Live mode is an
            explicit opt-in.
          </li>
          <li>
            In live mode the agent trades from its own wallet whose private key is <strong>generated and held by our server</strong>
            (custodial). Anyone who compromises that server or key could take the funds; software faults, bad data, failed or
            delayed transactions, slippage, rugs and illiquid tokens can lose part or all of the deposit. You can lose everything
            you deposit. Deposits are capped per agent.
          </li>
          <li>
            The agent&apos;s trades are not advice or a recommendation, and there is no guarantee of any result, of execution, or
            that limits such as stop-losses and daily loss limits trigger at the intended price.
          </li>
          <li>
            You can pause the agent and withdraw its SOL to your signed-in wallet at any time; withdrawals go only to that wallet.
            Withdrawing does not sell open positions — close them first if you want them in SOL. Network fees apply.
          </li>
        </ul>
        <h2>5. Brains, claims and attribution</h2>
        <p>
          Any public wallet may be added. Unclaimed brains are unaffiliated with any person a third party has attributed the wallet
          to; where the configured wallet directory lists the wallet, its public name and picture are shown with the directory named as the
          source, otherwise the brain carries a neutral codename. Seat metadata only ever uses the codename. A wallet owner may claim a brain by signing in with that wallet; claimed owners
          accept a separate licence covering name, likeness and revenue share, must disclose that revenue share when promoting
          their brain, and must not trade against their own alerts (revenue is held when the anti-scalping check triggers).
        </p>
        <h2>6. Acceptable use</h2>
        <ul>
          <li>No scraping, reselling or redistributing holder-only alerts or coaching output in real time.</li>
          <li>No attempts to circumvent access checks, geo-restrictions or rate limits.</li>
          <li>No use of the service from restricted jurisdictions (currently the UK and comprehensively sanctioned countries).</li>
        </ul>
        <h2>7. Availability and changes</h2>
        <p>
          The service depends on public blockchains, RPC providers and AI models and may be interrupted. Data can be delayed,
          incomplete or wrong; see the <Link href="/methodology">methodology</Link>. We may change these terms; material
          changes are announced on this page.
        </p>
        <h2>8. Liability</h2>
        <p>
          To the extent permitted by law, the service is provided “as is” and we are not liable for trading losses — including
          losses of funds deposited to a brain agent — or indirect damages arising from its use.
        </p>
        <h2>9. Contact</h2>
        <p>
          Corrections, objections and complaints: <Link href="/disputes">disputes form</Link>.
        </p>
      </Prose>
    </Container>
  );
}
