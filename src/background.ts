// Service worker. Two jobs:
//  1. Open the wallet popup window deep-linked to a token (from the X pill).
//  2. Serve the X inline trading terminal: token info, wallet status, and
//     EXECUTING buys. Signing happens ONLY here (a trusted context that can
//     read the unlocked session key) — never in the x.com content script.

import { formatEther, getAddress } from "viem";
import { api } from "./lib/dex";
import { bestPair } from "./lib/dexcore";
import { gmgn, hasGmgnKey } from "./lib/gmgn";
import { getUnlockedPk, activeAccount } from "./lib/keystore";
import { nativeBalance, tokenBalance, signAndSend, waitReceipt } from "./lib/wallet";
import { addToken } from "./lib/tokens";
import { formatUnitsNum } from "./lib/format";

// Resolve a cashtag symbol -> the deepest-liquidity Robinhood Chain token with
// that exact symbol, via DexScreener search. Cached (incl. negative results).
const tickerCache = new Map<string, { t: number; v: string | null }>();
async function resolveTicker(symbol: string): Promise<string | null> {
  const sym = symbol.toUpperCase();
  const c = tickerCache.get(sym);
  if (c && Date.now() - c.t < 5 * 60_000) return c.v;
  let addr: string | null = null;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`);
    if (r.ok) {
      const pairs = ((await r.json())?.pairs || []).filter(
        (p: any) => p.chainId === "robinhood" && (p.baseToken?.symbol || "").toUpperCase() === sym,
      );
      pairs.sort((a: any, b: any) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
      addr = pairs[0]?.baseToken?.address || null;
    }
  } catch { /* offline */ }
  tickerCache.set(sym, { t: Date.now(), v: addr });
  return addr;
}

// OHLCV candles from GeckoTerminal (free public API; indexes Robinhood Chain,
// including V4 pools by pool id). `token=<ca>` orients candles to OUR token, so
// base/quote order in the pool doesn't matter. Cached 60s per pool+timeframe.
type Candle = [number, number, number, number, number, number]; // ts,o,h,l,c,v
const TF_MAP: Record<string, { path: string; agg: number; limit: number }> = {
  "15m": { path: "minute", agg: 15, limit: 96 },  // 24h
  "1H": { path: "hour", agg: 1, limit: 120 },     // 5d
  "4H": { path: "hour", agg: 4, limit: 120 },     // 20d
  "1D": { path: "day", agg: 1, limit: 120 },      // 4mo
};
const candleCache = new Map<string, { t: number; v: Candle[] | null }>();
async function fetchCandles(pool: string, ca: string, tf: string): Promise<Candle[] | null> {
  const cfg = TF_MAP[tf] || TF_MAP["1H"];
  const key = `${pool}:${tf}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.t < 60_000) return hit.v;
  let out: Candle[] | null = null;
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${encodeURIComponent(pool)}` +
      `/ohlcv/${cfg.path}?aggregate=${cfg.agg}&limit=${cfg.limit}&token=${encodeURIComponent(ca)}`;
    const r = await fetch(url);
    if (r.ok) {
      const list = (await r.json())?.data?.attributes?.ohlcv_list;
      if (Array.isArray(list) && list.length) {
        out = (list as Candle[]).slice().sort((a, b) => a[0] - b[0]); // oldest → newest
      }
    }
  } catch { /* offline */ }
  candleCache.set(key, { t: Date.now(), v: out });
  return out;
}

async function handle(msg: any): Promise<any> {
  switch (msg?.type) {
    case "STRIX_TICKER": {
      return { address: await resolveTicker(String(msg.symbol || "")) };
    }
    case "STRIX_OPEN_TRADE": {
      const url = chrome.runtime.getURL(`index.html?ca=${encodeURIComponent(msg.ca || "")}`);
      await chrome.windows.create({ url, type: "popup", width: 400, height: 640 });
      return { ok: true };
    }
    case "STRIX_OPEN": {
      await chrome.windows.create({ url: chrome.runtime.getURL("index.html"), type: "popup", width: 400, height: 640 });
      return { ok: true };
    }
    case "STRIX_TOKEN": {
      const info = await api.tokenInfo(msg.ca);
      return { info };
    }
    case "STRIX_PAIR": {
      // Resolve a token/stock to its deepest-liquidity DexScreener pair, for
      // the inline chart. Works for stocks too (their V4 pools are indexed).
      const pair = await bestPair(msg.ca);
      return { chain: "robinhood", pair: pair?.pairAddress || null };
    }
    case "STRIX_CANDLES": {
      return { candles: await fetchCandles(String(msg.pool), String(msg.ca), String(msg.tf || "1H")) };
    }
    case "STRIX_GMGN": {
      // GMGN data proxy for the X panel (content scripts can't fetch cross-origin).
      if (!(await hasGmgnKey())) return { noKey: true };
      try {
        if (msg.what === "security") return { data: await gmgn.security(msg.ca) };
        if (msg.what === "info") return { data: await gmgn.info(msg.ca) };
        if (msg.what === "holders") {
          const fn = msg.tab === "traders" ? gmgn.topTraders : gmgn.topHolders;
          return { data: await fn(msg.ca, msg.orderBy || "amount_percentage", msg.tag || undefined) };
        }
        return { error: "unknown gmgn call" };
      } catch (e: any) {
        return { error: (e?.message || String(e)).slice(0, 140) };
      }
    }
    case "STRIX_STATUS": {
      const pk = await getUnlockedPk();
      const acc = await activeAccount();
      if (!pk || !acc) return { unlocked: false };
      let eth = "0";
      try { eth = formatEther(await nativeBalance(acc.address)); } catch { /* rpc */ }
      return { unlocked: true, address: acc.address, label: acc.label, eth };
    }
    case "STRIX_HOLDING": {
      const acc = await activeAccount();
      if (!acc) return { amount: 0 };
      try {
        const info = await api.tokenInfo(msg.ca);
        const raw = await tokenBalance(getAddress(msg.ca), acc.address);
        return { amount: formatUnitsNum(raw, info.decimals), decimals: info.decimals, symbol: info.symbol };
      } catch { return { amount: 0 }; }
    }
    case "STRIX_IMAGE": {
      try {
        if (!msg.url) return { data: null };
        const r = await fetch(msg.url);
        if (!r.ok) return { data: null };
        const ct = r.headers.get("content-type") || "image/png";
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        return { data: `data:${ct};base64,${btoa(bin)}` };
      } catch { return { data: null }; }
    }
    case "STRIX_BUY": {
      const pk = await getUnlockedPk();
      const acc = await activeAccount();
      if (!pk || !acc) return { error: "locked" };
      const bundle = await api.buildBuy({ ca: msg.ca, amountEth: String(msg.amountEth), address: acc.address, slippage: msg.slippage ?? 10 });
      let hash: string | undefined;
      for (const tx of bundle.txs) {
        hash = await signAndSend(tx);
        await waitReceipt(hash as `0x${string}`);
      }
      try {
        const info = await api.tokenInfo(msg.ca);
        await addToken(msg.ca, "trade", { symbol: info.symbol, name: info.name, decimals: info.decimals });
      } catch { /* non-fatal */ }
      return { hash };
    }
    case "STRIX_SELL": {
      const pk = await getUnlockedPk();
      const acc = await activeAccount();
      if (!pk || !acc) return { error: "locked" };
      const bundle = await api.buildSell({ ca: msg.ca, pct: msg.pct, address: acc.address, slippage: msg.slippage ?? 10 });
      let hash: string | undefined;
      for (const tx of bundle.txs) {
        hash = await signAndSend(tx);
        await waitReceipt(hash as `0x${string}`);
      }
      return { hash };
    }
    default:
      return { error: "unknown" };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: (e?.shortMessage || e?.message || String(e)).slice(0, 160) }));
  return true; // keep the channel open for the async response
});
