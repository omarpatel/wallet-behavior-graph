import { randomBytes } from "node:crypto";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createAgentWallet, openSecret, parseMasterKey, sealSecret, VaultError, withAgentSigner } from "./vault";

const key = randomBytes(32);
process.env.AGENT_MASTER_KEY = key.toString("base64");

describe("vault", () => {
  it("round-trips a keypair secret", () => {
    const kp = Keypair.generate();
    const sealed = sealSecret(kp.secretKey, "agent-1", key);
    expect(sealed).not.toContain(Buffer.from(kp.secretKey).toString("base64"));
    expect(Keypair.fromSecretKey(openSecret(sealed, "agent-1", key)).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("uses a fresh IV every time", () => {
    const kp = Keypair.generate();
    expect(sealSecret(kp.secretKey, "a", key)).not.toBe(sealSecret(kp.secretKey, "a", key));
  });

  it("detects tampering, a wrong key and a wrong agent id", () => {
    const { encSecret } = createAgentWallet("agent-1", key);
    const buf = Buffer.from(encSecret, "base64");
    for (const i of [0, 13, 40, buf.length - 1]) {
      const t = Buffer.from(buf);
      t[i] ^= 0x01;
      expect(() => openSecret(t.toString("base64"), "agent-1", key)).toThrow(VaultError);
    }
    expect(() => openSecret(encSecret, "agent-1", randomBytes(32))).toThrow(VaultError);
    expect(() => openSecret(encSecret, "agent-2", key)).toThrow(VaultError);
    expect(() => openSecret(encSecret.slice(0, -4), "agent-1", key)).toThrow(VaultError);
  });

  it("createAgentWallet returns only the pubkey and the sealed secret", () => {
    const w = createAgentWallet("agent-9", key);
    expect(Object.keys(w).sort()).toEqual(["encSecret", "pubkey"]);
    expect(Keypair.fromSecretKey(openSecret(w.encSecret, "agent-9", key)).publicKey.toBase58()).toBe(w.pubkey);
  });

  it("parses hex and base64 master keys and rejects wrong lengths", () => {
    expect(parseMasterKey(key.toString("hex")).equals(key)).toBe(true);
    expect(parseMasterKey(key.toString("base64")).equals(key)).toBe(true);
    expect(parseMasterKey(key.toString("base64url")).equals(key)).toBe(true);
    expect(() => parseMasterKey(randomBytes(16).toString("hex"))).toThrow(VaultError);
  });

  it("withAgentSigner produces valid signatures (the secret is zeroed only afterwards)", async () => {
    const w = createAgentWallet("agent-s");
    const tx = new Transaction({ feePayer: Keypair.generate().publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    const from = await withAgentSigner({ id: "agent-s", encSecret: w.encSecret, walletPubkey: w.pubkey }, async (signer) => {
      tx.feePayer = signer.publicKey;
      tx.add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
      tx.sign(signer);
      return signer;
    });
    expect(tx.verifySignatures()).toBe(true);
    expect(from.secretKey.every((b) => b === 0)).toBe(true);
    await expect(withAgentSigner({ id: "agent-x", encSecret: w.encSecret, walletPubkey: w.pubkey }, async () => 1)).rejects.toThrow(VaultError);
  });
});
