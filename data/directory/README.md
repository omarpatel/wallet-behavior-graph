# Wallet directory sample

`sample-directory.json` is **synthetic**: 16 randomly generated Solana public keys (no known owner, no on-chain
history) with invented labels ("Wallet A" … "Wallet P") and made-up leaderboard stats. It exists so `pnpm seed` /
`pnpm import:directory` and the tests have something to load. It is read by `src/server/directory/snapshot.ts`.

To track real wallets, replace the file with your own list in the same shape:

```json
{
  "generatedAt": 1793318400,
  "wallets": [
    {
      "address": "<base58 pubkey>",
      "name": "label or null",
      "handle": "X handle or null",
      "avatarUrl": null,
      "url": null,
      "telegram": null,
      "followers": null,
      "rank": 1,
      "stats": { "pnl1dUsd": 0, "pnl7dUsd": 0, "pnl30dUsd": 0, "winRate7d": 0.5, "winRate30d": 0.5, "trades7d": 10, "trades30d": 40, "avgHoldSecs": 600, "lastActiveTs": 1793318400 },
      "tags": [],
      "kol": true,
      "study": null
    }
  ]
}
```

`kol: true` makes the wallet a brain; `false` only enriches an existing brain. `study` is an optional early-entry
record (`hitRate`, `earlyRunners`, `earlyMidfails`, `earlyFails`, `runnersAll`, `medianDelayMin`,
`medianEntryMcapUsd`, `notes`). Only list wallets whose labels you are allowed to publish.
