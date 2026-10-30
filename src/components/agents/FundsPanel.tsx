"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useState, type FormEvent } from "react";
import { AGENT_LIMITS, type AgentDepositInfoDTO, type AgentDetailDTO, type AgentOrderDTO } from "@/server/agents/types";
import { solscan } from "@/components/ui/links";
import { CopyButton } from "@/components/ui/CopyButton";
import { ExternalLink } from "@/components/ui/primitives";
import { useSession } from "@/components/wallet";
import { bytesToBase64 } from "@/components/wallet/base64";
import { fmtSol, lamportsToSol, shortAddr, solToLamports, timeAgo } from "@/lib/format";
import { Modal } from "./Modal";
import { agentApi, fmtSignedSol, solOf } from "./lib";

type Busy = null | "deposit" | "withdraw" | "close";
type Note = { tone: "up" | "down"; text: string; signature?: string } | null;

/** Agent wallet, balances and (owner) deposit / withdraw / close-all. Wallet address + balance are public. */
export function FundsPanel({ agent, now }: { agent: AgentDetailDTO; now: number }) {
  const { publicKey, signTransaction } = useWallet();
  const { session } = useSession();
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<Note>(null);
  const [depositSol, setDepositSol] = useState("");
  const [withdrawSol, setWithdrawSol] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const live = agent.mode === "live";
  const err = (e: unknown) => setNote({ tone: "down", text: e instanceof Error ? e.message : String(e) });

  async function deposit(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const lamports = solToLamports(Number(depositSol));
    if (!(lamports > 0)) return setNote({ tone: "down", text: "Enter an amount in SOL" });
    if (!session || !publicKey || !signTransaction) return setNote({ tone: "down", text: "Connect the wallet you signed in with" });
    if (publicKey.toBase58() !== session.wallet) {
      return setNote({ tone: "down", text: "The connected wallet differs from the signed-in wallet; sign in again" });
    }
    setBusy("deposit");
    try {
      const info = await agentApi<AgentDepositInfoDTO>(`/api/agents/${agent.id}/deposit`);
      if (lamports > info.remainingLamports) {
        throw new Error(`Over the deposit cap: at most ${fmtSol(lamportsToSol(info.remainingLamports), 3)} more for this agent`);
      }
      const tx = new Transaction({ feePayer: publicKey, blockhash: info.blockhash, lastValidBlockHeight: info.lastValidBlockHeight }).add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(info.to), lamports }),
      );
      const signed = await signTransaction(tx);
      const { signature } = await agentApi<{ signature: string }>(`/api/agents/${agent.id}/deposit`, {
        method: "POST",
        body: { signedTransaction: bytesToBase64(signed.serialize()) },
      });
      setDepositSol("");
      setNote({ tone: "up", text: `Deposited ${fmtSol(lamportsToSol(lamports), 4)}`, signature });
    } catch (e) {
      err(e);
    } finally {
      setBusy(null);
    }
  }

  async function withdraw(all: boolean) {
    setNote(null);
    const lamports = all ? "all" : solToLamports(Number(withdrawSol));
    if (lamports !== "all" && !(lamports > 0)) return setNote({ tone: "down", text: "Enter an amount in SOL, or withdraw all" });
    setBusy("withdraw");
    try {
      const r = await agentApi<{ signature: string; lamports: number }>(`/api/agents/${agent.id}/withdraw`, {
        method: "POST",
        body: { lamports },
      });
      setWithdrawSol("");
      setNote({ tone: "up", text: `Withdrew ${fmtSol(lamportsToSol(r.lamports), 4)} to ${shortAddr(agent.owner)}`, signature: r.signature });
    } catch (e) {
      err(e);
    } finally {
      setBusy(null);
    }
  }

  async function closeAll() {
    setConfirmClose(false);
    setNote(null);
    setBusy("close");
    try {
      const r = await agentApi<{ orders: AgentOrderDTO[]; pending: boolean }>(`/api/agents/${agent.id}/close-all`, { method: "POST" });
      setNote({
        tone: "up",
        text: r.orders.length
          ? `${r.orders.length} sell order${r.orders.length > 1 ? "s" : ""} placed${r.pending ? "; some are still landing and will show on the tape" : ""}`
          : "No open positions to close",
      });
    } catch (e) {
      err(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="funds" className="card space-y-5 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="funds" className="text-sm font-semibold text-ink">
          Funds
        </h2>
        <span className="text-xs text-mute">{live ? "on-chain SOL" : "simulated SOL"}</span>
      </div>

      <div>
        <p className="eyebrow mb-1.5">Agent wallet · mainnet</p>
        <div className="flex items-center gap-2">
          <ExternalLink href={solscan("account", agent.walletPubkey)} className="num min-w-0 truncate text-sm text-ink">
            {shortAddr(agent.walletPubkey, 8)}
          </ExternalLink>
          <CopyButton text={agent.walletPubkey} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="eyebrow">{live ? "Free SOL" : "Free SOL (sim)"}</dt>
            <dd className="num mt-0.5 text-ink">{solOf(agent.balanceLamports, 4)}</dd>
          </div>
          <div>
            <dt className="eyebrow" title="Real SOL held by the agent wallet on mainnet">
              Wallet SOL
            </dt>
            <dd className="num mt-0.5 text-ink">{solOf(agent.walletLamports, 4)}</dd>
          </div>
        </dl>
      </div>

      {agent.isOwner && (
        <>
          <form onSubmit={deposit} className="space-y-2 border-t border-line pt-4">
            <label htmlFor="deposit-sol" className="eyebrow block">
              Deposit from your wallet
            </label>
            <div className="flex gap-2">
              <input
                id="deposit-sol"
                className="field num"
                inputMode="decimal"
                placeholder="SOL"
                value={depositSol}
                onChange={(e) => setDepositSol(e.target.value)}
                disabled={busy !== null}
              />
              <button type="submit" className="btn btn-ghost shrink-0" disabled={busy !== null || !depositSol}>
                {busy === "deposit" ? "Approve…" : "Deposit"}
              </button>
            </div>
            <p className="text-[11px] leading-snug text-mute">
              Mainnet SOL transfer to the agent wallet, cap {fmtSol(lamportsToSol(AGENT_LIMITS.maxDepositLamports))} per agent.
              {live ? "" : " Paper mode trades simulated SOL; deposits are only used once the agent is live."} Only deposit what
              you can afford to lose.
            </p>
          </form>

          <div className="space-y-2 border-t border-line pt-4">
            <label htmlFor="withdraw-sol" className="eyebrow block">
              Withdraw to {shortAddr(agent.owner)}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="withdraw-sol"
                className="field num min-w-0 flex-1"
                inputMode="decimal"
                placeholder="SOL"
                value={withdrawSol}
                onChange={(e) => setWithdrawSol(e.target.value)}
                disabled={busy !== null}
              />
              <button type="button" className="btn btn-ghost shrink-0" disabled={busy !== null || !withdrawSol} onClick={() => void withdraw(false)}>
                {busy === "withdraw" ? "Sending…" : "Withdraw"}
              </button>
              <button type="button" className="btn btn-ghost shrink-0" disabled={busy !== null} onClick={() => void withdraw(true)}>
                All
              </button>
            </div>
            <p className="text-[11px] leading-snug text-mute">
              Always available, whatever the agent&apos;s status. Withdrawing sends SOL only; open token positions stay — close them
              first to get them back as SOL.
            </p>
          </div>

          <div className="border-t border-line pt-4">
            <button
              type="button"
              className="btn btn-danger btn-sm w-full"
              disabled={busy !== null || agent.openPositions === 0}
              onClick={() => setConfirmClose(true)}
            >
              {busy === "close" ? "Closing…" : `Close all positions${agent.openPositions ? ` (${agent.openPositions})` : ""}`}
            </button>
          </div>

          {note && (
            <p role={note.tone === "down" ? "alert" : "status"} className={`break-words text-xs ${note.tone === "up" ? "text-up" : "text-down"}`}>
              {note.text}
              {note.signature && (
                <>
                  {" · "}
                  <ExternalLink href={solscan("tx", note.signature)} className="num">
                    {shortAddr(note.signature, 6)}
                  </ExternalLink>
                </>
              )}
            </p>
          )}

          {agent.ledger && agent.ledger.length > 0 && (
            <div className="border-t border-line pt-4">
              <p className="eyebrow mb-2">Ledger</p>
              <ul className="space-y-1.5 text-xs">
                {agent.ledger.slice(0, 8).map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2">
                    <span className="text-ink-2">
                      {l.kind === "paper_reset" ? "paper reset" : l.kind}
                      {l.flagged && <span className="ml-1.5 text-warn">{l.flagged}</span>}
                    </span>
                    <span className="num flex items-center gap-2 text-ink">
                      {l.signature ? (
                        <ExternalLink href={solscan("tx", l.signature)}>{fmtSignedSol(l.kind === "withdraw" ? -l.amountLamports : l.amountLamports, 4)}</ExternalLink>
                      ) : (
                        fmtSignedSol(l.kind === "withdraw" ? -l.amountLamports : l.amountLamports, 4)
                      )}
                      <span className="text-mute">{timeAgo(l.createdAt, now)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {confirmClose && (
        <Modal title="Close all positions?" onClose={() => setConfirmClose(false)}>
          <p className="text-sm text-ink-2">
            The agent will sell all {agent.openPositions} open position{agent.openPositions === 1 ? "" : "s"} at market
            {live ? " on-chain, with the strategy's slippage limit" : " (simulated)"}. Thin or rugged tokens may sell far below the
            shown price or not at all.
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmClose(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void closeAll()}>
              Sell everything
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
