import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx, defineManifest } from "@crxjs/vite-plugin";

const manifest = defineManifest({
  manifest_version: 3,
  name: "HoodX Wallet",
  version: "1.0.0",
  description: "Non-custodial wallet for Robinhood Chain: hold ETH, trade tokens & tokenized stocks, with safety checks and live charts.",
  action: { default_popup: "index.html", default_title: "HoodX Wallet" },
  background: { service_worker: "src/background.ts", type: "module" },
  icons: { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  // Keep permissions minimal for store review: storage only (windows/runtime
  // need no permission; blockscout is link-out only).
  permissions: ["storage", "declarativeNetRequestWithHostAccess"],
  declarative_net_request: {
    rule_resources: [{ id: "bubblemaps_frame", enabled: true, path: "rules/bubblemaps.json" }],
  },
  host_permissions: [
    "https://rpc.mainnet.chain.robinhood.com/*", // chain RPC (balances, txs)
    "https://api.dexscreener.com/*", // token metadata + prices
    "https://dd.dexscreener.com/*", // token logos (fetched by background)
    "https://cdn.dexscreener.com/*", // token logos
    "https://assets.parqet.com/*", // stock ticker logos
    "https://api.geckoterminal.com/*", // OHLCV candles for charts
    "https://openapi.gmgn.ai/*", // token safety / holder analytics
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
  web_accessible_resources: [
    { resources: ["icons/*", "bubble.html"], matches: ["https://x.com/*", "https://twitter.com/*"] },
  ],
});

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { index: "index.html", bubble: "bubble.html" } },
  },
});
