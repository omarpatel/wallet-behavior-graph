import type { Metadata } from "next";
import Link from "next/link";
import { Prose } from "@/components/ui/Prose";
import { Container, PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Privacy notice" };

export default function PrivacyPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Legal"
        title="Privacy notice"
        lede="Including our notice under GDPR Article 14 to people whose wallets we analyse without having collected data from them directly."
      />
      <Prose>
        <h2>Who this covers</h2>
        <ul>
          <li>
            <strong>Visitors and users</strong> who connect a wallet, sign in, mint or trade seats, or use coaching.
          </li>
          <li>
            <strong>Wallet owners</strong> whose public Solana wallets are profiled as brains — including wallets a third party
            has publicly attributed to a person.
          </li>
        </ul>

        <h2>Data about wallet owners (Art. 14 notice)</h2>
        <p>
          Wallet addresses can be personal data where they can reasonably be linked to a person. For profiled wallets we process:
        </p>
        <ul>
          <li>public on-chain transactions of the wallet (swaps, transfers, timestamps, amounts) and derived trading statistics;</li>
          <li>
            for unclaimed brains, any attribution already published by a third party (name/handle, the publishing platform and its
            link). Where the configured wallet directory lists the
            wallet, the public name, handle, profile picture and that directory&apos;s own published figures are shown with the
            source named; other attributions are shown only as labelled attributions;
          </li>
          <li>for claimed brains that linked X: public posts retrieved through the official X API, to compare posts with trades.</li>
        </ul>
        <p>
          <strong>Source:</strong> the public Solana blockchain, token-data providers (Jupiter, DexScreener), and publicly
          available attribution pages. <strong>Purpose:</strong> educational analysis of trading styles. <strong>Lawful basis:</strong>{" "}
          legitimate interests (Art. 6(1)(f)) in providing transparent, rule-based analysis of public market activity, balanced
          by: public names and pictures only where the person is listed with a public label in the configured wallet directory (always with the source and
          an &quot;unaffiliated, not endorsed&quot; notice), neutral codenames otherwise, no de-anonymisation or clustering of other wallets, no
          tweet correlation without the owner&apos;s opt-in, deterministic labels with the numbers shown, and an objection
          channel.
        </p>
        <p>
          <strong>Profiling:</strong> archetypes, flags and scores are automated profiling (Art. 4(4)). They produce no legal or
          similarly significant effects on the wallet owner; their logic is published in the{" "}
          <Link href="/methodology">methodology</Link>.
        </p>

        <h2>Data about users</h2>
        <ul>
          <li>wallet address and sign-in records (session cookie, httpOnly, used only to keep you signed in);</li>
          <li>seats, listings and payments you make on-chain;</li>
          <li>coaching messages you send and the replies, stored so you can see your history;</li>
          <li>basic request logs and country (from your IP at the network edge) to enforce geo-restrictions.</li>
        </ul>
        <p>We do not use advertising trackers and do not sell personal data.</p>

        <h2>Recipients</h2>
        <p>
          Hosting and database providers; blockchain RPC providers; Anthropic and OpenAI (AI explanations and coaching — receive trade facts
          and your coaching messages); X (only for owners who link their account). On-chain actions are public by nature.
        </p>

        <h2>Retention</h2>
        <ul>
          <li>Derived profiles: kept while the brain is listed; recomputed from the trailing 90 days.</li>
          <li>X posts: removed within 24 hours of deletion on X, and on unlinking.</li>
          <li>Coaching history: kept until you ask us to delete it.</li>
          <li>Disputes: kept for as long as needed to handle them and defend legal claims.</li>
        </ul>

        <h2>Your rights</h2>
        <p>
          Depending on your jurisdiction: access, rectification, erasure, restriction, portability, and the{" "}
          <strong>right to object to profiling based on legitimate interests (Art. 21)</strong>. Wallet owners can object or ask
          for a brain to be removed via the <Link href="/disputes">disputes form</Link> (choose “Objection / opt-out”); we may ask
          you to sign a message with the wallet to verify ownership. We respond within one month. You may also complain to your
          data-protection authority.
        </p>
        <p>
          California residents: inferences drawn to build a profile are personal information; you may request to know or delete
          them through the same form.
        </p>
      </Prose>
    </Container>
  );
}
