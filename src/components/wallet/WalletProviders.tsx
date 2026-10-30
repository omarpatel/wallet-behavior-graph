"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { clusterApiUrl } from "@solana/web3.js";
import type { ReactNode } from "react";
import { SessionProvider } from "./session";

const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet";
const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl(cluster);

/** Wallet Standard wallets (Phantom, Solflare, Backpack…) are auto-detected, hence `wallets={[]}`. */
export function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <SessionProvider>{children}</SessionProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
