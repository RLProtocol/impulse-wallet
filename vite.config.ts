import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx, defineManifest } from "@crxjs/vite-plugin";

const manifest = defineManifest({
  manifest_version: 3,
  name: "Impulse Wallet",
  version: "2.6.0",
  description: "Non-custodial wallet for Robinhood Chain: hold ETH, trade tokens & tokenized stocks, with safety checks and live charts.",
  action: { default_popup: "index.html", default_title: "Impulse Wallet" },
  background: { service_worker: "src/background.ts", type: "module" },
  icons: { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  // Keep permissions minimal for store review: storage only (windows/runtime
  // need no permission; blockscout is link-out only).
  //
  // `scripting` is here so the terminal can be switched on for a site the user
  // chooses. It is paired with optional_host_permissions rather than a blanket
  // match: a wallet that asks to read every site on install is both a worse
  // install prompt and a much harder review.
  permissions: ["storage", "declarativeNetRequestWithHostAccess", "scripting", "activeTab"],
  // Requested at runtime, one origin at a time, only when the user asks.
  optional_host_permissions: ["https://*/*", "http://*/*"],
  declarative_net_request: {
    rule_resources: [{ id: "bubblemaps_frame", enabled: true, path: "rules/bubblemaps.json" }],
  },
  host_permissions: [
    "https://rpc.mainnet.chain.robinhood.com/*", // chain RPC (balances, txs)
    "https://eth.drpc.org/*", // Ethereum RPC
    "https://solana-rpc.publicnode.com/*", // Solana RPC (allows extension origins)
    "https://solana.leorpc.com/*", // Solana RPC fallback
    "https://api.mainnet-beta.solana.com/*", // Solana RPC last resort
    "https://pumpportal.fun/*", // Solana trades (bonding-curve tokens)
    "https://lite-api.jup.ag/*", // Solana trades (Jupiter aggregator)
    "https://mainnet.base.org/*", // Base RPC
    "https://api.dexscreener.com/*", // token metadata + prices
    "https://dd.dexscreener.com/*", // token logos (fetched by background)
    "https://cdn.dexscreener.com/*", // token logos
    "https://assets.parqet.com/*", // stock ticker logos
    "https://api.geckoterminal.com/*", // OHLCV candles for charts
    "https://openapi.gmgn.ai/*", // token safety / holder analytics
    "https://api.fomoscan.sh/*", // trader identity, theses and PnL (metered key)
    "https://backend.getimpulse.online/*", // our FOMO backend: theses + KOL profiles for every user
    "https://copyd-production.up.railway.app/*", // copyd: FOMO copytrade jobs
    "https://prod-fomo-profile-pics.s3.amazonaws.com/*", // thesis author avatars
    "https://frontend-api-v3.pump.fun/*", // pump.fun callouts
    "https://pump.mypinata.cloud/*", // callout author avatars (IPFS gateway)
    "https://socialimages.pump.fun/*", // callout author avatars (the other host they use)
    "https://v2.bubblemaps.io/*", // holder bubble map (framed)
    "https://app.bubblemaps.io/*",
  ],
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'self'; frame-src https://dexscreener.com https://*.dexscreener.com https://*.bubblemaps.io;",
  },
  content_scripts: [
    {
      matches: ["https://x.com/*", "https://twitter.com/*"],
      js: ["src/content/x-inject.tsx"],
      run_at: "document_idle",
    },
  ],
  // The panel loads its own icons and frames bubble.html, so those have to be
  // reachable from whichever page it was switched on for, not just X. Sites are
  // enabled at runtime, so the match list cannot be enumerated at build time.
  //
  // use_dynamic_url is what makes that safe. Without it, any page on the web can
  // request chrome-extension://<our fixed id>/icons/icon48.png and learn the
  // extension is installed, which fingerprints every user of a *wallet*. With
  // it, Chrome serves these from a per-session random UUID instead, so a probe
  // for the static ID gets nothing. chrome.runtime.getURL() keeps working from
  // our own contexts, which is the only place we build these URLs.
  //
  // http is dropped: there is no reason to hand these out over plaintext, where
  // a network attacker could see or tamper with them.
  web_accessible_resources: [
    { resources: ["icons/*", "fonts/*", "bubble.html"], matches: ["https://*/*"], use_dynamic_url: true },
  ],
});

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { index: "index.html", bubble: "bubble.html" },
      // @crxjs names chunks after their source file, which produces
      // "background.ts-HASH.js" and "x-inject.tsx-HASH.js". A source
      // extension sitting mid-filename trips AMO's archive validation
      // ("Invalid file name in archive"), so strip it from the emitted names.
      output: {
        entryFileNames: (chunk) =>
          `assets/${chunk.name.replace(/\.(tsx?|jsx?)$/i, "")}-[hash].js`,
        chunkFileNames: (chunk) =>
          `assets/${chunk.name.replace(/\.(tsx?|jsx?)$/i, "")}-[hash].js`,
      },
    },
  },
});
