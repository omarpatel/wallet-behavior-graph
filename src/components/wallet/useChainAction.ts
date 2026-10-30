"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { useCallback, useState } from "react";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { apiErrorMessage } from "./http";
import { useSession } from "./session";

export type ChainActionStatus = "idle" | "building" | "signing" | "submitting" | "done" | "error";
export interface ChainActionResult {
  signature: string;
  kind: string;
  asset?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  // Our own API's documented response shape.
  const data: T = await res.json();
  return data;
}

/**
 * Wallet-first chain action: POST build endpoint → base64 tx → wallet `signTransaction` →
 * POST /api/actions/submit (server validates intent, co-signs, sends, confirms).
 * `run` rejects with an Error on failure (also reflected in `status`/`error`).
 */
export function useChainAction() {
  const { publicKey, signTransaction } = useWallet();
  const { session } = useSession();
  const [status, setStatus] = useState<ChainActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (endpoint: string, body: unknown): Promise<ChainActionResult> => {
      setError(null);
      try {
        if (!session) throw new Error("Connect and sign in with your wallet first");
        if (!publicKey || !signTransaction) throw new Error("Connect a wallet that can sign transactions");
        if (publicKey.toBase58() !== session.wallet) {
          throw new Error("The connected wallet differs from the signed-in wallet; sign in again");
        }
        setStatus("building");
        const built = await postJson<{ actionId: string | null; transaction: string | null; kind: string; asset?: string }>(
          endpoint,
          body,
        );
        if (!built.actionId || !built.transaction) {
          // Resolved server-side without a transaction (e.g. a stale listing was just cancelled).
          setStatus("done");
          return { signature: "", kind: built.kind, asset: built.asset };
        }
        setStatus("signing");
        const signed = await signTransaction(VersionedTransaction.deserialize(base64ToBytes(built.transaction)));
        setStatus("submitting");
        const result = await postJson<ChainActionResult>("/api/actions/submit", {
          actionId: built.actionId,
          signedTransaction: bytesToBase64(signed.serialize()),
        });
        setStatus("done");
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        setStatus("error");
        throw new Error(message);
      }
    },
    [publicKey, signTransaction, session],
  );

  return { run, status, error };
}
