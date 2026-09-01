import { getItem, setItem } from "./storage";
import type { UnsignedTx } from "./wallet";

// The Impulse trade API wraps robinhoodcode.py: it builds unsigned transactions
// and serves quotes/prices/token-info. The wallet signs locally and broadcasts.
const API_KEY = "strix.apiBase";
const DEFAULT_API =
  import.meta.env.VITE_STRIX_API ||
  "https://strix-wallet-api-production.up.railway.app";

export async function getApiBase(): Promise<string> {
  return (await getItem<string>(API_KEY)) || DEFAULT_API;
}
export async function setApiBase(url: string): Promise<void> {
  await setItem(API_KEY, url.replace(/\/+$/, ""));
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await getApiBase();
  const res = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!res.ok) throw new Error(body?.error || body?.detail || `API ${res.status}`);
  return body as T;
}

export type TokenInfo = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  priceNative: number | null;
  mcap: number | null;
  liquidityUsd: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  venue: "v4" | "v3" | "v2" | "unknown";
  pairUrl: string | null;
  isStock: boolean;
  logo?: string | null;
};

/** `chain` is which network the txs must be signed on — the wallet client is
 *  per-chain, so a bundle built for Base cannot be sent on Robinhood. */
export type TxBundle = { txs: UnsignedTx[]; expectedOut?: string; decimals?: number; note?: string; venue?: string; chain?: string };

export const api = {
  health: () => req<{ ok: boolean; chain: number }>("/health"),

  nativePrice: () => req<{ usd: number }>("/native-price"),

  tokenInfo: (ca: string) =>
    req<TokenInfo>(`/token?ca=${encodeURIComponent(ca)}`),

  stocks: () =>
    req<{ stocks: { symbol: string; name: string; address: string; priceUsd: number | null }[] }>("/stocks"),

  quoteBuy: (ca: string, amountEth: string) =>
    req<{ expectedOut: string; decimals: number; venue: string }>("/quote/buy", {
      method: "POST",
      body: JSON.stringify({ ca, amountEth }),
    }),

  buildBuy: (p: { ca: string; amountEth: string; address: string; slippage?: number }) =>
    req<TxBundle>("/tx/buy", { method: "POST", body: JSON.stringify(p) }),

  buildSell: (p: { ca: string; pct: number; address: string; slippage?: number }) =>
    req<TxBundle>("/tx/sell", { method: "POST", body: JSON.stringify(p) }),

  buildStockBuy: (p: { stock: string; amountEth: string; address: string; slippage?: number }) =>
    req<TxBundle>("/tx/stock/buy", { method: "POST", body: JSON.stringify(p) }),

  buildStockSell: (p: { stock: string; pct: number; address: string; slippage?: number }) =>
    req<TxBundle>("/tx/stock/sell", { method: "POST", body: JSON.stringify(p) }),
};
