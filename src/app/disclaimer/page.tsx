import type { Metadata } from "next";
import Link from "next/link";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { Prose } from "@/components/ui/Prose";
import { Container, PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Disclaimer" };

export default function DisclaimerPage() {
  return (
    <Container>
      <PageHeader eyebrow="Legal" title="Disclaimer" />
      <Disclaimer className="mb-10 max-w-3xl" />
      <Prose>
        <h2>Educational analysis, not advice</h2>
        <p>
          Wallet Behavior Graph describes how public wallets have traded. Alerts state facts about a trade and how it compares with the
          wallet&apos;s own history; explanations and coaching describe the wallet&apos;s style. None of it is a recommendation,
          a signal to copy, or personalised advice about your own trades.
        </p>
        <h2>Copying is risky by design</h2>
        <p>
          Many profiled wallets enter tokens seconds after launch and exit within minutes. By the time anyone else acts, prices
          have usually moved. Research on influencer token calls found average returns turn negative within 30 days, and early
          insiders capture most gains. Each brain&apos;s copyability score reflects this.
        </p>
        <h2>Attribution</h2>
        <p>
          Unclaimed brains analyse a public wallet. When the configured wallet directory lists the wallet with a public label, the
          brain shows the public name and picture published there, with the directory named; otherwise it carries a neutral
          codename, and any third-party attribution is shown only with its source. None of this is confirmed by us or endorsed by
          that person. Only brains claimed by the wallet owner show a verified identity.
        </p>
        <h2>Seats</h2>
        <p>
          Seats are access memberships. They do not entitle holders to any revenue or return, and nothing here suggests they will
          hold or gain value.
        </p>
        <h2 id="agents">Brain agents</h2>
        <p>
          A brain agent is an automated trading program configured from a brain&apos;s published style statistics. It does not
          copy the brain&apos;s wallet, and neither its trades nor its paper results are advice, a recommendation or a prediction.
          Paper results are simulated and leave out much of what real execution costs: failed transactions, latency, slippage
          and fees.
        </p>
        <p>
          Live agents are <strong>custodial</strong>: our server generates and holds the agent wallet&apos;s private key and signs
          its trades. If the server, the key or the software fails or is compromised, or the tokens it buys collapse, you can
          lose everything you deposited. Nothing guarantees a profit, an execution price or that a loss limit stops losses in
          time. Only deposit what you can afford to lose entirely. You can withdraw the agent&apos;s SOL to your signed-in wallet
          at any time; open token positions must be closed first to be withdrawn as SOL. See the{" "}
          <Link href="/terms">terms</Link>, section 4.
        </p>
        <h2>Data accuracy</h2>
        <p>
          On-chain decoding and token data can be incomplete or delayed. See the <Link href="/methodology">methodology</Link> and
          report errors through the <Link href="/disputes">disputes form</Link>.
        </p>
      </Prose>
    </Container>
  );
}
