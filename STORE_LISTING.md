# Chrome Web Store listing — Impulse Wallet

Everything below is copy-paste ready for the dashboard. Fields are named as
they appear in the Store listing / Privacy / Package tabs.

## Package

- **Upload:** `impulse-extension.zip` (the zipped **contents** of `dist/`, not the folder)
- **Version:** 2.3.0
- **Name:** Impulse Wallet — read from the manifest, no need to type it

## Store listing tab

**Summary** (132 char limit)

> Trade any token from any page. Cross-chain wallet for Robinhood Chain, Ethereum, Base and Solana.

**Description**

> Impulse is a non-custodial crypto wallet with a trading terminal that works inside the page you are already reading, across four chains.
>
> Trading a token you spot online normally takes six steps: copy the address, work out which chain it is on, open the right DEX, paste it, check a scanner for taxes, open another for holders, then come back and swap. Impulse collapses all of that into the post itself.
>
> FOUR CHAINS, NO SWITCHING
> • Robinhood Chain, Ethereum, Base and Solana
> • Paste a contract or tap a cashtag and Impulse works out which chain it lives on, then routes, quotes and signs there. You never pick a network from a dropdown
> • The same ticker exists on several chains at once, so candidates are ranked by liquidity you could actually exit through, not by whoever filled in a profile
> • Every panel shows which network a trade will settle on before you sign
>
> WALLET
> • Create a new wallet, or import a recovery phrase, an EVM private key, or a Solana private key
> • Keys are encrypted on your device with AES-256 and never leave your browser
> • One recovery phrase gives you both an EVM address and a Solana address, derived at the standard path so it matches what Phantom or Solflare shows for the same phrase
> • Multiple accounts from one phrase
> • Auto-lock after a period of inactivity that you choose
> • Send, receive by QR code, and add any custom token
> • Tokens you buy are added to your wallet automatically, and removed once you sell out of them
>
> TRADE
> • Paste any token address on any supported chain to see price, market cap, liquidity, 24h volume and a one-tap buy or sell
> • Uniswap V4, V3 and V2 on the EVM chains, chosen per trade by where the liquidity actually is, with approvals, wrapping and slippage handled for you
> • Jupiter and PumpPortal on Solana, so both graduated tokens and bonding-curve launches are tradable
> • Gas is estimated per transaction rather than fixed, so a buy reserves what the swap needs and not more
> • Tokenized stocks on Robinhood Chain, traded through the USDG route and settled in ETH
> • Swap ETH to USDG and back
>
> RESEARCH BEFORE YOU BUY
> • Candlestick charts drawn inside the extension on all four chains, with 15m, 1H, 4H and 1D timeframes
> • Safety panel: buy and sell taxes, contract verification, renounced ownership, liquidity locks, top-holder concentration and a rug-risk score, combined into a single verdict
> • Top 100 holders and traders with per-wallet profit and loss, plus tags for influencer wallets, smart money, developers and insiders
> • Holder bubble map to spot clustered wallets and coordinated launches
> • Safety checks, holder data and the bubble map are Robinhood Chain features. On other chains those panels are hidden rather than filled with data from the wrong network
>
> ON X, AND ANYWHERE ELSE
> • Detects contract addresses, Solana mints and cashtags as you scroll
> • Adds a small pill under the post that opens a full trading panel: live price, safety verdict, chart, holders and buy or sell controls
> • Built for X, and switchable on for any other site you choose, one origin at a time and only when you ask
> • Trades started from a post are signed inside the extension. The web page never sees a private key
>
> PRIVACY AND SECURITY
> Impulse has no backend, no account system, no analytics and no telemetry. Your recovery phrase and private keys are encrypted locally with a key derived from your password, and the unlocked key exists only in session memory until the browser closes or auto-lock fires. Market data is read from public APIs. We never receive your keys and cannot move your funds.
>
> Impulse is independent software. It is not affiliated with, endorsed by, or connected to Robinhood Markets, Inc., Coinbase, Solana Labs, Jupiter, Uniswap or X Corp. Robinhood Chain is network 4663. Trading digital assets carries substantial risk, including total loss of funds. You alone hold your keys and are responsible for safeguarding your recovery phrase. Nothing here is financial advice.

**Category:** Productivity
**Language:** English

## Privacy tab

**Single purpose**

> A non-custodial crypto wallet that lets the user view token data and trade
> directly from the page they are reading, across Robinhood Chain, Ethereum,
> Base and Solana.

**Permission justifications** — one per permission, all required:

- **storage** — stores the encrypted wallet, the user's token list, chain
  selection and settings on the device. Nothing is sent anywhere.
- **scripting** — injects the trading panel into a site *after* the user
  explicitly enables it for that origin.
- **activeTab** — reads the current tab's origin so the user can switch the
  panel on for the site they are looking at.
- **declarativeNetRequestWithHostAccess** — strips frame-blocking headers on
  the holder bubble map so it can render inside the panel. Static rule, one
  host.
- **Host permissions** — each is an API the extension reads from directly:
  chain RPCs for balances and transactions (Robinhood, Ethereum, Base, three
  Solana endpoints for redundancy), DexScreener for prices and token
  metadata, GeckoTerminal for chart candles, GMGN for safety checks and
  holder data, PumpPortal and Jupiter for Solana routing, Parquet for stock
  ticker logos, Bubblemaps for the holder map.
- **optional_host_permissions (https://\*/\*)** — requested at runtime, one
  origin at a time, only when the user turns the panel on for a site. Not
  granted at install.

**Data usage:** select **"Does not collect user data"**, and tick the three
certification checkboxes. The extension has no backend and no analytics; see
PRIVACY.md and the policy at https://www.hoodx.online/privacy

**Privacy policy URL:** https://www.hoodx.online/privacy

## Submission

1. Wait for any in-review version to clear. A new package cannot be uploaded
   while one is pending.
2. Upload the zip, paste the listing and privacy fields, replace the
   screenshots and promo art.
3. Tick **"Publish automatically after it has passed review"**.
4. Do NOT tick the declarativeNetRequest skip-review box. It is an attestation
   that the only change is to a static rules file, which is false here.

## Review-risk notes

- **Permission count.** 16 host permissions is a lot to look at. Every one is
  justified above and the three explorer domains were removed once it was
  clear they are only ever opened in a tab, never fetched.
- **New permissions since 1.1.0** mean existing users get a re-consent prompt
  on update, and the review is heavier than a copy-only change.
- **Trademark.** "Impulse" borrows nothing. The listing names Robinhood Chain,
  Solana, Jupiter and Uniswap as factual compatibility statements — keep the
  non-affiliation disclaimer in the description so they read that way.
- **Crypto policy.** Non-custodial wallets are allowed; custodial exchange
  functionality is not. Emphasise "keys never leave the device" if asked.
