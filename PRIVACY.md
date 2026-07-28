# HoodX Wallet — Privacy Policy

_Last updated: July 26, 2026_

HoodX Wallet is a non-custodial cryptocurrency wallet browser extension for
Robinhood Chain. This policy explains what data the extension handles and
where it goes.

## What we collect

**Nothing.** HoodX Wallet has no backend server, no analytics, no telemetry,
and no user accounts. We (the developers) never receive, see, or store any of
your data.

## What stays on your device

- **Private keys and recovery phrases** — encrypted with your password
  (AES-256-GCM, PBKDF2) and stored only in your browser's local extension
  storage. They never leave your device. While unlocked, decrypted keys are
  held only in session memory and are wiped when the browser closes or the
  wallet auto-locks.
- **Settings** (tracked tokens, auto-lock preference, optional API key
  override) — stored in local extension storage.

## What is sent to third-party services

To function, the extension makes read-only requests to public APIs. These
requests include only what is technically necessary (your **public** wallet
address, token contract addresses, standard IP/network metadata):

| Service | Purpose |
|---|---|
| rpc.mainnet.chain.robinhood.com | Read balances, broadcast transactions you sign locally |
| api.dexscreener.com | Token prices and metadata |
| dd/cdn.dexscreener.com, assets.parqet.com | Token / stock logos |
| api.geckoterminal.com | Price-chart candle data |
| openapi.gmgn.ai | Token safety checks and holder analytics |

Transactions are **signed locally** on your device; only the signed
transaction is broadcast to the chain RPC. No private key material is ever
transmitted anywhere.

## X.com content script

On x.com / twitter.com the extension scans visible tweet text locally to
detect token contract addresses and stock cashtags, and renders an optional
trading panel. Tweet content is processed entirely on your device and is never
uploaded. The panel only contacts the APIs listed above.

## Data sharing & selling

We do not collect data, therefore we do not share or sell any.

## Contact

Questions: hoodxrh@gmail.com
