# Chrome Web Store listing — HoodX Wallet

Everything you need to paste into the Developer Dashboard when submitting.

## Basics

- **Name:** HoodX Wallet
- **Category:** Productivity → Tools (or "Workflow & Planning"; crypto wallets commonly list under Tools)
- **Language:** English
- **Version:** 1.0.0 (from manifest)

## Short description (132 chars max)

> Non-custodial wallet for Robinhood Chain: trade tokens & tokenized stocks, safety checks, live charts. Keys stay on your device.

## Full description

> HoodX Wallet is a non-custodial crypto wallet built for Robinhood Chain (chain id 4663).
>
> WALLET
> • Create a new wallet or import a recovery phrase / private key
> • Keys are AES-256 encrypted with your password and never leave your device
> • Multiple accounts from one recovery phrase, auto-lock, QR receive
>
> TRADE
> • Paste any Robinhood Chain token address for price, liquidity, market cap and one-tap buy/sell
> • Auto-routing across Uniswap V4 → V3 → V2
> • Tokenized stocks via the USDG route
> • ETH ⇄ USDG stablecoin swaps
>
> INTEL
> • Token safety panel: taxes, contract verification, renounced ownership, liquidity lock, holder concentration, rug-risk score
> • Top-100 holders & traders with per-wallet profit/loss, KOL and smart-money tags
> • In-house candlestick charts (15m / 1H / 4H / 1D)
>
> X (TWITTER) TRADING TERMINAL
> • Detects token addresses and stock cashtags in tweets
> • Optional inline panel: live price, safety check, chart, holders, and one-tap trading without leaving your feed
>
> HoodX Wallet is independent, open-source software. It is NOT affiliated with,
> endorsed by, or connected to Robinhood Markets, Inc., X Corp., or GMGN.
> Cryptocurrency trading involves risk. You are solely responsible for your
> keys and funds.

## Privacy

- **Privacy policy URL:** host `PRIVACY.md` publicly (e.g. GitHub repo → raw/pages URL, or a gist) and paste the link.
- **Single purpose:** "A non-custodial cryptocurrency wallet for the Robinhood Chain network: hold, send, receive, and trade tokens, with market data and an optional trading panel on x.com."
- **Data usage disclosures:** select **"Does not collect user data"** — the extension has no backend and collects nothing (see PRIVACY.md).

## Permission justifications (paste into the form)

| Item | Justification |
|---|---|
| `storage` | Stores the user's encrypted wallet vault and preferences locally. Nothing is transmitted. |
| Content script on x.com / twitter.com | Scans visible tweet text locally for token contract addresses and stock cashtags, and offers an optional inline trading panel. No page data is collected or uploaded. |
| rpc.mainnet.chain.robinhood.com | Blockchain RPC: read balances and broadcast locally-signed transactions. |
| api.dexscreener.com | Read-only token prices and metadata. |
| dd.dexscreener.com / cdn.dexscreener.com / assets.parqet.com | Token and stock logo images. |
| api.geckoterminal.com | Read-only OHLCV candle data for price charts. |
| openapi.gmgn.ai | Read-only token safety audits and holder analytics. |
| `remotely hosted code` | **None** — all code ships in the package; the extension only fetches JSON data and images. |

## Assets you must prepare

- **Icon 128×128** — already in `public/icons/icon128.png`.
- **Screenshots (1280×800 or 640×400, 1–5 required)** — suggest: Home portfolio, Trade panel with safety card, Holders screen, X panel with chart open, Onboarding.
- **Optional promo tile 440×280.**

## Submission steps

1. Create a developer account at https://chrome.google.com/webstore/devconsole ($5 one-time fee).
2. `npm run build`, then upload `hoodx-wallet-1.0.0.zip` (the zipped **contents** of `dist/`).
3. Fill in the listing text above, privacy tab, and permission justifications.
4. Submit for review. Wallet/crypto extensions get manual review — typically a few days to two weeks.

## Review-risk notes (read before submitting)

- **Trademark risk (main one):** the name references "Hood" and the listing
  mentions Robinhood Chain and stock tickers. The description above includes an
  explicit non-affiliation disclaimer — keep it. If review still rejects for
  impersonation, renaming the extension (e.g. "Strix Wallet") while keeping
  "for Robinhood Chain" as a factual compatibility statement usually resolves it.
- **Crypto policy:** non-custodial wallets are allowed; custodial exchange
  functionality is restricted. Emphasize "non-custodial, keys never leave the
  device" if asked.
- The bundled GMGN API key is data-only (trading requires a private-key
  signature that is not shipped), but it is extractable from the bundle like
  any shipped key — monitor quota usage on gmgn.ai/ai and rotate if abused.
