# Impulse Wallet

An Impulse-branded Web3 wallet for **Robinhood Chain (4663)**, shipped as a Chrome
(Manifest V3) extension. Create/import a wallet, hold ETH + tokens + tokenized
stocks, trade any Robinhood-Chain token by pasting its address, and buy/sell
stocks (AAPL, TSLA, NVDA, …) — all non-custodial, keys encrypted on-device.

The complex swap logic is reused verbatim from the Impulse bot's
`robinhoodcode.py` (Uniswap V4/V3/V2 + the USDG stock route). A small Python API
**builds** the unsigned transactions; the extension **signs** them locally.

```
strix-wallet/
├── src/            # the extension (React + Vite + viem)
├── server/         # the trade API (FastAPI, wraps robinhoodcode.py)
└── dist/           # built extension (load this in Chrome)
```

## Live API

A hosted instance is already deployed on Railway and baked in as the wallet's
default:

```
https://strix-wallet-api-production.up.railway.app
```

The extension works against it out of the box — you only need the steps below if
you want to run/deploy your own.

## 1. Run the trade API

The wallet needs the API for prices + to build swap transactions (it never sees
your keys).

```bash
cd server
python -m venv .venv && source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
uvicorn app:app --port 8787 --reload
```

Verify: `curl http://localhost:8787/health` → `{"ok":true,"chain":4663}`

### Deploy it (Railway)

```bash
cd server
railway init            # new project/service
railway up              # deploys; Procfile runs uvicorn on $PORT
```

Copy the public URL (e.g. `https://strix-wallet-api.up.railway.app`). CORS is
open (`*`), so the extension can call it from any origin.

> `server/robinhoodcode.py` is a vendored copy of the bot's trading module. If
> you change the bot's routing/addresses, re-copy it here.

## 2. Build + load the extension

```bash
npm install
npm run build          # outputs dist/
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select the `dist/` folder
4. Pin the Impulse icon and open it

On first run: **Create** or **Import** a wallet (12-word phrase or private key),
set a password (encrypts the key locally with AES-GCM).

## 3. Point the wallet at your API

Open the extension → **Settings → Impulse Trade API** → paste your API URL (or keep
`http://localhost:8787` for local dev) → **Save**.

You can also bake a default in at build time:

```bash
VITE_STRIX_API=https://your-api.up.railway.app npm run build
```

## Features

- **Wallet** — create / import (seed or private key), send, receive (QR), add
  custom tokens. Keys are AES-GCM encrypted with your password; the unlocked key
  lives only in `chrome.storage.session` (memory).
- **Portfolio** — ETH + tracked tokens + held stocks, with live USD values.
- **Trade** — paste any Robinhood-Chain token address → price/liquidity/chart +
  one-tap buy (auto-routes V4 → V3 → V2). Bought tokens are added to your wallet.
- **Stocks** — AAPL, TSLA, NVDA, MSFT, GOOGL, AMZN, META, SPY. Buy/sell via the
  ETH → USDG → stock V4 route; send shares like any token.
- **X (Twitter)** — the content script detects contract addresses in tweets and
  adds a lime **Buy on Impulse** pill that opens the wallet's Trade view.

## Security notes

- Non-custodial: the private key never leaves the device and is never sent to the
  API. The API only receives your **public address** (to fetch nonce/balances)
  and returns unsigned transactions.
- Recovery phrase / private key can be revealed in Settings only after re-entering
  the password.
- This is a self-hosted / unpacked build. Publishing to the Chrome Web Store
  requires their review + a developer account.
